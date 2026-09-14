import { describe, expect, it } from "vitest";
import { SafeFilesystemError, type SafeFilesystemOperation } from "@oaam/shared/filesystem";
import type { RenderOutputUnit } from "../../src/contracts/deployment-authority";
import { computeRenderOutputUnitFingerprint } from "../../src/foundation/fingerprint";
import { validateRenderOutputUnit } from "../../src/render/deployment-render-authority-validation";
import type { DeploymentInspectionTargetPlan } from "../../src/orchestration/deployment-inspection-capture";
import { DeploymentInspectionFailure } from "../../src/orchestration/deployment-inspection-errors";
import {
    decodeRestrictedInspectionFailure,
    decodeRestrictedInspectionPlan,
    encodeRestrictedInspectionFailure,
} from "../../src/orchestration/restricted-target-inspection-codec";
import type { PosixRelativePath, Sha256Digest } from "../../src/types";

const fingerprint = `sha256:${"a".repeat(64)}` as Sha256Digest;
function unit(id: string, paths: string[], boundaries: string[] = []): RenderOutputUnit {
    const preimage: Omit<RenderOutputUnit, "outputUnitFingerprint"> = {
        outputContractId: id,
        outputContractFingerprint: fingerprint,
        claims: [...paths].sort().map((relativePath) => ({
            relativePath: relativePath as PosixRelativePath,
            contentKind: "text",
            executable: false,
        })),
        managedDirectoryBoundaries: boundaries.map((relativePath) => ({
            schemaVersion: 2,
            relativePath: relativePath as PosixRelativePath,
            boundaryKind: "directory_inventory",
            desiredDirectoryPaths: [relativePath as PosixRelativePath],
        })),
    };
    const result = { ...preimage, outputUnitFingerprint: computeRenderOutputUnitFingerprint(preimage) };
    validateRenderOutputUnit(result);
    return result;
}
function planFor(outputUnits: RenderOutputUnit[]): DeploymentInspectionTargetPlan {
    return {
        compilationFingerprint: fingerprint,
        outputUnits,
        baselineFiles: outputUnits.flatMap((output) =>
            output.claims.map((claim) => ({
                relativePath: claim.relativePath,
                outputUnitFingerprint: output.outputUnitFingerprint,
                managedDirectoryBoundaryPaths: output.managedDirectoryBoundaries
                    .filter((boundary) => claim.relativePath.startsWith(`${boundary.relativePath}/`))
                    .map((boundary) => boundary.relativePath),
            })),
        ),
    };
}
function validPlan(): DeploymentInspectionTargetPlan {
    const plan = planFor([unit("fixture.graph", ["skill/entry.md", "loose.md"], ["skill"])]);
    expect(decodeRestrictedInspectionPlan(plan)).toEqual(plan);
    return plan;
}

describe("restricted inspection compiled authority grammar", () => {
    it.each([
        ["compilationFingerprint", "invalid"],
        ["outputUnits", null],
        ["baselineFiles", null],
        ["extra", true],
    ])("rejects malformed plan %s", (field, value) => {
        const plan = validPlan();
        Object.assign(plan, { [field as string]: value });
        expect(decodeRestrictedInspectionPlan(plan)).toBeNull();
    });
    it("rejects malformed output units through the original validator", () => {
        const plan = validPlan();
        plan.outputUnits[0]!.outputUnitFingerprint = `sha256:${"b".repeat(64)}`;
        expect(decodeRestrictedInspectionPlan(plan)).toBeNull();
    });
    it("rejects duplicate unit fingerprints before treating them as separate owners", () => {
        const plan = validPlan();
        plan.outputUnits.push(structuredClone(plan.outputUnits[0]!));
        expect(decodeRestrictedInspectionPlan(plan)).toBeNull();
    });
    it("rejects separately valid output owners that claim the same path", () => {
        const plan = validPlan();
        const second = unit("fixture.other", ["loose.md"]);
        expect(decodeRestrictedInspectionPlan(planFor([second]))).not.toBeNull();
        expect(decodeRestrictedInspectionPlan(planFor([...plan.outputUnits, second]))).toBeNull();
    });
    it("requires one baseline item for every compiled claim", () => {
        const plan = validPlan();
        plan.baselineFiles.pop();
        expect(decodeRestrictedInspectionPlan(plan)).toBeNull();
    });
    it.each(["skill", "skill/child"])("rejects cross-owner directory overlap at %s", (boundary) => {
        const plan = validPlan();
        const second = unit("fixture.other", [`${boundary}/other.md`], [boundary]);
        expect(decodeRestrictedInspectionPlan(planFor([second]))).not.toBeNull();
        expect(decodeRestrictedInspectionPlan(planFor([...plan.outputUnits, second]))).toBeNull();
    });
    it.each([
        ["relativePath", "../escaped"],
        ["relativePath", "unclaimed.md"],
        ["outputUnitFingerprint", fingerprint],
        ["managedDirectoryBoundaryPaths", null],
        ["managedDirectoryBoundaryPaths", ["../escaped"]],
        ["managedDirectoryBoundaryPaths", []],
        ["extra", true],
    ])("rejects malformed baseline %s: %j", (field, value) => {
        const plan = validPlan();
        Object.assign(plan.baselineFiles.find((file) => file.relativePath === "skill/entry.md")!, { [field as string]: value });
        expect(decodeRestrictedInspectionPlan(plan)).toBeNull();
    });
    it("rejects duplicate baseline paths even when the total count matches", () => {
        const plan = validPlan();
        plan.baselineFiles[1] = structuredClone(plan.baselineFiles[0]!);
        expect(decodeRestrictedInspectionPlan(plan)).toBeNull();
    });
    it("rejects a loose claim that is the directory boundary of a different owner", () => {
        const plan = validPlan();
        const second = unit("fixture.other", ["loose.md/child.md"], ["loose.md"]);
        expect(decodeRestrictedInspectionPlan(planFor([second]))).not.toBeNull();
        expect(decodeRestrictedInspectionPlan(planFor([...plan.outputUnits, second]))).toBeNull();
    });
});

const executionRoot = "/tmp/owned-target";
const hostRoot = "\\\\wsl.localhost\\Ubuntu\\tmp\\owned-target";
function filesystemFailure(targetPath = executionRoot, operation: SafeFilesystemOperation = "read_regular_file") {
    return new SafeFilesystemError({
        failureKind: "permission_denied",
        operation,
        targetPath,
        systemCode: "EACCES",
        message: "owned target denied",
    });
}

describe("restricted inspection failure transport", () => {
    it.each([
        [executionRoot, hostRoot, "read_regular_file"],
        [`${executionRoot}/skill/entry.md`, `${hostRoot}\\skill\\entry.md`, "read_regular_file"],
        [`${executionRoot}/skill`, `${hostRoot}\\skill`, "inventory_directory"],
    ] as const)("projects a bounded %s failure back to Host coordinates", (source, destination, operation) => {
        const error = filesystemFailure(source, operation);
        const wire = encodeRestrictedInspectionFailure(error, executionRoot);
        const decoded = decodeRestrictedInspectionFailure(wire, hostRoot);
        expect(decoded).toBeInstanceOf(SafeFilesystemError);
        expect(decoded).toMatchObject({
            failureKind: "permission_denied",
            operation,
            targetPath: destination,
            systemCode: "EACCES",
            message: error.message,
        });
    });
    it.each([
        [executionRoot, "durable_replace_file"],
        ["/tmp/other", "read_regular_file"],
        [`${executionRoot}/../escaped`, "read_regular_file"],
    ] as const)("does not downgrade an unrepresentable %s %s failure", (target, operation) => {
        const error = filesystemFailure(target, operation);
        let thrown: unknown;
        try {
            encodeRestrictedInspectionFailure(error, executionRoot);
        } catch (problem) {
            thrown = problem;
        }
        expect(thrown).toBe(error);
    });
    it("preserves the exact retryable ownership-conflict taxonomy", () => {
        const original = new DeploymentInspectionFailure(
            "scan.managed_directory_ownership_conflict",
            "overlap",
            "conflict",
            true,
        );
        const wire = encodeRestrictedInspectionFailure(original, executionRoot);
        expect(wire).toEqual({ kind: "ownership_conflict", message: "overlap" });
        expect(decodeRestrictedInspectionFailure(wire, hostRoot)).toMatchObject({
            code: original.code,
            causeKind: "conflict",
            retryable: true,
            message: "overlap",
        });
    });
    it.each([
        new Error("unexpected"),
        new DeploymentInspectionFailure("other", "message", "conflict", true),
        new DeploymentInspectionFailure("scan.managed_directory_ownership_conflict", "message", "unavailable", true),
        new DeploymentInspectionFailure("scan.managed_directory_ownership_conflict", "message", "conflict", false),
    ])("reports an ordinary unavailable failure for %s", (error) => {
        const wire = encodeRestrictedInspectionFailure(error, executionRoot);
        expect(wire).toEqual({ kind: "unavailable", summary: String(error) });
        expect(decodeRestrictedInspectionFailure(wire, hostRoot)).toMatchObject({
            code: "scan.inspection_unavailable",
            causeKind: "unavailable",
            retryable: true,
        });
    });
    it.each([
        ["extra", true],
        ["failureKind", "unknown"],
        ["operation", "durable_replace_file"],
        ["relativePath", "../escaped"],
        ["systemCode", 1],
        ["message", 1],
    ])("rejects malformed wire filesystem failure %s", (field, value) => {
        const wire = encodeRestrictedInspectionFailure(filesystemFailure(), executionRoot);
        Object.assign(wire, { [field as string]: value });
        expect(decodeRestrictedInspectionFailure(wire, hostRoot)).toBeNull();
    });
    it.each([
        null,
        "invalid",
        { kind: "unknown" },
        { kind: "ownership_conflict", message: "conflict", extra: true },
        { kind: "ownership_conflict", message: 1 },
        { kind: "unavailable", summary: "failed", extra: true },
        { kind: "unavailable", summary: 1 },
    ])("rejects undeclared wire failure shapes: %j", (value) => {
        expect(decodeRestrictedInspectionFailure(value, hostRoot)).toBeNull();
    });
});
