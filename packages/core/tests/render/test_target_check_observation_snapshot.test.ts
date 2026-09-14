import { createHash } from "node:crypto";
import { SafeFilesystemError } from "@oaam/shared/filesystem";
import { describe, expect, it, vi } from "vitest";
import {
    resolveObservedNativeProjectGuidanceTargetContextForTest,
    resolveObservedNativeProjectTargetContextForTest,
} from "../../src/render/native-project-guidance";
import {
    operationLocalBuildArtifactObserverAsync,
    primeOperationLocalBuildArtifactObservations,
    retainCurrentTargetBuildObservations,
} from "../../src/render/native-project-target-build-observation";
import {
    createTargetCheckObservationSnapshot,
    observeStableBuildArtifactForTargetCheck,
    observeStableBuildArtifactForTargetCheckAsync,
    observeStableTargetFileForTargetCheckAsync,
    prewarmedTargetCheckBuildObservation,
    primeTargetCheckBuildObservations,
    TargetCheckObservationScopes,
} from "../../src/render/native-project-target-observation-snapshot";
import { BUILD_BYTES, makeFixture } from "./fixtures/observed-native-project-guidance-test-fixtures";

describe("operation-local target-check build observations", () => {
    it("reuses one exact physical build observation only inside its target-check snapshot", () => {
        const fixture = makeFixture();
        const snapshot = createTargetCheckObservationSnapshot();
        let reads = 0;
        fixture.dependencies.readBuildArtifact = () => {
            reads += 1;
            return stableRead(BUILD_BYTES);
        };

        expect(
            resolveObservedNativeProjectGuidanceTargetContextForTest(fixture.input, fixture.dependencies, snapshot).status,
        ).toBe("complete");
        expect(
            resolveObservedNativeProjectGuidanceTargetContextForTest(fixture.input, fixture.dependencies, snapshot).status,
        ).toBe("complete");
        expect(reads).toBe(1);

        expect(
            resolveObservedNativeProjectGuidanceTargetContextForTest(
                fixture.input,
                fixture.dependencies,
                createTargetCheckObservationSnapshot(),
            ).status,
        ).toBe("complete");
        expect(
            resolveObservedNativeProjectTargetContextForTest(
                fixture.input,
                fixture.dependencies,
                createTargetCheckObservationSnapshot(),
            ).status,
        ).toBe("complete");
        expect(reads).toBe(3);
    });

    it("rejects an operation snapshot that was not created by the target-check owner", () => {
        const fixture = makeFixture();
        expect(
            resolveObservedNativeProjectGuidanceTargetContextForTest(
                fixture.input,
                fixture.dependencies,
                Object.freeze({ snapshotKind: "target_check_observation" }) as never,
            ),
        ).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "native_guidance_build_recheck_failed" }],
        });
    });

    it("retains an exact build failure locally without poisoning a sibling target identity", () => {
        const failed = makeFixture();
        const sibling = makeFixture();
        const snapshot = createTargetCheckObservationSnapshot();
        let reads = 0;
        failed.dependencies.readBuildArtifact = () => {
            reads += 1;
            throw new SafeFilesystemError({
                failureKind: "stale",
                operation: "read_regular_file",
                targetPath: "private-build-path",
                systemCode: "ESTALE",
                message: "fixture drift",
            });
        };
        sibling.dependencies.readBuildArtifact = () => {
            reads += 1;
            return stableRead(BUILD_BYTES);
        };
        const siblingEvidence = sibling.input.probeResult.observation.observedAgentRuntimes[0]?.installationEvidence[0];
        if (siblingEvidence === undefined) throw new Error("sibling build evidence is missing");
        siblingEvidence.path = "/fixture/bin/consumer-sibling";

        for (let attempt = 0; attempt < 2; attempt += 1) {
            expect(
                resolveObservedNativeProjectGuidanceTargetContextForTest(failed.input, failed.dependencies, snapshot),
            ).toMatchObject({
                status: "failed",
                diagnostics: [{ code: "native_guidance_build_recheck_failed" }],
            });
        }
        expect(
            resolveObservedNativeProjectGuidanceTargetContextForTest(sibling.input, sibling.dependencies, snapshot).status,
        ).toBe("complete");
        expect(reads).toBe(2);
    });

    it("coalesces one in-flight async build observation and retains its terminal value", async () => {
        const snapshot = createTargetCheckObservationSnapshot();
        let release!: (value: ReturnType<typeof stableRead>) => void;
        const sample = new Promise<ReturnType<typeof stableRead>>((resolve) => {
            release = resolve;
        });
        let reads = 0;
        const read = () => {
            reads += 1;
            return sample;
        };
        const identity = { provider: "fixture", runtime: "CLI", path: "/fixture/bin/consumer" };

        const first = observeStableBuildArtifactForTargetCheckAsync(identity, snapshot, read);
        const second = observeStableBuildArtifactForTargetCheckAsync(identity, snapshot, read);
        await Promise.resolve();
        expect(reads).toBe(1);
        expect(() => observeStableBuildArtifactForTargetCheck(identity, snapshot, () => stableRead(BUILD_BYTES))).toThrow(
            "target-check build observation is still pending",
        );
        release(stableRead(BUILD_BYTES));
        await expect(Promise.all([first, second])).resolves.toEqual([
            expect.objectContaining({ executable: true }),
            expect.objectContaining({ executable: true }),
        ]);
        await expect(observeStableBuildArtifactForTargetCheckAsync(identity, snapshot, read)).resolves.toMatchObject({
            executable: true,
        });
        expect(reads).toBe(1);
    });

    it("retains an async failure without leaking it into a sibling identity", async () => {
        const snapshot = createTargetCheckObservationSnapshot();
        const failure = new Error("bounded fixture failure");
        const failedIdentity = { provider: "fixture", runtime: "CLI", path: "/fixture/bin/failed" };
        const siblingIdentity = { provider: "fixture", runtime: "CLI", path: "/fixture/bin/sibling" };
        let failedReads = 0;

        for (let attempt = 0; attempt < 2; attempt += 1) {
            await expect(
                observeStableBuildArtifactForTargetCheckAsync(failedIdentity, snapshot, async () => {
                    failedReads += 1;
                    throw failure;
                }),
            ).rejects.toBe(failure);
        }
        await expect(
            observeStableBuildArtifactForTargetCheckAsync(siblingIdentity, snapshot, async () => stableRead(BUILD_BYTES)),
        ).resolves.toMatchObject({ executable: true });
        expect(failedReads).toBe(1);
    });

    it("coalesces exact target-file reads and isolates failures by physical request", async () => {
        const snapshot = createTargetCheckObservationSnapshot();
        let release!: (value: ReturnType<typeof stableRead>) => void;
        const pending = new Promise<ReturnType<typeof stableRead>>((resolve) => {
            release = resolve;
        });
        const read = vi.fn(() => pending);
        const identity = { platform: "wsl", platformInstanceId: "Ubuntu", filePath: "/project/AGENTS.md" };
        const first = observeStableTargetFileForTargetCheckAsync(identity, snapshot, read);
        const second = observeStableTargetFileForTargetCheckAsync(identity, snapshot, read);
        await Promise.resolve();
        expect(read).toHaveBeenCalledTimes(1);
        release(stableRead(BUILD_BYTES));
        const [firstResult, secondResult] = await Promise.all([first, second]);
        firstResult.bytes[0] = 0;
        expect(secondResult.bytes).toEqual(BUILD_BYTES);
        await expect(observeStableTargetFileForTargetCheckAsync(identity, snapshot, read)).resolves.toMatchObject({
            bytes: BUILD_BYTES,
        });
        expect(read).toHaveBeenCalledTimes(1);
        await expect(
            observeStableTargetFileForTargetCheckAsync(identity, createTargetCheckObservationSnapshot(), read),
        ).resolves.toMatchObject({ bytes: BUILD_BYTES });
        expect(read).toHaveBeenCalledTimes(2);

        const failure = new SafeFilesystemError({
            failureKind: "not_found",
            operation: "read_regular_file",
            targetPath: "/project/missing.md",
            systemCode: "ENOENT",
            message: "fixture missing target",
        });
        const failedRead = vi.fn(async () => {
            throw failure;
        });
        const missingIdentity = { ...identity, filePath: "/project/missing.md" };
        await expect(
            Promise.all([
                observeStableTargetFileForTargetCheckAsync(missingIdentity, snapshot, failedRead),
                observeStableTargetFileForTargetCheckAsync(missingIdentity, snapshot, failedRead),
            ]),
        ).rejects.toBe(failure);
        await expect(observeStableTargetFileForTargetCheckAsync(missingIdentity, snapshot, failedRead)).rejects.toBe(failure);
        expect(failedRead).toHaveBeenCalledTimes(1);
    });

    it("rejects an async observation snapshot that was not created by the target-check owner", async () => {
        await expect(
            observeStableBuildArtifactForTargetCheckAsync(
                { provider: "fixture", runtime: "CLI", path: "/fixture/bin/consumer" },
                Object.freeze({ snapshotKind: "target_check_observation" }) as never,
                async () => stableRead(BUILD_BYTES),
            ),
        ).rejects.toThrow("target-check observation snapshot owner is invalid");
        await expect(
            observeStableTargetFileForTargetCheckAsync(
                { platform: "wsl", platformInstanceId: "Ubuntu", filePath: "/project/AGENTS.md" },
                Object.freeze({ snapshotKind: "target_check_observation" }) as never,
                async () => stableRead(BUILD_BYTES),
            ),
        ).rejects.toThrow("target-check observation snapshot owner is invalid");
    });

    it("retains one exact pre-hashed build wave and localizes an item failure", async () => {
        const snapshot = createTargetCheckObservationSnapshot();
        const failure = new Error("fixture item failed");
        let waves = 0;
        const input = {
            planIdentity: { platform: "wsl", platformInstanceId: "Ubuntu" },
            filePaths: ["/fixture/bin/a", "/fixture/bin/b"],
            observe: async () => {
                waves += 1;
                return [
                    {
                        filePath: "/fixture/bin/a",
                        status: "complete" as const,
                        observation: {
                            executable: true,
                            identity: { deviceId: "1", fileId: "2", entryKind: "file" as const },
                            byteSize: 3,
                            buildIdentity: `sha256:${"a".repeat(64)}` as const,
                        },
                    },
                    { filePath: "/fixture/bin/b", status: "failed" as const, error: failure },
                ];
            },
        };
        primeTargetCheckBuildObservations(snapshot, input);
        primeTargetCheckBuildObservations(snapshot, input);

        await expect(prewarmedTargetCheckBuildObservation(snapshot, "/fixture/bin/a")).resolves.toMatchObject({
            byteSize: 3,
            buildIdentity: `sha256:${"a".repeat(64)}`,
        });
        await expect(prewarmedTargetCheckBuildObservation(snapshot, "/fixture/bin/b")).rejects.toBe(failure);
        expect(prewarmedTargetCheckBuildObservation(snapshot, "/fixture/bin/c")).toBeUndefined();
        expect(waves).toBe(1);

        expect(() =>
            primeTargetCheckBuildObservations(snapshot, {
                ...input,
                filePaths: ["/fixture/bin/a"],
            }),
        ).toThrow("target-check build observation plan changed");
    });

    it("prewarms executable and app-bundle evidence, localizes item failure, and skips ineligible evidence", async () => {
        const fixture = makeFixture();
        const runtime = fixture.input.probeResult.observation.observedAgentRuntimes[0];
        if (runtime === undefined) throw new Error("fixture runtime is missing");
        const valid = runtime.installationEvidence[0];
        if (valid === undefined) throw new Error("fixture build evidence is missing");
        runtime.installationEvidence = [
            {
                ...valid,
                path: "/fixture/bin/current",
                currentBuildObservation: {
                    executable: true,
                    identity: { deviceId: "current-device", fileId: "current-file", entryKind: "file" },
                    byteSize: 7,
                    buildIdentity: `sha256:${"b".repeat(64)}`,
                },
            },
            { ...valid, path: "/fixture/bin/z" },
            { ...valid, path: "/fixture/bin/a" },
            { ...valid, kind: "app_bundle", path: "/fixture/app/bundle.asar" },
            { ...valid, kind: "install_root" },
            { ...valid, evidenceLevel: "source_code" },
            { ...valid, diagnostics: [errorDiagnostic()] },
            { ...valid, path: "relative" },
            { ...valid, path: "/outside/bin/consumer" },
        ];
        fixture.input.probeResult.observation.observedAgentRuntimes.push({
            ...structuredClone(runtime),
            agentRuntimeId: "UNAVAILABLE_RUNTIME",
            installationStatus: "not_found",
            installationEvidence: [{ ...valid, path: "/fixture/bin/unavailable-sibling" }],
        });
        const snapshot = createTargetCheckObservationSnapshot();
        let observedPaths: readonly string[] = [];
        primeOperationLocalBuildArtifactObservations([fixture.input.probeResult], snapshot, async (input) => {
            observedPaths = input.filePaths;
            return {
                elapsedMilliseconds: 1,
                maximumConcurrencyObserved: 2,
                items: input.filePaths.map((filePath) =>
                    filePath === "/fixture/bin/a"
                        ? {
                              status: "failed" as const,
                              filePath,
                              failureKind: "stale" as const,
                              systemCode: "ESTALE",
                          }
                        : {
                              status: "complete" as const,
                              filePath,
                              identity: { deviceId: "1", fileId: filePath, entryKind: "file" as const },
                              executable: filePath !== "/fixture/app/bundle.asar",
                              byteSize: 3,
                              sha256Hex: "a".repeat(64),
                          },
                ),
            };
        });
        await expect(prewarmedTargetCheckBuildObservation(snapshot, "/fixture/bin/a")).rejects.toMatchObject({
            failureKind: "stale",
        });
        await expect(prewarmedTargetCheckBuildObservation(snapshot, "/fixture/bin/z")).resolves.toMatchObject({
            executable: true,
            byteSize: 3,
        });
        await expect(prewarmedTargetCheckBuildObservation(snapshot, "/fixture/app/bundle.asar")).resolves.toMatchObject({
            executable: false,
            byteSize: 3,
        });
        await expect(prewarmedTargetCheckBuildObservation(snapshot, "/fixture/bin/current")).resolves.toMatchObject({
            executable: true,
            byteSize: 7,
            buildIdentity: `sha256:${"b".repeat(64)}`,
        });
        expect(observedPaths).toEqual(["/fixture/app/bundle.asar", "/fixture/bin/a", "/fixture/bin/z"]);
    });

    it("uses only current probe observations without starting a Shared build wave", async () => {
        const fixture = makeFixture();
        const evidence = fixture.input.probeResult.observation.observedAgentRuntimes[0]?.installationEvidence[0];
        if (evidence === undefined) throw new Error("fixture build evidence is missing");
        evidence.currentBuildObservation = {
            executable: true,
            identity: { deviceId: "current-device", fileId: "current-file", entryKind: "file" },
            byteSize: 7,
            buildIdentity: `sha256:${"b".repeat(64)}`,
        };
        const observe = vi.fn(async () => {
            throw new Error("Shared build wave must not start");
        });
        const snapshot = createTargetCheckObservationSnapshot();
        primeOperationLocalBuildArtifactObservations([fixture.input.probeResult], snapshot, observe);
        await expect(prewarmedTargetCheckBuildObservation(snapshot, evidence.path)).resolves.toMatchObject({
            byteSize: 7,
            buildIdentity: `sha256:${"b".repeat(64)}`,
        });
        expect(observe).not.toHaveBeenCalled();
    });

    it("retains selected consumers' current observations without reading missing or sibling build evidence", async () => {
        const fixture = makeFixture();
        const entry = fixture.input.probeResult.observation.observedAgentRuntimes[0]!;
        const evidence = entry.installationEvidence[0]!;
        evidence.currentBuildObservation = {
            executable: true,
            identity: { deviceId: "current-device", fileId: "current-file", entryKind: "file" },
            byteSize: 7,
            buildIdentity: `sha256:${"b".repeat(64)}`,
        };
        entry.installationEvidence.push({ ...evidence, path: "/fixture/unobserved", currentBuildObservation: undefined });
        fixture.input.probeResult.observation.observedAgentRuntimes.push({
            ...entry,
            agentRuntimeId: "UNSELECTED_CLI",
            installationEvidence: [{ ...evidence, path: "/fixture/unselected" }],
        });
        const before = structuredClone(fixture.input.probeResult);
        const snapshot = createTargetCheckObservationSnapshot();
        retainCurrentTargetBuildObservations([fixture.input.probeResult], [entry.agentRuntimeId], snapshot);
        await expect(prewarmedTargetCheckBuildObservation(snapshot, evidence.path)).resolves.toEqual(
            evidence.currentBuildObservation,
        );
        expect(prewarmedTargetCheckBuildObservation(snapshot, "/fixture/unobserved")).toBeUndefined();
        expect(prewarmedTargetCheckBuildObservation(snapshot, "/fixture/unselected")).toBeUndefined();
        expect(fixture.input.probeResult).toEqual(before);
    });

    it("rejects an incomplete Shared build-wave result", async () => {
        const fixture = makeFixture();
        const evidence = fixture.input.probeResult.observation.observedAgentRuntimes[0]?.installationEvidence[0];
        if (evidence === undefined) throw new Error("fixture build evidence is missing");
        const snapshot = createTargetCheckObservationSnapshot();
        primeOperationLocalBuildArtifactObservations([fixture.input.probeResult], snapshot, async () => ({
            elapsedMilliseconds: 1,
            maximumConcurrencyObserved: 0,
            items: [],
        }));
        await expect(prewarmedTargetCheckBuildObservation(snapshot, evidence.path)).rejects.toThrow(
            "operation-local build observation result is incomplete",
        );
    });

    it("rejects conflicting current probe observations for one physical build path", () => {
        const fixture = makeFixture();
        const first = fixture.input.probeResult.observation.observedAgentRuntimes[0]?.installationEvidence[0];
        if (first === undefined) throw new Error("fixture build evidence is missing");
        first.currentBuildObservation = {
            executable: true,
            identity: { deviceId: "device", fileId: "first", entryKind: "file" },
            byteSize: 3,
            buildIdentity: `sha256:${"a".repeat(64)}`,
        };
        for (const identity of [
            { ...first.currentBuildObservation.identity, fileId: "second" },
            { ...first.currentBuildObservation.identity, entryKind: "directory" as const },
        ]) {
            const duplicate = structuredClone(fixture.input.probeResult);
            const second = duplicate.observation.observedAgentRuntimes[0]?.installationEvidence[0];
            if (second === undefined) throw new Error("duplicate build evidence is missing");
            second.currentBuildObservation = { ...first.currentBuildObservation, identity };
            expect(() =>
                primeOperationLocalBuildArtifactObservations(
                    [fixture.input.probeResult, duplicate],
                    createTargetCheckObservationSnapshot(),
                ),
            ).toThrow("current build observations disagree");
        }
    });

    it("skips an empty or ineligible build wave and rejects mixed platform contexts", () => {
        const snapshot = createTargetCheckObservationSnapshot();
        primeOperationLocalBuildArtifactObservations([], snapshot);
        expect(prewarmedTargetCheckBuildObservation(snapshot, "/fixture/bin/consumer")).toBeUndefined();

        const ineligible = makeFixture();
        const evidence = ineligible.input.probeResult.observation.observedAgentRuntimes[0]?.installationEvidence[0];
        if (evidence === undefined) throw new Error("fixture build evidence is missing");
        evidence.kind = "app_bundle";
        evidence.evidenceLevel = "source_code";
        primeOperationLocalBuildArtifactObservations([ineligible.input.probeResult], snapshot);
        expect(prewarmedTargetCheckBuildObservation(snapshot, evidence.path)).toBeUndefined();

        const first = makeFixture();
        const second = structuredClone(first.input.probeResult);
        second.observation.platformContext.platformInstanceId = "other";
        expect(() =>
            primeOperationLocalBuildArtifactObservations(
                [first.input.probeResult, second],
                createTargetCheckObservationSnapshot(),
            ),
        ).toThrow("spans multiple platform contexts");
    });

    it("uses the prewarmed build when present and otherwise takes fresh bounded build facts", async () => {
        const fixture = makeFixture();
        const target = {
            targetCandidateId: "project-target",
            targetKind: "project" as const,
            evidenceLevel: "local_artifact" as const,
        };
        const buildPath = fixture.input.probeResult.observation.observedAgentRuntimes[0]?.installationEvidence[0]?.path;
        if (buildPath === undefined) throw new Error("fixture build path is missing");
        const prewarmedSnapshot = createTargetCheckObservationSnapshot();
        primeTargetCheckBuildObservations(prewarmedSnapshot, {
            planIdentity: { fixture: true },
            filePaths: [buildPath],
            observe: async () => [
                {
                    filePath: buildPath,
                    status: "complete",
                    observation: {
                        executable: true,
                        identity: { deviceId: "1", fileId: "prewarmed", entryKind: "file" },
                        byteSize: 7,
                        buildIdentity: `sha256:${"b".repeat(64)}` as const,
                    },
                },
            ],
        });
        const fresh = {
            executable: true,
            identity: { deviceId: "target-device", fileId: "target-inode", entryKind: "file" as const },
            byteSize: BUILD_BYTES.byteLength,
            sha256Hex: createHash("sha256").update(BUILD_BYTES).digest("hex"),
        };
        const readFresh = vi.fn(async () => fresh);
        await expect(
            operationLocalBuildArtifactObserverAsync(fixture.input, target, prewarmedSnapshot, readFresh)(buildPath),
        ).resolves.toMatchObject({ byteSize: 7 });
        expect(readFresh).not.toHaveBeenCalled();
        await expect(
            operationLocalBuildArtifactObserverAsync(
                fixture.input,
                target,
                createTargetCheckObservationSnapshot(),
                readFresh,
            )(buildPath),
        ).resolves.toEqual({
            executable: fresh.executable,
            identity: fresh.identity,
            byteSize: fresh.byteSize,
            buildIdentity: `sha256:${fresh.sha256Hex}`,
        });
        expect(readFresh).toHaveBeenLastCalledWith(
            {
                platform: fixture.input.probeResult.observation.platformContext.platform,
                platformInstanceId: fixture.input.probeResult.observation.platformContext.platformInstanceId,
                accessRootPath: fixture.input.probeResult.observation.platformContext.accessRootPath,
                filePath: buildPath,
            },
            25_000,
        );
        await operationLocalBuildArtifactObserverAsync(fixture.input, target, undefined, readFresh)(buildPath);
        expect(readFresh).toHaveBeenCalledTimes(2);
        const error = new SafeFilesystemError({
            failureKind: "stale",
            operation: "inspect_regular_file",
            targetPath: buildPath,
            systemCode: "ESTALE",
            message: "changed descriptor",
        });
        await expect(
            operationLocalBuildArtifactObserverAsync(fixture.input, target, undefined, async () => {
                throw error;
            })(buildPath),
        ).rejects.toBe(error);
    });

    it("fails closed for invalid prewarm plans, result shapes, and snapshot owners", async () => {
        const invalidSnapshot = Object.freeze({ snapshotKind: "target_check_observation" }) as never;
        expect(() =>
            primeTargetCheckBuildObservations(invalidSnapshot, {
                planIdentity: {},
                filePaths: ["/fixture/a"],
                observe: async () => [],
            }),
        ).toThrow("snapshot owner is invalid");
        expect(() => prewarmedTargetCheckBuildObservation(invalidSnapshot, "/fixture/a")).toThrow("snapshot owner is invalid");

        for (const filePaths of [[], ["/fixture/a", "/fixture/a"], [""]]) {
            expect(() =>
                primeTargetCheckBuildObservations(createTargetCheckObservationSnapshot(), {
                    planIdentity: {},
                    filePaths,
                    observe: async () => [],
                }),
            ).toThrow("plan is invalid");
        }

        const failureCases = [
            async () => [{ filePath: "/fixture/other", status: "failed" as const, error: new Error("wrong") }],
            async () => [],
            async () => {
                throw new Error("wave failed");
            },
        ];
        for (const observe of failureCases) {
            const snapshot = createTargetCheckObservationSnapshot();
            primeTargetCheckBuildObservations(snapshot, {
                planIdentity: {},
                filePaths: ["/fixture/a"],
                observe,
            });
            await expect(prewarmedTargetCheckBuildObservation(snapshot, "/fixture/a")).rejects.toBeInstanceOf(Error);
        }

        const duplicateSnapshot = createTargetCheckObservationSnapshot();
        primeTargetCheckBuildObservations(duplicateSnapshot, {
            planIdentity: {},
            filePaths: ["/fixture/a", "/fixture/b"],
            observe: async () => [
                { filePath: "/fixture/a", status: "complete", observation: stableObservation() },
                { filePath: "/fixture/a", status: "complete", observation: stableObservation() },
            ],
        });
        await expect(prewarmedTargetCheckBuildObservation(duplicateSnapshot, "/fixture/a")).rejects.toThrow("identity changed");

        let reads = 0;
        const shiftingResult = {
            status: "complete" as const,
            observation: stableObservation(),
            get filePath() {
                reads += 1;
                return reads < 3 ? "/fixture/a" : "/fixture/b";
            },
        };
        const shiftingSnapshot = createTargetCheckObservationSnapshot();
        primeTargetCheckBuildObservations(shiftingSnapshot, {
            planIdentity: {},
            filePaths: ["/fixture/a"],
            observe: async () => [shiftingResult],
        });
        await expect(prewarmedTargetCheckBuildObservation(shiftingSnapshot, "/fixture/a")).rejects.toThrow("incomplete");
    });

    it("creates a fresh scope for mutable operation arrays", () => {
        const scopes = new TargetCheckObservationScopes();
        const mutable = [makeFixture().input.probeResult];
        expect(scopes.for(mutable)).not.toBe(scopes.for(mutable));
    });

    it("shares build observations but refreshes target files for one immutable Host probe array", async () => {
        const scopes = new TargetCheckObservationScopes();
        const probeResults = Object.freeze([makeFixture().input.probeResult]);
        const first = scopes.for(probeResults);
        const second = scopes.for(probeResults);
        expect(first).not.toBe(second);

        const buildRead = vi.fn(async () => stableRead(BUILD_BYTES));
        const buildIdentity = { provider: "fixture", runtime: "CLI", path: "/fixture/bin/consumer" };
        await observeStableBuildArtifactForTargetCheckAsync(buildIdentity, first, buildRead);
        await observeStableBuildArtifactForTargetCheckAsync(buildIdentity, second, buildRead);
        expect(buildRead).toHaveBeenCalledTimes(1);

        const targetIdentity = { platform: "wsl", platformInstanceId: "Ubuntu", filePath: "/project/AGENTS.md" };
        const firstBytes = new Uint8Array([1]);
        const secondBytes = new Uint8Array([2]);
        const targetRead = vi
            .fn<() => Promise<ReturnType<typeof stableRead>>>()
            .mockResolvedValueOnce(stableRead(firstBytes))
            .mockResolvedValueOnce(stableRead(secondBytes));
        await expect(observeStableTargetFileForTargetCheckAsync(targetIdentity, first, targetRead)).resolves.toMatchObject({
            bytes: firstBytes,
        });
        await expect(observeStableTargetFileForTargetCheckAsync(targetIdentity, first, targetRead)).resolves.toMatchObject({
            bytes: firstBytes,
        });
        await expect(observeStableTargetFileForTargetCheckAsync(targetIdentity, second, targetRead)).resolves.toMatchObject({
            bytes: secondBytes,
        });
        expect(targetRead).toHaveBeenCalledTimes(2);
    });
});

function stableRead(bytes: Uint8Array) {
    return {
        bytes: new Uint8Array(bytes),
        executable: true,
        identity: { deviceId: "1", fileId: "2", entryKind: "file" as const },
    };
}

function stableObservation() {
    return {
        executable: true,
        identity: { deviceId: "1", fileId: "2", entryKind: "file" as const },
        byteSize: BUILD_BYTES.byteLength,
        buildIdentity: `sha256:${"a".repeat(64)}` as const,
    };
}

function errorDiagnostic() {
    return {
        severity: "error" as const,
        code: "fixture.error",
        message: "fixture error",
        operation: "probe" as const,
        causeKind: "verification_failed" as const,
        path: "",
        traceId: "",
        retryable: false,
        suggestedActions: [],
        rawSummary: "",
    };
}
