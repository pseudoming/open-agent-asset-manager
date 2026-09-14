/** Real local target capture across the explicit selected-WSL inspection protocol. */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SafeFilesystemError } from "@oaam/shared/filesystem";
import type { RenderOutputUnit } from "../../src/contracts/deployment-authority";
import { createRestrictedTargetChannel } from "../../src/orchestration/restricted-target-channel";
import {
    RESTRICTED_TARGET_PROTOCOL,
    type RestrictedTargetRequest,
    type RestrictedTargetResponse,
} from "../../src/deployment/restricted-target-contract";
import { bindRestrictedTargetReviewChannel } from "../../src/orchestration/restricted-target-review-channel";
import { decodeRestrictedInspectionPlan } from "../../src/orchestration/restricted-target-inspection-codec";
import { createRestrictedTargetService } from "../../src/orchestration/restricted-target-service";
import { computeRenderOutputUnitFingerprint } from "../../src/foundation/fingerprint";
import {
    captureDeploymentInspectionTarget,
    validateCapturedDeploymentInspectionTarget,
    type DeploymentInspectionTargetPlan,
} from "../../src/orchestration/deployment-inspection-capture";
import type { PosixRelativePath, Sha256Digest } from "../../src/types";

const boundary = ".fixture/skill";
const entry = `${boundary}/entry.md`;
const binary = `${boundary}/resources/bin.dat`;
const loose = ".fixture/plain.txt";
const digest = (value: string) => `sha256:${value.repeat(64)}` as Sha256Digest;

describe("restricted target inspection capture", () => {
    let root = "";
    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-restricted-inspection-"));
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    function fixture(mutate?: (response: RestrictedTargetResponse) => void) {
        const localRoot = path.join(root, "target");
        fs.mkdirSync(path.join(localRoot, boundary, "resources"), { recursive: true });
        fs.writeFileSync(path.join(localRoot, entry), "entry\n");
        fs.writeFileSync(path.join(localRoot, binary), Buffer.from([0, 255, 128, 10]));
        fs.chmodSync(path.join(localRoot, binary), 0o700);
        fs.writeFileSync(path.join(localRoot, loose), "plain\n");
        const preimage: Omit<RenderOutputUnit, "outputUnitFingerprint"> = {
            outputContractId: "fixture.exact_graph.v1",
            outputContractFingerprint: digest("2"),
            claims: [
                { relativePath: loose as PosixRelativePath, contentKind: "text", executable: false },
                { relativePath: entry as PosixRelativePath, contentKind: "text", executable: false },
                { relativePath: binary as PosixRelativePath, contentKind: "binary", executable: true },
            ],
            managedDirectoryBoundaries: [
                {
                    schemaVersion: 2,
                    relativePath: boundary as PosixRelativePath,
                    boundaryKind: "directory_inventory",
                    desiredDirectoryPaths: [boundary, `${boundary}/empty`, `${boundary}/resources`] as PosixRelativePath[],
                },
            ],
        };
        const unit = { ...preimage, outputUnitFingerprint: computeRenderOutputUnitFingerprint(preimage) };
        const plan: DeploymentInspectionTargetPlan = {
            compilationFingerprint: digest("1"),
            outputUnits: [unit],
            baselineFiles: unit.claims.map((claim) => ({
                relativePath: claim.relativePath,
                outputUnitFingerprint: unit.outputUnitFingerprint,
                managedDirectoryBoundaryPaths: claim.relativePath.startsWith(`${boundary}/`) ? [boundary] : [],
            })),
        };
        const binding = {
            bindingId: randomUUID(),
            deploymentId: randomUUID(),
            platformInstanceId: "wsl-test",
            targetRootPath: `\\\\wsl.localhost\\wsl-test${localRoot.replaceAll("/", "\\")}`,
            executionRootPath: localRoot,
        };
        const session = { hostInstanceId: randomUUID(), sessionId: randomUUID() };
        const service = createRestrictedTargetService({ ...session, bindings: [binding], deadlineAt: Date.now() + 60_000 });
        const requests: RestrictedTargetRequest[] = [];
        const channel = createRestrictedTargetChannel(session, (request) => {
            requests.push(structuredClone(request));
            const response = service.handle(JSON.parse(JSON.stringify(request)));
            mutate?.(response);
            return JSON.parse(JSON.stringify(response));
        });
        const review = channel.bind(binding).review!;
        return {
            plan,
            service,
            session,
            binding,
            requests,
            channel,
            review,
            localRoot,
            capture: () => review.captureInspectionTarget(plan, binding.targetRootPath),
        };
    }

    it.each([
        "kind",
        "failure_envelope",
        "failure_taxonomy",
        "capture",
    ])("rejects malformed inspection %s after original capture", (kind) => {
        const h = fixture();
        const invalidate = vi.fn();
        const review = bindRestrictedTargetReviewChannel(
            h.binding,
            (_binding, operation) => {
                const result = h.service.handle({
                    ...h.session,
                    protocol: RESTRICTED_TARGET_PROTOCOL,
                    operationId: randomUUID(),
                    sequence: 1,
                    bindingId: h.binding.bindingId,
                    operation,
                }).result;
                expect(result).toMatchObject({ kind: "inspection_capture", outcome: "captured" });
                if (kind === "kind") return { kind: "prepare", outcome: "ready" };
                if (kind === "failure_envelope")
                    return { kind: "inspection_capture", outcome: "failed", failure: {}, extra: true } as never;
                if (kind === "failure_taxonomy") return { kind: "inspection_capture", outcome: "failed", failure: {} } as never;
                return { ...result, extra: true };
            },
            invalidate,
        );
        expect(() => review.captureInspectionTarget(h.plan, h.binding.targetRootPath)).toThrow();
        expect(invalidate).toHaveBeenCalledOnce();
        expect(fs.readFileSync(path.join(h.localRoot, entry), "utf8")).toBe("entry\n");
    });

    it("rejects a foreign inspection target root before transport", () => {
        const h = fixture();
        expect(() => h.review.captureInspectionTarget(h.plan, h.binding.targetRootPath + "\\other")).toThrow(
            "target binding mismatch",
        );
        expect(h.requests).toHaveLength(0);
    });

    it.each([
        "duplicate_file",
        "overlap",
        "duplicate_directory",
        "unrelated_directory",
        "directory_identity",
        "directory_state",
        "entry_limit",
        "byte_limit",
    ])("rejects malformed captured inspection graph %s", (kind) => {
        const h = fixture();
        const authority = captureDeploymentInspectionTarget(h.plan, h.localRoot);
        expect(() => validateCapturedDeploymentInspectionTarget(h.plan, authority)).not.toThrow();
        const file = authority.files.find((file) => file.relativePath === binary)!;
        const directory = authority.directories.find((directory) => directory.relativePath === boundary)!;
        if (kind === "duplicate_file") authority.files.push(structuredClone(file));
        else if (kind === "overlap") h.plan.outputUnits.push(structuredClone(h.plan.outputUnits[0]!));
        else if (kind === "duplicate_directory") authority.directories.push(structuredClone(directory));
        else if (kind === "unrelated_directory")
            authority.directories.push({ relativePath: "unrelated", expectedState: "missing" });
        else if (kind === "directory_identity" && directory.expectedState === "present")
            Object.assign(directory.expectedIdentity, { entryKind: "file" });
        else if (kind === "directory_state") Object.assign(directory, { expectedState: "unknown" });
        else if (kind === "entry_limit")
            for (let index = 0; index < 2048; index++)
                authority.files.push({ ...file, relativePath: `${boundary}/extra-${index}.bin` });
        else if (file.expectedState === "present") file.expectedBytes = new Uint8Array(4 * 1024 * 1024 + 1);
        expect(() => validateCapturedDeploymentInspectionTarget(h.plan, authority)).toThrow();
        expect(fs.readFileSync(path.join(h.localRoot, binary))).toEqual(Buffer.from([0, 255, 128, 10]));
    });

    it("returns exactly the original capture for binary, executable, deleted, added and empty-directory facts", () => {
        const h = fixture();
        fs.unlinkSync(path.join(h.localRoot, entry));
        fs.mkdirSync(path.join(h.localRoot, boundary, "extra-empty"));
        fs.writeFileSync(path.join(h.localRoot, boundary, "added.dat"), Buffer.from([0, 128]));
        expect(fs.existsSync(h.binding.targetRootPath)).toBe(false);
        expect(h.capture()).toEqual(captureDeploymentInspectionTarget(h.plan, h.localRoot));
        expect(h.requests[0]?.operation).toEqual({ kind: "inspection_capture", plan: h.plan });
        const first = h.capture();
        fs.writeFileSync(path.join(h.localRoot, binary), Buffer.from([1, 255]));
        fs.chmodSync(path.join(h.localRoot, binary), 0o600);
        const changed = h.capture();
        expect(changed).not.toEqual(first);
        expect(changed).toEqual(captureDeploymentInspectionTarget(h.plan, h.localRoot));
        expect(h.channel.available).toBe(true);
    });

    it("preserves the existing inspection graph capacity beyond the separate 256-file pre-write-preview limit", () => {
        const h = fixture();
        for (let index = 0; index < 300; index++) fs.writeFileSync(path.join(h.localRoot, boundary, `added-${index}.txt`), "a");
        const captured = h.capture();
        expect(captured.files).toHaveLength(303);
        expect(captured.unmanagedRemovalPaths).toHaveLength(300);
        expect(captured).toEqual(captureDeploymentInspectionTarget(h.plan, h.localRoot));
    });

    it.each([
        "outside_path",
        "state_row",
        "fingerprint",
        "owner",
        "boundary",
    ])("rejects %s plan changes before exchange", (change) => {
        const h = fixture();
        const invalid = structuredClone(h.plan);
        if (change === "outside_path") invalid.baselineFiles[0]!.relativePath = "../outside";
        else if (change === "state_row") Object.assign(invalid.baselineFiles[0]!, { payloadLocator: "/Host/State/private" });
        else if (change === "fingerprint") invalid.outputUnits[0]!.outputUnitFingerprint = digest("9");
        else if (change === "owner") invalid.baselineFiles[0]!.outputUnitFingerprint = digest("9");
        else invalid.baselineFiles[0]!.managedDirectoryBoundaryPaths = [boundary];
        expect(decodeRestrictedInspectionPlan(invalid)).toBeNull();
        expect(() => h.review.captureInspectionTarget(invalid, h.binding.targetRootPath)).toThrow();
        expect(h.requests).toHaveLength(0);
    });

    it.each([
        "bytes",
        "identity",
        "omitted_baseline",
        "unrelated_file",
        "omitted_directory",
        "removal_authority",
    ])("retires %s captures without replay", (change) => {
        const h = fixture((response) => {
            const result = response.result;
            if (result.kind !== "inspection_capture" || result.outcome !== "captured") throw new Error("expected capture");
            const file = result.authority.files.find((file) => file.relativePath === binary)!;
            if (file.expectedState !== "present") throw new Error("expected binary file");
            if (change === "bytes") file.expectedBytesBase64 = "!invalid";
            else if (change === "identity") delete file.expectedIdentity;
            else if (change === "omitted_baseline") result.authority.files.shift();
            else if (change === "unrelated_file") result.authority.files.push({ ...file, relativePath: "unrelated.txt" });
            else if (change === "omitted_directory")
                result.authority.directories = result.authority.directories.filter(
                    (directory) => directory.relativePath !== boundary,
                );
            else result.authority.unmanagedRemovalPaths.push(loose);
        });
        expect(() => h.capture()).toThrow();
        expect(h.channel.available).toBe(false);
        expect(() => h.capture()).toThrow();
        expect(h.requests).toHaveLength(1);
    });

    it("retains original filesystem failure facts in Host coordinates and reuses the channel after correction", () => {
        const h = fixture();
        fs.unlinkSync(path.join(h.localRoot, loose));
        fs.mkdirSync(path.join(h.localRoot, loose));
        expect(() => h.capture()).toThrowError(
            expect.objectContaining({
                failureKind: "wrong_entry_type",
                operation: "read_regular_file",
                targetPath: `${h.binding.targetRootPath}\\${loose.replaceAll("/", "\\")}`,
            }),
        );
        expect(h.channel.available).toBe(true);
        fs.rmdirSync(path.join(h.localRoot, loose));
        fs.writeFileSync(path.join(h.localRoot, loose), "fixed\n");
        expect(h.capture()).toEqual(captureDeploymentInspectionTarget(h.plan, h.localRoot));
        expect(h.requests).toHaveLength(2);
    });

    it("retains the shared 4 MiB managed limit and reuses the channel after the real oversized file is removed", () => {
        const h = fixture();
        const large = path.join(h.localRoot, boundary, "oversized.bin");
        fs.writeFileSync(large, Buffer.alloc(4 * 1024 * 1024, 1));
        expect(() => h.capture()).toThrowError(expect.objectContaining({ failureKind: "resource_limit" }));
        expect(h.channel.available).toBe(true);
        fs.unlinkSync(large);
        expect(h.capture()).toEqual(captureDeploymentInspectionTarget(h.plan, h.localRoot));
    });

    it("rejects a replaced bound root before observing or adopting the replacement", () => {
        const h = fixture();
        fs.renameSync(h.localRoot, path.join(root, "old-target"));
        fs.mkdirSync(h.localRoot);
        expect(() => h.capture()).toThrow(/identity changed/);
        expect(h.channel.available).toBe(false);
        expect(fs.readdirSync(h.localRoot)).toEqual([]);
    });

    it("rejects failure metadata that attempts to address a target outside the bound root", () => {
        const h = fixture((response) => {
            response.result = {
                kind: "inspection_capture",
                outcome: "failed",
                failure: {
                    kind: "filesystem",
                    failureKind: "not_found",
                    operation: "read_regular_file",
                    relativePath: "../outside",
                    systemCode: "ENOENT",
                    message: "missing",
                },
            };
        });
        let error: unknown;
        try {
            h.capture();
        } catch (problem) {
            error = problem;
        }
        expect(error).not.toBeInstanceOf(SafeFilesystemError);
        expect(h.channel.available).toBe(false);
    });
});
