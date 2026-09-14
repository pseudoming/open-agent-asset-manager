import type { ManagedTargetReadGuard, ReadEntryHandle } from "@oaam/core";
import { describe, expect, it } from "vitest";
import { canIgnoreManagedSourceEntry, isDirectSourceDirectoryEntry } from "../src/source-managed-entry";

const directory: ReadEntryHandle = {
    readEntryHandleId: "entry",
    sourceReadObligationId: "obligation",
    sourceRootId: "root",
    relativePath: "skills/owned",
    entryKind: "directory",
};
const digest = `sha256:${"a".repeat(64)}` as const;
const active: ManagedTargetReadGuard = {
    sourceRootId: "root",
    relativePath: "skills/owned",
    matchKind: "directory_prefix",
    managementState: "active_managed",
    deploymentId: "00000000-0000-4000-8000-000000000911",
    outputUnitFingerprint: digest,
};
const reservation = (
    relativePath: string,
    matchKind: "directory_prefix" | "exact_file" = "exact_file",
): ManagedTargetReadGuard => ({
    sourceRootId: "root",
    relativePath,
    matchKind,
    managementState: "in_flight_managed",
    deploymentId: active.deploymentId,
    reservationIdentityFingerprint: digest,
});

describe("frozen managed source exclusions", () => {
    it("matches exact roots and path segments, retaining active and residual scope", () => {
        expect(canIgnoreManagedSourceEntry([active], directory)).toBe(true);
        expect(canIgnoreManagedSourceEntry([{ ...active, managementState: "residual_managed" }], directory)).toBe(true);
        expect(
            canIgnoreManagedSourceEntry([active], { ...directory, relativePath: "skills/owned/resource.md", entryKind: "file" }),
        ).toBe(true);
        expect(canIgnoreManagedSourceEntry([active], { ...directory, relativePath: "skills/owned-neighbor" })).toBe(false);
        expect(canIgnoreManagedSourceEntry([{ ...active, sourceRootId: "other" }], directory)).toBe(false);
    });
    it("treats file guards as exact files and an entire-root guard as its own root only", () => {
        const file: ManagedTargetReadGuard = {
            sourceRootId: "root",
            relativePath: "skills/owned",
            matchKind: "exact_file",
            managementState: "active_managed",
            deploymentId: active.deploymentId,
            appliedContentHash: digest,
        };
        expect(canIgnoreManagedSourceEntry([file], { ...directory, entryKind: "file" })).toBe(true);
        expect(canIgnoreManagedSourceEntry([file], { ...directory, relativePath: "skills/owned/child" })).toBe(false);
        const whole: ManagedTargetReadGuard = {
            sourceRootId: "root",
            matchKind: "entire_root",
            managementState: "active_managed",
            deploymentId: active.deploymentId,
            outputUnitFingerprint: digest,
        };
        expect(canIgnoreManagedSourceEntry([whole], directory)).toBe(true);
        expect(canIgnoreManagedSourceEntry([whole], { ...directory, sourceRootId: "other" })).toBe(false);
    });
    it.each([
        reservation("skills/owned"),
        reservation("skills", "directory_prefix"),
        reservation("skills/owned/SKILL.md"),
        {
            sourceRootId: "root",
            matchKind: "entire_root",
            managementState: "in_flight_managed",
            deploymentId: active.deploymentId,
            reservationIdentityFingerprint: digest,
        } satisfies ManagedTargetReadGuard,
    ])("keeps overlapping in-flight authority visible regardless of guard order: $matchKind $relativePath", (guard) => {
        expect(canIgnoreManagedSourceEntry([active, guard], directory)).toBe(false);
        expect(canIgnoreManagedSourceEntry([guard, active], directory)).toBe(false);
    });
    it("does not make a sibling or foreign reservation block an unrelated durable exclusion", () => {
        expect(canIgnoreManagedSourceEntry([active, reservation("skills/owned-neighbor")], directory)).toBe(true);
        expect(canIgnoreManagedSourceEntry([active, { ...reservation("skills/owned"), sourceRootId: "other" }], directory)).toBe(
            true,
        );
        expect(
            canIgnoreManagedSourceEntry([active, reservation("skills/owned/child")], { ...directory, entryKind: "file" }),
        ).toBe(true);
    });
    it("only identifies a directory immediately below a Provider supplied base", () => {
        expect(isDirectSourceDirectoryEntry(directory, ["skills"])).toBe(true);
        expect(isDirectSourceDirectoryEntry({ ...directory, relativePath: "owned" }, [""])).toBe(true);
        expect(isDirectSourceDirectoryEntry({ ...directory, relativePath: "" }, [""])).toBe(false);
        expect(isDirectSourceDirectoryEntry(directory, ["other"])).toBe(false);
        expect(isDirectSourceDirectoryEntry({ ...directory, relativePath: "skills/owned/resources" }, ["skills"])).toBe(false);
        expect(isDirectSourceDirectoryEntry({ ...directory, entryKind: "file" }, ["skills"])).toBe(false);
    });
});
