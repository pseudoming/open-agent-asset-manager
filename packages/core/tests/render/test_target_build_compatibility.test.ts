import { describe, expect, it } from "vitest";
import type { AdapterTargetBuildCompatibilityPolicyV1, Sha256Digest } from "../../src/types";
import {
    isValidTargetBuildCompatibilityPolicy,
    resolveTargetBuildCompatibility,
} from "../../src/render/target-build-compatibility";

const policy: AdapterTargetBuildCompatibilityPolicyV1 = {
    schemaVersion: 1,
    versionOrdering: "numeric_dotted_core_v1",
    unknownVersionPolicy: "allow_with_warning",
    deniedBuilds: [],
};
const anchors = [anchor("1.1.2", "1"), anchor("1.2.0-alpha.1", "2")];

describe("target build compatibility", () => {
    it("keeps exact evidence exact and routes newer or repackaged builds to the nearest non-later anchor", () => {
        expect(resolve("1.1.2", "1")).toMatchObject({ status: "exact", anchor: anchors[0] });
        expect(resolve("1.1.10", "3")).toMatchObject({
            status: "compatible",
            reason: "newer_build",
            anchor: anchors[0],
        });
        expect(resolve("1.2.0", "4")).toMatchObject({
            status: "compatible",
            reason: "same_version_unverified_build",
            anchor: anchors[1],
        });
        expect(resolve("1.3.0-preview.7", "5")).toMatchObject({
            status: "compatible",
            reason: "newer_build",
            anchor: anchors[1],
        });
    });

    it("blocks older builds, exact Provider denies, and ambiguous nearest anchors", () => {
        expect(resolve("1.0.9", "6")).toMatchObject({ status: "blocked", reason: "older_than_earliest_anchor" });
        const deniedPolicy: AdapterTargetBuildCompatibilityPolicyV1 = {
            ...policy,
            deniedBuilds: [
                {
                    versionText: "1.1.10",
                    buildIdentity: hash("7"),
                    reasonCode: "known_loader_regression",
                },
            ],
        };
        expect(resolve("1.1.10", "7", deniedPolicy)).toEqual({
            status: "blocked",
            reason: "denied_build",
            denyReasonCode: "known_loader_regression",
        });
        expect(
            resolveTargetBuildCompatibility({
                anchors: [anchor("1.2.0-alpha.1", "8"), anchor("1.2.0-beta.1", "9")],
                policy,
                current: current("1.2.0", "a"),
            }),
        ).toMatchObject({ status: "blocked", reason: "ambiguous_anchor" });
    });

    it("uses the Provider unknown-version choice without suffix-only preview blocking", () => {
        expect(resolve("current-main", "b")).toMatchObject({
            status: "compatible",
            reason: "unknown_version_build",
            anchor: anchors[1],
        });
        expect(
            resolve("current-main", "b", {
                ...policy,
                unknownVersionPolicy: "block",
            }),
        ).toMatchObject({ status: "blocked", reason: "unknown_version_blocked" });
        expect(resolveTargetBuildCompatibility({ anchors, current: current("1.1.10", "c") })).toMatchObject({
            status: "blocked",
            reason: "unknown_version_blocked",
        });
        expect(
            resolveTargetBuildCompatibility({
                anchors: [anchor("current-main", "d")],
                policy,
                current: current("current-main", "e"),
            }),
        ).toMatchObject({ status: "compatible", anchor: { versionText: "current-main" } });
        expect(
            resolveTargetBuildCompatibility({
                anchors: [anchor("current-main", "d"), anchor("current-main", "e")],
                policy,
                current: current("current-main", "f"),
            }),
        ).toMatchObject({ status: "blocked", reason: "ambiguous_anchor" });
    });

    it("routes numeric candidates against unknown-version anchors only when the policy permits it", () => {
        const unknownAnchors = [anchor("current-main", "d")];
        expect(
            resolveTargetBuildCompatibility({
                anchors: unknownAnchors,
                policy: { ...policy, unknownVersionPolicy: "block" },
                current: current("2.0.0", "e"),
            }),
        ).toMatchObject({ status: "blocked", reason: "unknown_version_blocked" });
        expect(
            resolveTargetBuildCompatibility({ anchors: unknownAnchors, policy, current: current("2.0.0", "e") }),
        ).toMatchObject({ status: "compatible", anchor: unknownAnchors[0] });
        expect(
            resolveTargetBuildCompatibility({
                anchors: [anchor("current-a", "d"), anchor("current-b", "e")],
                policy,
                current: current("2.0.0", "f"),
            }),
        ).toMatchObject({ status: "blocked", reason: "ambiguous_anchor" });
        expect(
            resolveTargetBuildCompatibility({
                anchors: [anchor("current-main", "d"), anchor("1.9.0", "e")],
                policy,
                current: current("future-main", "f"),
            }),
        ).toMatchObject({ status: "compatible", anchor: { versionText: "1.9.0" } });
        expect(
            resolveTargetBuildCompatibility({
                anchors: [anchor("2.0.0-alpha.1", "d"), anchor("2.0.0-beta.1", "e")],
                policy,
                current: current("future-main", "f"),
            }),
        ).toMatchObject({ status: "blocked", reason: "ambiguous_anchor" });
    });

    it("rejects malformed candidates, invalid policies, and missing platform anchors", () => {
        for (const candidate of [
            current("", "1"),
            current(" 1.1.2", "1"),
            current("1.1.2\0changed", "1"),
            { ...current("1.1.2", "1"), buildIdentity: "sha256:bad" as Sha256Digest },
        ]) {
            expect(resolveTargetBuildCompatibility({ anchors, policy, current: candidate })).toMatchObject({
                status: "blocked",
                reason: "invalid_candidate",
            });
        }
        expect(
            resolveTargetBuildCompatibility({
                anchors,
                policy: { ...policy, versionOrdering: "invalid" as never },
                current: current("1.1.10", "2"),
            }),
        ).toMatchObject({ status: "blocked", reason: "invalid_policy" });
        expect(
            resolveTargetBuildCompatibility({
                anchors,
                policy,
                current: { ...current("1.1.10", "2"), platform: "linux" },
            }),
        ).toMatchObject({ status: "blocked", reason: "no_platform_anchor" });
        expect(
            resolveTargetBuildCompatibility({
                anchors: [anchor("1.1.2", "1"), anchor("1.1.2", "1")],
                policy,
                current: current("1.1.2", "1"),
            }),
        ).toMatchObject({ status: "blocked", reason: "ambiguous_anchor" });
    });

    it("rejects malformed or nondeterministically ordered deny data", () => {
        expect(isValidTargetBuildCompatibilityPolicy(policy)).toBe(true);
        for (const invalid of [
            { ...policy, schemaVersion: 2 as never },
            { ...policy, versionOrdering: "invalid" as never },
            { ...policy, unknownVersionPolicy: "guess" as never },
            { ...policy, deniedBuilds: null as never },
        ]) {
            expect(isValidTargetBuildCompatibilityPolicy(invalid)).toBe(false);
        }
        for (const deny of [
            { versionText: " 2.0.0", buildIdentity: hash("d"), reasonCode: "reason" },
            { versionText: "", buildIdentity: hash("d"), reasonCode: "reason" },
            { versionText: "2.0.0\0changed", buildIdentity: hash("d"), reasonCode: "reason" },
            { versionText: "2.0.0", buildIdentity: "sha256:bad" as Sha256Digest, reasonCode: "reason" },
            { versionText: "2.0.0", buildIdentity: hash("d"), reasonCode: "Bad-Reason" },
        ]) {
            expect(isValidTargetBuildCompatibilityPolicy({ ...policy, deniedBuilds: [deny] })).toBe(false);
        }
        const duplicate = { versionText: "2.0.0", buildIdentity: hash("d"), reasonCode: "duplicate" };
        expect(isValidTargetBuildCompatibilityPolicy({ ...policy, deniedBuilds: [duplicate, duplicate] })).toBe(false);
        expect(
            isValidTargetBuildCompatibilityPolicy({
                ...policy,
                deniedBuilds: [
                    { versionText: "2.0.0", buildIdentity: hash("d"), reasonCode: "second" },
                    { versionText: "1.0.0", buildIdentity: hash("e"), reasonCode: "first" },
                ],
            }),
        ).toBe(false);
    });

    it("bounds dotted numeric cores and treats missing trailing components as zero", () => {
        expect(
            resolveTargetBuildCompatibility({
                anchors: [anchor("1.2", "1")],
                policy,
                current: current("1.2.0.1", "2"),
            }),
        ).toMatchObject({ status: "compatible", reason: "newer_build" });
        expect(
            resolveTargetBuildCompatibility({
                anchors: [anchor("1.2.0.1", "1")],
                policy,
                current: current("1.2", "2"),
            }),
        ).toMatchObject({ status: "blocked", reason: "older_than_earliest_anchor" });
        for (const versionText of [Array.from({ length: 17 }, () => "1").join("."), "999999999999999999999999999999.1"]) {
            expect(
                resolveTargetBuildCompatibility({
                    anchors,
                    policy: { ...policy, unknownVersionPolicy: "block" },
                    current: current(versionText, "2"),
                }),
            ).toMatchObject({ status: "blocked", reason: "unknown_version_blocked" });
        }
        expect(
            resolveTargetBuildCompatibility({
                anchors: [anchor("2.0.0", "1")],
                policy,
                current: current("2.0.0", "2"),
            }),
        ).toMatchObject({ status: "compatible", reason: "same_version_unverified_build" });
    });
});

function resolve(versionText: string, hashCharacter: string, selectedPolicy: AdapterTargetBuildCompatibilityPolicyV1 = policy) {
    return resolveTargetBuildCompatibility({ anchors, policy: selectedPolicy, current: current(versionText, hashCharacter) });
}

function anchor(versionText: string, hashCharacter: string) {
    return {
        agentRuntimeId: "ANTIGRAVITY_CLI" as const,
        versionText,
        buildIdentity: hash(hashCharacter),
        platform: "wsl" as const,
    };
}

function current(versionText: string, hashCharacter: string) {
    return anchor(versionText, hashCharacter);
}

function hash(character: string): Sha256Digest {
    return `sha256:${character.repeat(64)}` as Sha256Digest;
}
