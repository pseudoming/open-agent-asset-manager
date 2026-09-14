import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import type { SafeFilesystemError } from "../../../src/filesystem/filesystem-types";
import { inspectRegularFileNoFollow, samePhysicalPathIdentity } from "../../../src/paths/unix-like/filesystem-target-entry";
import {
    listLocalProcessExecutableCandidateIdsBounded,
    listLocalProcessIdsBounded,
    observeLocalProcessBounded,
    observeLocalProcessExecutableBounded,
} from "../../../src/paths/unix-like/path-environment";

describe("Unix-like local process observation", () => {
    it("returns a deterministic bounded snapshot of positive local process IDs", () => {
        const processIds = listLocalProcessIdsBounded(65_536);
        const executableCandidates = listLocalProcessExecutableCandidateIdsBounded(fs.realpathSync(process.execPath), 65_536);

        expect(processIds).toContain(process.pid);
        expect(executableCandidates).toContain(process.pid);
        expect(processIds).toEqual([...processIds].sort((left, right) => left - right));
        expect(executableCandidates).toEqual([...executableCandidates].sort((left, right) => left - right));
        expect(new Set(processIds).size).toBe(processIds.length);
        expect(new Set(executableCandidates).size).toBe(executableCandidates.length);
        expect(processIds.every((processId) => Number.isSafeInteger(processId) && processId > 0)).toBe(true);
        expect(executableCandidates.every((processId) => Number.isSafeInteger(processId) && processId > 0)).toBe(true);
    });

    it("rejects invalid local process-table bounds", () => {
        for (const maximumEntries of [0, -1, 1.5, Number.NaN, 65_537]) {
            expect(() => listLocalProcessIdsBounded(maximumEntries)).toThrow(RangeError);
        }
        expect(() => listLocalProcessExecutableCandidateIdsBounded("", 65_536)).toThrow(TypeError);
    });

    it("binds the current PID lifecycle, command line and executable physical identity", () => {
        const executablePath = fs.realpathSync(process.execPath);
        const executableIdentity = inspectRegularFileNoFollow(executablePath);
        const observation = observeLocalProcessBounded(process.pid, executableIdentity, 65_536);
        const pathAwareObservation = observeLocalProcessExecutableBounded(
            process.pid,
            executablePath,
            executableIdentity,
            65_536,
        );

        expect(observation).not.toBeNull();
        if (observation === null) throw new Error("current process executable identity must match");
        expect(observation.processId).toBe(process.pid);
        expect(observation.lifecycleToken).toMatch(/^[0-9]+$/u);
        expect(observation.commandLineBytes.byteLength).toBeGreaterThan(0);
        expect(samePhysicalPathIdentity(observation.executableIdentity, executableIdentity)).toBe(true);
        expect(pathAwareObservation).toEqual(observation);
    });

    it("fails closed for missing processes and a command line beyond the caller's bound", () => {
        const executableIdentity = inspectRegularFileNoFollow(fs.realpathSync(process.execPath));
        expect(() => observeLocalProcessBounded(2_147_483_647, executableIdentity, 1_024)).toThrowError(
            expect.objectContaining<Partial<SafeFilesystemError>>({
                failureKind: "not_found",
                operation: "observe_local_process",
            }),
        );
        expect(() => observeLocalProcessBounded(process.pid, executableIdentity, 1)).toThrowError(
            expect.objectContaining<Partial<SafeFilesystemError>>({
                failureKind: "resource_limit",
                operation: "observe_local_process",
            }),
        );
    });

    it("does not read an unrelated process command line and rejects invalid inputs", () => {
        const executableIdentity = inspectRegularFileNoFollow(fs.realpathSync(process.execPath));
        const unrelatedIdentity = inspectRegularFileNoFollow(fs.realpathSync("/bin/sh"));
        expect(observeLocalProcessBounded(process.pid, unrelatedIdentity, 1)).toBeNull();

        for (const processId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
            expect(() => observeLocalProcessBounded(processId, executableIdentity, 1)).toThrow(RangeError);
        }
        for (const maximumBytes of [0, -1, 1.5, 1_048_577]) {
            expect(() => observeLocalProcessBounded(process.pid, executableIdentity, maximumBytes)).toThrow(RangeError);
        }
        expect(() => observeLocalProcessBounded(process.pid, { deviceId: "", fileId: "", entryKind: "file" }, 1)).toThrow(
            TypeError,
        );
        expect(() => observeLocalProcessExecutableBounded(process.pid, "", executableIdentity, 1)).toThrow(TypeError);
    });
});
