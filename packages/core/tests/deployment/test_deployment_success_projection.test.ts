import { describe, expect, it } from "vitest";
import type { TargetPlan } from "../../src/deployment/deployment-target-plan";
import { projectDeploymentSuccessAuthority } from "../../src/deployment/deployment-success-projection";
import type { ActiveDeploymentBaseline } from "../../src/deployment/deployment-state-ops";
import type { VerifiedTarget } from "../../src/deployment/deployment-target-verify";
import { binaryPayloadStats, textPayloadStats } from "../../src/catalog/payload-store";
import { makeExecutionAuthority } from "./fixtures/deployment-authority-fixtures";

const DEPLOYMENT_ID = "11111111-1111-4111-8111-111111111111";

function plan(): TargetPlan {
    const value: TargetPlan = {
        schemaVersion: 1,
        targetFiles: [
            {
                relativePath: "b.md",
                content: { contentKind: "binary", bytes: new Uint8Array([1, 2, 3]) },
                executable: true,
                outputUnitFingerprint: `sha256:${"1".repeat(64)}`,
                materializationFingerprint: `sha256:${"2".repeat(64)}`,
                semanticRefFingerprints: [],
                sectionBindings: [],
            },
            {
                relativePath: "a.md",
                content: { contentKind: "text", text: "# a\n" },
                executable: false,
                outputUnitFingerprint: `sha256:${"3".repeat(64)}`,
                materializationFingerprint: `sha256:${"4".repeat(64)}`,
                semanticRefFingerprints: [],
                sectionBindings: [],
            },
        ],
    };
    makeExecutionAuthority(value, { deploymentId: DEPLOYMENT_ID });
    return value;
}

function verifiedFor(targetPlan: TargetPlan): VerifiedTarget[] {
    return targetPlan.targetFiles.map((target) => {
        const contentHash =
            target.content.contentKind === "text"
                ? textPayloadStats(target.content.text).contentHash
                : binaryPayloadStats(target.content.bytes).contentHash;
        return {
            relativePath: target.relativePath,
            appliedContentHash: contentHash,
            appliedExecutable: target.executable,
            observedState: "present",
            observedContentHash: contentHash,
            observedExecutable: target.executable,
        };
    });
}

function project(targetPlan: TargetPlan, verified = verifiedFor(targetPlan), baseline: ActiveDeploymentBaseline[] = []) {
    return projectDeploymentSuccessAuthority({
        deploymentId: DEPLOYMENT_ID,
        targetPlan,
        executionAuthority: makeExecutionAuthority(targetPlan, { deploymentId: DEPLOYMENT_ID }),
        baseline,
        verifiedActiveTargets: verified,
        transactionId: "22222222-2222-4222-8222-222222222222",
        now: 10,
    });
}

describe("projectDeploymentSuccessAuthority", () => {
    it("projects text and binary payloads in canonical path order", () => {
        const targetPlan = plan();
        const projected = project(targetPlan);
        expect(projected.activePayloads.map((payload) => payload.contentKind)).toEqual(["text", "binary"]);
        expect(projected.successCommit.verifiedActiveFiles.map((file) => file.verified.relativePath)).toEqual(["a.md", "b.md"]);
    });

    it.each([
        [
            "observed state",
            (row: VerifiedTarget) => {
                row.observedState = "missing";
            },
        ],
        [
            "applied hash",
            (row: VerifiedTarget) => {
                row.appliedContentHash = `sha256:${"a".repeat(64)}`;
            },
        ],
        [
            "observed hash",
            (row: VerifiedTarget) => {
                row.observedContentHash = `sha256:${"b".repeat(64)}`;
            },
        ],
        [
            "applied executable",
            (row: VerifiedTarget) => {
                row.appliedExecutable = !row.appliedExecutable;
            },
        ],
        [
            "observed executable",
            (row: VerifiedTarget) => {
                row.observedExecutable = !row.observedExecutable;
            },
        ],
    ])("rejects a verified target with mismatched %s", (_label, mutate) => {
        const targetPlan = plan();
        const verified = verifiedFor(targetPlan);
        mutate(verified[0] as VerifiedTarget);
        expect(() => project(targetPlan, verified)).toThrow(/verified target/);
    });

    it("rejects non-exact verified and provenance closures", () => {
        const targetPlan = plan();
        expect(() => project(targetPlan, verifiedFor(targetPlan).slice(1))).toThrow(/verified target closure/);
        const authority = makeExecutionAuthority(targetPlan, { deploymentId: DEPLOYMENT_ID });
        authority.targetFileProvenance.pop();
        expect(() =>
            projectDeploymentSuccessAuthority({
                deploymentId: DEPLOYMENT_ID,
                targetPlan,
                executionAuthority: authority,
                baseline: [],
                verifiedActiveTargets: verifiedFor(targetPlan),
                transactionId: "22222222-2222-4222-8222-222222222222",
                now: 10,
            }),
        ).toThrow(/target provenance closure/);
    });

    it("projects a removed active baseline into residual authority", () => {
        const targetPlan = plan();
        const authority = makeExecutionAuthority(targetPlan, { deploymentId: DEPLOYMENT_ID });
        const provenance = authority.targetFileProvenance[0]?.provenance;
        if (provenance === undefined) throw new Error("fixture provenance missing");
        const baselineRow = {
            deploymentId: DEPLOYMENT_ID,
            relativePath: "z-old.md",
            baselineState: {
                rowState: "active" as const,
                appliedPayload: {
                    contentKind: "text" as const,
                    contentHash: textPayloadStats("old").contentHash,
                    byteSize: 3,
                },
                appliedExecutable: false,
                provenance,
            },
            observedState: "present" as const,
            observedContentHash: textPayloadStats("old").contentHash,
            observedExecutable: 0,
            lastObservedAt: 1,
            deleted: 0,
            createdAt: 1,
            updatedAt: 1,
            managedDirectoryBoundaryPaths: [],
        } as ActiveDeploymentBaseline;
        const baseline = [baselineRow, { ...structuredClone(baselineRow), relativePath: "a-old.md" }];
        const projected = project(targetPlan, verifiedFor(targetPlan), baseline);
        expect(projected.successCommit.newlyRemoved.map((row) => row.relativePath)).toEqual(["a-old.md", "z-old.md"]);
    });
});
