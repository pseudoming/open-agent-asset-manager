import * as fs from "node:fs";
import * as path from "node:path";
import { readRegularFileNoFollow } from "@oaam/shared/filesystem";
import { describe, expect, it } from "vitest";
import { sha256Bytes } from "../../src/foundation/crypto-bytes";
import { resolveObservedNativeProjectGuidanceTargetContextForTest } from "../../src/render/native-project-guidance";
import {
    prewarmedTargetCheckBuildObservation,
    type TargetCheckObservationSnapshot,
} from "../../src/render/native-project-target-observation-snapshot";
import {
    analyzeAndSelect,
    DEPLOYMENT_ID,
    executablePath,
    previewedApply,
    provider,
    seedAuthority,
    service,
    targetRoot,
    verifiedBuild,
} from "./fixtures/core-service-render-test-fixtures";

describe("render preparation build freshness", () => {
    it("hands each fresh probe's exact build observation to its own target check through preview and Apply", async () => {
        seedAuthority();
        const selected = provider();
        const originalProbe = selected.probe;
        const samples: ReturnType<typeof readRegularFileNoFollow>[] = [];
        const snapshots: TargetCheckObservationSnapshot[] = [];
        selected.probe = async (...args) => {
            const probe = await originalProbe(...args);
            const sample = readRegularFileNoFollow(executablePath);
            samples.push(sample);
            probe.observation.observedAgentRuntimes[0]!.installationEvidence[0]!.currentBuildObservation = {
                executable: sample.executable,
                identity: sample.identity,
                byteSize: sample.bytes.byteLength,
                buildIdentity: sha256Bytes(sample.bytes),
            };
            return probe;
        };
        const core = service(selected, Number.POSITIVE_INFINITY, {
            async resolveObservedTargetContext(input, snapshot) {
                expect(snapshot).toBeDefined();
                snapshots.push(snapshot!);
                const sample = samples.at(-1)!;
                await expect(prewarmedTargetCheckBuildObservation(snapshot, executablePath)).resolves.toEqual({
                    executable: sample.executable,
                    identity: sample.identity,
                    byteSize: sample.bytes.byteLength,
                    buildIdentity: sha256Bytes(sample.bytes),
                });
                return resolveObservedNativeProjectGuidanceTargetContextForTest(input, {
                    verifiedBuilds: [verifiedBuild()],
                    readBuildArtifact: () => sample,
                });
            },
        });
        const request = await analyzeAndSelect(core);
        const applied = await core.deployDeployment(await previewedApply(core, request));
        expect(applied.status, JSON.stringify(applied.diagnostics)).toBe("complete");
        expect(samples.length).toBeGreaterThanOrEqual(3);
        expect(snapshots).toHaveLength(samples.length);
        expect(new Set(snapshots).size).toBe(samples.length);
        expect(fs.readFileSync(path.join(targetRoot, "CLAUDE.md"), "utf8")).toBe("# Project guidance\n");
        const beforeScan = samples.length;
        expect((await core.scanDeployment(DEPLOYMENT_ID)).status).toBe("complete");
        expect(samples).toHaveLength(beforeScan);

        const changedBuild = Buffer.from(samples.at(-1)!.bytes);
        changedBuild.writeUInt8(changedBuild.readUInt8(0) ^ 1, 0);
        fs.writeFileSync(executablePath, changedBuild);
        const changed = await core.analyzeDeploymentRender(DEPLOYMENT_ID);
        expect(changed.status).toBe("failed");
        expect(changed.diagnostics.some((diagnostic) => diagnostic.code === "native_guidance_build_unverified")).toBe(true);
        expect(samples).toHaveLength(beforeScan + 1);
        expect(samples.at(-1)!.bytes.byteLength).toBe(samples.at(-2)!.bytes.byteLength);
        expect(sha256Bytes(samples.at(-1)!.bytes)).not.toBe(sha256Bytes(samples.at(-2)!.bytes));
        expect(fs.readFileSync(path.join(targetRoot, "CLAUDE.md"), "utf8")).toBe("# Project guidance\n");
    });
});
