import { describe, expect, it } from "vitest";
import { RESTRICTED_TARGET_MAX_FRAME_BYTES } from "../../src/deployment/restricted-target-contract";
import {
    decodeRestrictedUsageExpectations,
    encodeRestrictedUsageExpectations,
    isRestrictedUsageObservation,
    restrictedUsageExpectationFingerprint,
} from "../../src/orchestration/restricted-target-usage-codec";
import { usageExpectation } from "./fixtures/restricted-target-usage-fixture";

function valid() {
    return [
        {
            ...usageExpectation("leaf/AGENTS.md"),
            directoryBoundaries: [{ relativePath: "leaf", desiredDirectoryPaths: ["leaf", "leaf/empty"] }],
            sourceIdentityFingerprints: [`sha256:${"a".repeat(64)}`],
        },
    ];
}

describe("minimal semantic usage wire", () => {
    it("detaches only hash/size/mode, full directory membership and source fingerprints", () => {
        const value = valid();
        const encoded = encodeRestrictedUsageExpectations(value);
        expect(encoded).toEqual(value);
        expect(encoded).not.toBe(value);
        expect(encoded[0]!.directoryBoundaries).not.toBe(value[0]!.directoryBoundaries);
        expect(restrictedUsageExpectationFingerprint(encoded[0]!)).toBe(restrictedUsageExpectationFingerprint(value[0]!));
        expect(decodeRestrictedUsageExpectations([])).toEqual([]);
    });

    it.each([
        ["not an array", () => ({})],
        ["non-object expectation", () => [null]],
        [
            "source domain object",
            (v) => {
                Object.assign(v[0], { sourceSnapshot: {} });
                return v;
            },
        ],
        [
            "files absent",
            (v) => {
                delete v[0].files;
                return v;
            },
        ],
        [
            "files not an array",
            (v) => {
                v[0].files = {};
                return v;
            },
        ],
        [
            "boundaries not an array",
            (v) => {
                v[0].directoryBoundaries = {};
                return v;
            },
        ],
        [
            "identities not an array",
            (v) => {
                v[0].sourceIdentityFingerprints = {};
                return v;
            },
        ],
        [
            "arbitrary file field",
            (v) => {
                v[0].files[0].content = "forbidden";
                return v;
            },
        ],
        [
            "path escape",
            (v) => {
                v[0].files[0].relativePath = "../outside";
                return v;
            },
        ],
        [
            "invalid hash",
            (v) => {
                v[0].files[0].contentHash = "not-a-hash";
                return v;
            },
        ],
        [
            "fractional size",
            (v) => {
                v[0].files[0].byteSize = 0.5;
                return v;
            },
        ],
        [
            "negative size",
            (v) => {
                v[0].files[0].byteSize = -1;
                return v;
            },
        ],
        [
            "oversized file",
            (v) => {
                v[0].files[0].byteSize = 4 * 1024 * 1024 + 1;
                return v;
            },
        ],
        [
            "invalid mode",
            (v) => {
                v[0].files[0].executable = "yes";
                return v;
            },
        ],
        [
            "duplicate file",
            (v) => {
                v[0].files.push(v[0].files[0]);
                return v;
            },
        ],
        [
            "unsorted files",
            (v) => {
                v[0].files.push({ ...v[0].files[0], relativePath: "a.md" });
                return v;
            },
        ],
        [
            "boundary extra field",
            (v) => {
                v[0].directoryBoundaries[0].authority = {};
                return v;
            },
        ],
        [
            "boundary escape",
            (v) => {
                v[0].directoryBoundaries[0].relativePath = "../leaf";
                return v;
            },
        ],
        [
            "directory list absent",
            (v) => {
                delete v[0].directoryBoundaries[0].desiredDirectoryPaths;
                return v;
            },
        ],
        [
            "directory escape",
            (v) => {
                v[0].directoryBoundaries[0].desiredDirectoryPaths.push("../escape");
                return v;
            },
        ],
        [
            "duplicate directory",
            (v) => {
                v[0].directoryBoundaries[0].desiredDirectoryPaths.push("leaf/empty");
                return v;
            },
        ],
        [
            "missing boundary root",
            (v) => {
                v[0].directoryBoundaries[0].desiredDirectoryPaths.shift();
                return v;
            },
        ],
        [
            "outside directory",
            (v) => {
                v[0].directoryBoundaries[0].desiredDirectoryPaths.push("other");
                return v;
            },
        ],
        [
            "duplicate boundary",
            (v) => {
                v[0].directoryBoundaries.push(v[0].directoryBoundaries[0]);
                return v;
            },
        ],
        [
            "invalid source identity",
            (v) => {
                v[0].sourceIdentityFingerprints = ["path"];
                return v;
            },
        ],
        [
            "duplicate source identity",
            (v) => {
                v[0].sourceIdentityFingerprints.push(v[0].sourceIdentityFingerprints[0]);
                return v;
            },
        ],
        [
            "cyclic input",
            (v) => {
                v.push(v);
                return v;
            },
        ],
        ["oversized frame", () => ["x".repeat(RESTRICTED_TARGET_MAX_FRAME_BYTES)]],
    ] satisfies Array<[string, (value: any) => unknown]>)("rejects %s before an exchange", (_label, damage) => {
        const input = damage(valid());
        expect(decodeRestrictedUsageExpectations(input)).toBeNull();
        expect(() => encodeRestrictedUsageExpectations(input as never)).toThrow("invalid restricted asset usage expectations");
    });

    it.each([
        ["absent", "distinct_or_not_imported", true],
        ["already_usable", "same_context_source", true],
        ["already_usable", "cross_context_unverified", false],
        ["different", "same_context_source", true],
        ["different", "cross_context_unverified", true],
        ["unknown", "cross_context_unverified", true],
        ["unknown", "same_context_source", false],
        ["invented", "distinct_or_not_imported", false],
        ["unknown", "invented", false],
    ])("validates state %s / identity relation %s as %s", (observedTargetState, physicalRelation, accepted) => {
        expect(isRestrictedUsageObservation({ observedTargetState, physicalRelation })).toBe(accepted);
    });

    it.each([
        "permission_denied",
        "blocked_managed_target",
        "blocked_symlink_or_reparse",
        "resource_limit_exceeded",
        "busy",
        "stale",
        "io_error",
    ])("admits only an unknown distinct target with bounded %s failure", (failureStatus) => {
        const observation = { observedTargetState: "unknown", physicalRelation: "distinct_or_not_imported", failureStatus };
        expect(isRestrictedUsageObservation(observation)).toBe(true);
        for (const observedTargetState of ["absent", "already_usable", "different"])
            expect(isRestrictedUsageObservation({ ...observation, observedTargetState })).toBe(false);
        for (const physicalRelation of ["cross_context_unverified", "same_context_source"])
            expect(isRestrictedUsageObservation({ ...observation, physicalRelation })).toBe(false);
        expect(isRestrictedUsageObservation({ ...observation, message: "/private/path" })).toBe(false);
    });

    it.each([
        undefined,
        null,
        1,
        "succeeded",
        "not_found",
        "invented",
        "constructor",
    ])("rejects invalid failure status %s", (failureStatus) => {
        expect(
            isRestrictedUsageObservation({
                observedTargetState: "unknown",
                physicalRelation: "distinct_or_not_imported",
                failureStatus,
            }),
        ).toBe(false);
    });

    it("rejects missing or extra response authority", () => {
        expect(isRestrictedUsageObservation(null)).toBe(false);
        expect(
            isRestrictedUsageObservation({
                observedTargetState: "absent",
                physicalRelation: "distinct_or_not_imported",
                source: {},
            }),
        ).toBe(false);
    });
});
