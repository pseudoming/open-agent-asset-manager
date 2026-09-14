/** Real sibling Provider reads must reconcile source evidence without discarding native graph semantics. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { createSelectedWslPathProjection } from "@oaam/shared/paths";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codexProvider } from "../../packages/adapter/providers/codex/src/codex-provider";
import {
    bindDialectRegistry,
    fixtureImportService,
    fixtureProbeRootTarget,
    fixtureSourceRoot,
} from "../../packages/adapter/test-support";
import { readVersionAuthority } from "../../packages/core/src/catalog/version-authority";
import {
    candidatePhysicalSourceSlotKey,
    candidateReconciliationSemanticKey,
    candidateRefreshSemanticKey,
    reconcileSnapshotCandidateObservations,
} from "../../packages/core/src/orchestration/import-preview";
import { executeAdapterReadWithAuthority } from "../../packages/core/src/source-import/source-read-execution";
import { validateAdapterReadResultSnapshot } from "../../packages/core/src/source-import/source-read-snapshot-validator";
import { prepareRead } from "../../packages/core/src/source-import/source-read-preparation";
import { createRestrictedSourceChannel } from "../../packages/core/src/source-import/restricted-source-channel";
import { createRestrictedSourceService } from "../../packages/core/src/source-import/restricted-source-service";
import { createRestrictedPipeDispatch } from "../../packages/app-server/host/src/restricted-pipe-dispatch";
import { RESTRICTED_SOURCE_PROTOCOL } from "../../packages/core/src/source-import/restricted-source-protocol";
import type { AdapterReadResult, ExtractedAssetCandidate, ImportAcceptRequest } from "../../packages/core/src/types";

let sandbox = "";
let project = "";
let assets = "";
const relativeRoot = ".agents/skills/review-notes";
const entry =
    "---\nname: review-notes\ndescription: Review the complete native graph.\n---\nRead [notes](references/notes.md).\n";
beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-import-directory-reconciliation-"));
    project = path.join(sandbox, "project");
    assets = path.join(sandbox, "assets");
    fs.mkdirSync(path.join(sandbox, "oaam/transactions"), { recursive: true });
    for (const directory of ["references", "assets", "scripts", "empty"]) {
        fs.mkdirSync(path.join(project, relativeRoot, directory), { recursive: true });
    }
    fs.writeFileSync(path.join(project, relativeRoot, "SKILL.md"), entry);
    fs.writeFileSync(path.join(project, relativeRoot, "references/notes.md"), "Notes\n");
    fs.writeFileSync(path.join(project, relativeRoot, "assets/data.bin"), new Uint8Array([0, 255, 128, 1, 10, 42, 0]));
    fs.writeFileSync(path.join(project, relativeRoot, "scripts/run.sh"), "#!/bin/sh\nprintf 'notes\\n'\n", { mode: 0o700 });
});
afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }));

function siblingTarget(rootPath = project) {
    const root = fixtureSourceRoot({
        sourceRootId: "codex-project",
        path: rootPath,
        rootRole: "project_actual",
        sourceDomain: "project_root",
        locatorKind: "user_provided_path",
        locatorKey: "probe_project_root",
        evidenceLevel: "agent_runtime_verified",
    });
    const target = fixtureProbeRootTarget({
        adapterId: "CODEX",
        agentRuntimeId: "CODEX_CLI",
        versionText: "0.142.5-fixture",
        sourceRoots: [root],
        allowedKinds: ["Skill"],
        installationEvidence: [],
        installationStatus: "available",
        projectDiscoveryStatus: "complete",
    });
    if (target.sourceSelector.selectorKind !== "probe_roots") throw new Error("expected fixture probe roots");
    const observation = target.sourceSelector.observation;
    observation.observedAgentRuntimes.push({ ...observation.observedAgentRuntimes[0]!, agentRuntimeId: "CODEX_APP" });
    return target;
}

async function readSiblings(): Promise<AdapterReadResult> {
    const target = siblingTarget();
    const result = await executeAdapterReadWithAuthority(codexProvider, target, {
        managedTargetGuards: [],
        reservationIdentityFingerprints: [],
        transactionsRoot: path.join(sandbox, "oaam/transactions"),
    });
    expect(result.status, JSON.stringify(result)).toBe("complete");
    expect(validateAdapterReadResultSnapshot(result.value)).toEqual([]);
    expect(result.value.candidates).toHaveLength(2);
    return result.value;
}

function nativeGraph(candidate: ExtractedAssetCandidate) {
    if (candidate.nativeRepresentation.representationSource !== "separate_file_graph") throw new Error("expected native graph");
    return candidate.nativeRepresentation;
}

function service(readAgain = readSiblings) {
    return fixtureImportService({
        provider: codexProvider,
        assetsRoot: assets,
        oaamRoot: path.join(sandbox, "oaam"),
        authorityLocksRoot: path.join(sandbox, "locks"),
        projectRootPath: project,
        projectId: "00000000-0000-4000-8000-000000000159",
        readAgain,
    });
}

function acceptRequest(preview: ImportAcceptRequest["previewSnapshot"]): ImportAcceptRequest {
    return {
        previewSnapshot: preview,
        decision: {
            candidateId: preview.items[0]!.candidateId,
            action: "create_asset",
            freshness: { freshnessAction: "require_current_source" },
            promotion: { promotionAction: "import_only", userActionId: "import-complete-sibling-graph" },
            callableBindings: [],
        },
    };
}

describe("complete native directory source reconciliation", () => {
    it("refreshes the real Codex CLI/App graph beyond 128 pipe messages and rejects a completed-operation replay in Core", async () => {
        const hostRoot = `\\\\wsl.localhost\\read-test${sandbox.replaceAll("/", "\\")}`;
        const projection = createSelectedWslPathProjection("read-test", hostRoot);
        const target = siblingTarget(projection.toHost(project));
        if (target.sourceSelector.selectorKind !== "probe_roots") throw new Error("expected source selector");
        const platformContext = { platform: "wsl" as const, platformInstanceId: "read-test", accessRootPath: hostRoot };
        target.sourceSelector.observation.platformContext = platformContext;
        const executable = path.join(sandbox, "codex-fixture");
        fs.writeFileSync(executable, "fixture executable observation\n");
        for (const runtime of target.sourceSelector.observation.observedAgentRuntimes)
            runtime.installationEvidence = [
                {
                    kind: "executable",
                    path: projection.toHost(executable),
                    evidenceLevel: "agent_runtime_verified",
                    diagnostics: [],
                },
            ];
        const authority = {
            managedTargetGuards: [],
            reservationIdentityFingerprints: [],
            transactionsRoot: path.join(sandbox, "oaam/transactions"),
        };
        const configuration = {
            hostInstanceId: randomUUID(),
            sessionId: randomUUID(),
            platformContext,
            deadlineAt: Date.now() + 60_000,
            maximumResultBytes: 256 * 1024 * 1024,
        };
        let providerCalls = 0;
        const service = createRestrictedSourceService({
            ...configuration,
            providers: [
                {
                    ...codexProvider,
                    async read(input) {
                        providerCalls++;
                        return codexProvider.read(input);
                    },
                },
            ],
        });
        let frames = 0;
        let firstOperationId = "";
        let replayCompletedOperation = false;
        let serviceFailure: Error | undefined;
        let invalidations = 0;
        const dispatch = createRestrictedPipeDispatch({
            session: { ...configuration, protocol: RESTRICTED_SOURCE_PROTOCOL },
            maximumFrameBytes: 12 * 1024 * 1024,
            maximumConcurrentRequests: 1,
            stdin: new Writable({
                write(chunk, _encoding, done) {
                    const request = JSON.parse(String(chunk));
                    if (request.kind === "shutdown") {
                        done();
                        return;
                    }
                    void service.handle(request).then(
                        (response) => {
                            dispatch.receive(JSON.parse(JSON.stringify(response)));
                            done();
                        },
                        (error: Error) => {
                            serviceFailure = error;
                            done(error);
                        },
                    );
                },
            }),
            onInvalid() {
                invalidations++;
            },
        });
        const channel = createRestrictedSourceChannel({
            ...configuration,
            exchange(request) {
                frames++;
                firstOperationId ||= request.operationId;
                const operationId = replayCompletedOperation ? firstOperationId : request.operationId;
                return new Promise((resolve, reject) =>
                    dispatch.submit({
                        operationId,
                        text: JSON.stringify({ ...request, operationId }),
                        complete: resolve,
                        fail: () => reject(new Error(`source wire failed at exchange ${request.sequence}`)),
                    }),
                );
            },
            async abort() {
                dispatch.close();
                service.close();
                await service.settled();
            },
        });
        try {
            let previous: AdapterReadResult | undefined;
            for (let read = 0; read < 3; read++) {
                const refreshedTarget = previous?.readTarget ?? target;
                const prepared = prepareRead(codexProvider, refreshedTarget, authority);
                if ("diagnostics" in prepared) throw new Error(JSON.stringify(prepared.diagnostics));
                const result = await channel.read({
                    platformContext,
                    target: refreshedTarget,
                    preparation: prepared,
                    authority,
                    revalidateAuthority: () => true,
                });
                expect(result.status, JSON.stringify(result.diagnostics)).toBe("complete");
                expect(result.value.candidates).toHaveLength(2);
                expect(validateAdapterReadResultSnapshot(result.value)).toEqual([]);
                if (previous) expect(result.value.readSnapshotFingerprint).toBe(previous.readSnapshotFingerprint);
                previous = result.value;
            }
            expect(channel.available).toBe(true);
            expect(frames).toBeGreaterThan(128);
            expect(providerCalls).toBe(3);
            expect(invalidations).toBe(0);
            expect(dispatch.pendingCount).toBe(0);
            replayCompletedOperation = true;
            const refreshedTarget = previous!.readTarget;
            const prepared = prepareRead(codexProvider, refreshedTarget, authority);
            if ("diagnostics" in prepared) throw new Error(JSON.stringify(prepared.diagnostics));
            await expect(
                channel.read({
                    platformContext,
                    target: refreshedTarget,
                    preparation: prepared,
                    authority,
                    revalidateAuthority: () => true,
                }),
            ).rejects.toThrow(/source wire failed at exchange/);
            expect(serviceFailure?.message).toBe("restricted source request identity, sequence or envelope mismatch");
            expect(providerCalls).toBe(3);
            expect(channel.available).toBe(false);
            expect(invalidations).toBe(1);
            expect(dispatch.pendingCount).toBe(0);
        } finally {
            await channel.close();
        }
    });

    it("imports one real Codex CLI/App source graph after fresh sibling reconciliation and reopens every native entry", async () => {
        const read = await readSiblings();
        const [first, second] = read.candidates as [ExtractedAssetCandidate, ExtractedAssetCandidate];
        const firstGraph = nativeGraph(first);
        const secondGraph = nativeGraph(second);
        expect(firstGraph.directories.length).toBeGreaterThanOrEqual(5);
        expect(firstGraph.directories.map((directory) => directory.observedReadEntryIds)).not.toEqual(
            secondGraph.directories.map((directory) => directory.observedReadEntryIds),
        );
        expect(firstGraph.directories.map((directory) => directory.relativePath)).toEqual(
            secondGraph.directories.map((directory) => directory.relativePath),
        );
        expect(firstGraph.files).toEqual(secondGraph.files);
        expect(candidatePhysicalSourceSlotKey(read, first)).toBe(candidatePhysicalSourceSlotKey(read, second));

        const exactCandidates = structuredClone(read.candidates);
        const importer = service();
        const preview = importer.previewImport([read]);
        expect(preview.status, JSON.stringify(preview.diagnostics)).toBe("complete");
        expect(preview.value.items.map((item) => item.action)).toEqual(["create_asset"]);
        const accepted = await importer.acceptImport(acceptRequest(preview.value));
        expect(accepted.status, JSON.stringify(accepted.diagnostics)).toBe("complete");
        expect(read.candidates).toEqual(exactCandidates);
        expect(preview.value.readResults[0]!.candidates).toEqual(exactCandidates);
        const reopened = readVersionAuthority(
            assets,
            accepted.value.assetId,
            accepted.value.versionId,
            bindDialectRegistry(codexProvider)(),
        );
        expect(reopened?.nativePayloads[0]?.files).toEqual(
            firstGraph.files.map(({ relativePath, bytes }) => ({ relativePath, bytes })),
        );
        const representation = reopened?.manifest.nativeRepresentations[0];
        expect(representation).toMatchObject({
            schemaVersion: 2,
            directories: firstGraph.directories.map((directory) => directory.relativePath),
        });
        expect(representation?.files.find((file) => file.relativePath.endsWith("run.sh"))?.executable).toBe(true);
        if (representation?.schemaVersion !== 2) throw new Error("complete native representation missing");
        expect(representation.directories).toContain(`${relativeRoot}/empty`);
    });

    it("keeps source graph origins in exact snapshot and refresh validation", async () => {
        const read = await readSiblings();
        const malformed = structuredClone(read);
        nativeGraph(malformed.candidates[0]!).directories[0]!.observedReadEntryIds = ["unobserved-directory"];
        expect(validateAdapterReadResultSnapshot(malformed).length).toBeGreaterThan(0);
        expect(service().previewImport([malformed]).diagnostics[0]?.code).toBe("import.read_snapshot_invalid");
        expect(candidateRefreshSemanticKey(read.candidates[0]!)).not.toBe(candidateRefreshSemanticKey(malformed.candidates[0]!));
    });

    it("rejects a real resource edit during import refresh before publishing", async () => {
        const read = await readSiblings();
        const importer = service();
        const preview = importer.previewImport([read]);
        expect(preview.value.items[0]?.action).toBe("create_asset");
        fs.writeFileSync(path.join(project, relativeRoot, "assets/data.bin"), new Uint8Array([1, 255, 128, 1, 10, 42, 0]));
        const accepted = await importer.acceptImport(acceptRequest(preview.value));
        expect(accepted.status).toBe("failed");
        expect(accepted.diagnostics[0]?.code).toBe("import.source_changed");
        expect(fs.existsSync(assets)).toBe(false);
    });

    it.each([
        [
            "native bytes",
            (candidate: ExtractedAssetCandidate) => {
                nativeGraph(candidate).files[0]!.bytes = new Uint8Array([1, 2]);
            },
        ],
        [
            "native file path",
            (candidate: ExtractedAssetCandidate) => {
                nativeGraph(candidate).files[0]!.relativePath += ".changed";
            },
        ],
        [
            "native directory path",
            (candidate: ExtractedAssetCandidate) => {
                nativeGraph(candidate).directories[0]!.relativePath += "-changed";
            },
        ],
        [
            "empty directory",
            (candidate: ExtractedAssetCandidate) => {
                const graph = nativeGraph(candidate);
                graph.directories = graph.directories.filter((directory) => !directory.relativePath.endsWith("/empty"));
            },
        ],
        [
            "executable mode",
            (candidate: ExtractedAssetCandidate) => {
                nativeGraph(candidate).files[0]!.executable = true;
            },
        ],
        [
            "media type",
            (candidate: ExtractedAssetCandidate) => {
                nativeGraph(candidate).files[0]!.mediaType = "text/plain";
            },
        ],
        [
            "content kind",
            (candidate: ExtractedAssetCandidate) => {
                nativeGraph(candidate).files[0]!.contentKind = "binary";
            },
        ],
        [
            "native dialect",
            (candidate: ExtractedAssetCandidate) => {
                nativeGraph(candidate).dialectId = "another-native-dialect-v1";
            },
        ],
        [
            "canonical content",
            (candidate: ExtractedAssetCandidate) => {
                const file = candidate.files[0]!;
                if (file.contentKind !== "text") throw new Error("expected text entry");
                file.text += "Changed instructions\n";
            },
        ],
        [
            "promotion safety",
            (candidate: ExtractedAssetCandidate) => {
                candidate.promotionSafety =
                    candidate.promotionSafety === "default_promotable" ? "requires_user_confirmation" : "default_promotable";
            },
        ],
    ] as const)("still blocks different %s in one physical source slot", async (_label, change) => {
        const read = await readSiblings();
        const [first, second] = read.candidates as [ExtractedAssetCandidate, ExtractedAssetCandidate];
        change(second);
        expect(candidateReconciliationSemanticKey(first)).not.toBe(candidateReconciliationSemanticKey(second));
        expect(
            reconcileSnapshotCandidateObservations(read.candidates.map((candidate) => ({ candidate, readResult: read }))),
        ).toEqual([expect.objectContaining({ conflicted: true })]);
    });
});
