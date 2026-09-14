import { patchMaterialization } from "./fixtures/restricted-target-container-fixture";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVersionDialectRegistry } from "../../src/catalog/version-dialect-registry";
import { resolveDeploymentContainerPatches } from "../../src/deployment/deployment-container-patch";
import {
    captureDeploymentPreWritePreview,
    type DeploymentPreWritePreviewInput,
} from "../../src/deployment/deployment-prewrite-preview";
import { createRestrictedTargetChannel } from "../../src/orchestration/restricted-target-channel";
import {
    RESTRICTED_TARGET_PROTOCOL,
    type RestrictedTargetRequest,
    type RestrictedTargetResponse,
} from "../../src/deployment/restricted-target-contract";
import { bindRestrictedTargetReviewChannel } from "../../src/orchestration/restricted-target-review-channel";
import * as previewOwner from "../../src/deployment/deployment-prewrite-preview";
import * as containerOwner from "../../src/deployment/deployment-container-patch";
import { decodeRestrictedContainerPatches } from "../../src/deployment/restricted-target-container-codec";
import { decodeRestrictedPreview, encodeRestrictedPreview } from "../../src/deployment/restricted-target-preview-codec";
import { createRestrictedTargetService } from "../../src/orchestration/restricted-target-service";
import { sha256Bytes } from "../../src/foundation/crypto-bytes";
import { computeRenderSelectionFingerprint } from "../../src/foundation/fingerprint";
import { materializeRenderDeployment } from "../../src/render/render-materialization";
import {
    GRAPH_BINARY_RESOURCE_PATH,
    exactGraphMaterializationInput,
    makeExactGraphFixture,
} from "../render/fixtures/native-project-exact-graph-test-fixtures";
import { makeTestTargetPlan } from "./fixtures/deployment-authority-fixtures";

const FP = `sha256:${"a".repeat(64)}` as const;
const roots: string[] = [];
afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(rewrite?: (result: RestrictedTargetResponse["result"]) => unknown) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-target-review-"));
    roots.push(root);
    const target = path.join(root, "target");
    fs.mkdirSync(path.join(target, "leaf/obsolete/empty"), { recursive: true });
    fs.mkdirSync(path.join(target, "leaf/empty"));
    fs.writeFileSync(path.join(target, "leaf/SKILL.md"), "old\n");
    fs.writeFileSync(path.join(target, "leaf/tool.bin"), new Uint8Array([0, 255, 42]));
    fs.chmodSync(path.join(target, "leaf/tool.bin"), 0o755);
    const binding = {
        bindingId: randomUUID(),
        deploymentId: randomUUID(),
        platformInstanceId: "test-selected",
        targetRootPath: `\\\\wsl.localhost\\test-selected${target.replaceAll("/", "\\")}`,
        executionRootPath: target,
    };
    const session = { hostInstanceId: randomUUID(), sessionId: randomUUID() };
    const service = createRestrictedTargetService({ ...session, bindings: [binding], deadlineAt: Date.now() + 60_000 });
    const requests: RestrictedTargetRequest[] = [];
    const channel = createRestrictedTargetChannel(session, (request) => {
        requests.push(structuredClone(request));
        const result = service.handle(JSON.parse(JSON.stringify(request)));
        return JSON.parse(JSON.stringify(rewrite === undefined ? result : { ...result, result: rewrite(result.result) }));
    });
    const execution = channel.bind(binding);
    const targetPlan = makeTestTargetPlan([
        { relativePath: "leaf/SKILL.md", content: { contentKind: "text", text: "new\n" }, executable: false },
        {
            relativePath: "leaf/tool.bin",
            content: { contentKind: "binary", bytes: new Uint8Array([0, 254, 128, 1]) },
            executable: true,
        },
    ]);
    targetPlan.managedDirectoryBoundaries = [
        { relativePath: "leaf", outputUnitFingerprint: FP, desiredDirectoryPaths: ["leaf", "leaf/empty", "leaf/new-empty"] },
    ];
    const input: DeploymentPreWritePreviewInput = {
        deploymentId: binding.deploymentId,
        targetRootPath: binding.targetRootPath,
        renderInputFingerprint: FP,
        selectionFingerprint: FP,
        compilationFingerprint: FP,
        targetPlan,
        baseline: [
            {
                relativePath: "leaf/SKILL.md",
                managedDirectoryBoundaryPaths: ["leaf"],
                baselineState: { appliedPayload: { contentHash: sha256Bytes(Buffer.from("old\n")) }, appliedExecutable: false },
            },
        ],
    };
    return { root, target, binding, session, service, channel, execution, review: execution.review!, requests, input };
}

describe("selected-WSL complete target review", () => {
    it("rejects a valid preview payload belonging to another Deployment at service admission", () => {
        const h = fixture();
        const input = encodeRestrictedPreview({ ...h.input, deploymentId: randomUUID() });
        expect(decodeRestrictedPreview(input)).not.toBeNull();
        expect(() =>
            h.service.handle({
                ...h.session,
                protocol: RESTRICTED_TARGET_PROTOCOL,
                operationId: randomUUID(),
                sequence: 1,
                bindingId: h.binding.bindingId,
                operation: { kind: "preview", input },
            }),
        ).toThrow("Deployment mismatch");
        expect(fs.readFileSync(path.join(h.target, "leaf/SKILL.md"), "utf8")).toBe("old\n");
    });

    it.each(["path", "boundary"])("rejects a noncanonical preview baseline %s before physical capture", (kind) => {
        const h = fixture();
        if (kind === "path") h.input.baseline[0]!.relativePath = "../outside";
        else h.input.baseline[0]!.managedDirectoryBoundaryPaths = ["../outside"];
        expect(() => captureDeploymentPreWritePreview({ ...h.input, targetRootPath: h.target })).toThrow("noncanonical path");
        expect(fs.readFileSync(path.join(h.target, "leaf/SKILL.md"), "utf8")).toBe("old\n");
    });

    it("rejects a present preview capture with omitted physical identity", () => {
        const h = fixture((result) => {
            if (result.kind !== "preview" || result.outcome !== "captured") throw new Error("expected capture");
            const file = result.authority.files.find((file) => file.relativePath === "leaf/SKILL.md")!;
            if (file.expectedState !== "present") throw new Error("expected present file");
            delete file.expectedIdentity;
            return result;
        });
        expect(() => h.review.capturePreWritePreview(h.input)).toThrow("file identity is missing");
        expect(h.channel.available).toBe(false);
    });

    it.each(["text", "executable", "patch_kind"])("rejects invalid %s container fragment materialization", async (kind) => {
        const h = fixture();
        const materialization = await patchMaterialization(h.target);
        expect(containerOwner.deploymentContainerPatchIntents(materialization)).toHaveLength(1);
        const file = materialization.units.flatMap((unit) => unit.files).find((file) => file.containerPatch !== undefined)!;
        if (kind === "text") Object.assign(file, { content: { contentKind: "text", text: "[]" } });
        else if (kind === "executable") Object.assign(file, { executable: true });
        else Object.assign(file.containerPatch!, { patchKind: "unknown" });
        expect(() => containerOwner.deploymentContainerPatchIntents(materialization)).toThrow(
            "non-executable binary fragment bytes",
        );
        expect(h.requests).toHaveLength(0);
    });

    it("rejects an escaping container path before target reads", () => {
        const h = fixture();
        const result = containerOwner.captureDeploymentContainerPatchTargets(
            [{ relativePath: "../outside.jsonc", propertyName: "instructions", fragment: new TextEncoder().encode("[]") }],
            h.target,
        );
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]!.message).toContain("noncanonical JSONC patch target");
        expect(h.requests).toHaveLength(0);
    });

    it.each([
        "missing",
        "foreign",
        "duplicate",
        "bytes",
    ])("rejects %s captured container data against the original materialization", async (kind) => {
        const h = fixture();
        const materialization = await patchMaterialization(h.target);
        const capture = { relativePath: GRAPH_BINARY_RESOURCE_PATH, currentBytes: null };
        expect(containerOwner.resolveCapturedDeploymentContainerPatches(materialization, [capture]).status).toBe("complete");
        const invalid =
            kind === "missing"
                ? []
                : kind === "foreign"
                  ? [{ ...capture, relativePath: "foreign.jsonc" }]
                  : kind === "duplicate"
                    ? [capture, capture]
                    : [{ ...capture, currentBytes: "invalid bytes" }];
        const result = containerOwner.resolveCapturedDeploymentContainerPatches(materialization, invalid as never);
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]!.message).toContain(
            kind === "bytes" ? "invalid captured container bytes" : "do not match the reviewed materialization",
        );
        expect(fs.existsSync(path.join(h.target, GRAPH_BINARY_RESOURCE_PATH))).toBe(false);
    });

    it.each(["kind", "failure", "capture"])("rejects malformed preview %s returned after the original capture", (kind) => {
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
                expect(result).toMatchObject({ kind: "preview", outcome: "captured" });
                if (kind === "kind") return { kind: "prepare", outcome: "ready" };
                if (kind === "failure") return { kind: "preview", outcome: "failed", code: "unknown", message: 1 } as never;
                return { ...result, extra: true };
            },
            invalidate,
        );
        expect(() => review.capturePreWritePreview(h.input)).toThrow();
        expect(invalidate).toHaveBeenCalledOnce();
        expect(fs.readFileSync(path.join(h.target, "leaf/SKILL.md"), "utf8")).toBe("old\n");
    });

    it("propagates an ordinary preview dependency exception instead of classifying it as a valid business refusal", () => {
        const h = fixture();
        const original = previewOwner.captureDeploymentPreWritePreview;
        vi.spyOn(previewOwner, "captureDeploymentPreWritePreview").mockImplementation((...args) => {
            const value = original(...args);
            expect(value.runtimeReplacementAuthority.files.length).toBeGreaterThan(0);
            throw new Error("preview dependency failed after observation");
        });
        expect(() => h.review.capturePreWritePreview(h.input)).toThrow("preview dependency failed after observation");
        expect(h.channel.available).toBe(false);
    });

    it.each(["kind", "failure", "capture"])("rejects malformed container %s after original target capture", async (kind) => {
        const h = fixture();
        const materialization = await patchMaterialization(h.target);
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
                expect(result).toMatchObject({ kind: "container_patches", outcome: "captured" });
                if (kind === "kind") return { kind: "prepare", outcome: "ready" };
                if (kind === "failure") return { kind: "container_patches", outcome: "failed", failure: {} } as never;
                return { ...result, extra: true };
            },
            invalidate,
        );
        expect(() => review.resolveContainerPatches(materialization)).toThrow();
        expect(invalidate).toHaveBeenCalledOnce();
        expect(fs.existsSync(path.join(h.target, GRAPH_BINARY_RESOURCE_PATH))).toBe(false);
    });

    it("rejects a capture dependency failure lacking its required diagnostic", async () => {
        const h = fixture();
        const materialization = await patchMaterialization(h.target);
        vi.spyOn(containerOwner, "captureDeploymentContainerPatchTargets").mockReturnValue({
            status: "failed",
            value: undefined as never,
            diagnostics: [],
        });
        expect(() => h.review.resolveContainerPatches(materialization)).toThrow("failed without a diagnostic");
        expect(h.channel.available).toBe(false);
    });

    it("keeps a healthy session after an ordinary unavailable-target refusal and freshly succeeds after the obstruction is removed", () => {
        const h = fixture();
        const file = path.join(h.target, "leaf/SKILL.md");
        const retained = path.join(h.root, "retained-file");
        fs.renameSync(file, retained);
        fs.mkdirSync(file);
        expect(() => h.review.capturePreWritePreview(h.input)).toThrow(/cannot capture|cannot read/);
        expect(h.channel.available).toBe(true);
        fs.rmdirSync(file);
        fs.renameSync(retained, file);
        expect(h.review.capturePreWritePreview(h.input)).toEqual(
            captureDeploymentPreWritePreview({ ...h.input, targetRootPath: h.target }),
        );
        expect(h.requests).toHaveLength(2);
    });

    it("keeps a healthy session after the original preview file limit refusal", () => {
        const h = fixture();
        // Disjoint desired and last-success files exceed the preview limit without
        // hitting the separate complete-directory inventory limit first.
        h.input.targetPlan.managedDirectoryBoundaries = [];
        h.input.baseline[0]!.managedDirectoryBoundaryPaths = [];
        const files = Array.from({ length: 255 }, (_, i) => `leaf/extra-${i}.md`);
        for (const relativePath of files) {
            fs.writeFileSync(path.join(h.target, relativePath), "extra");
            h.input.baseline.push({
                relativePath,
                managedDirectoryBoundaryPaths: [],
                baselineState: { appliedPayload: { contentHash: sha256Bytes(Buffer.from("extra")) }, appliedExecutable: false },
            });
        }
        expect(() => h.review.capturePreWritePreview(h.input)).toThrow(/256-file review limit/);
        expect(h.channel.available).toBe(true);
        for (const relativePath of files) fs.unlinkSync(path.join(h.target, relativePath));
        h.input.baseline.splice(1);
        expect(h.review.capturePreWritePreview(h.input)).toEqual(
            captureDeploymentPreWritePreview({ ...h.input, targetRootPath: h.target }),
        );
        expect(h.requests).toHaveLength(2);
    });
    it("matches the original complete preview with real binary/executable files, removed/empty directories and Host UNC coordinates", () => {
        const h = fixture();
        const original = captureDeploymentPreWritePreview({ ...h.input, targetRootPath: h.target });
        expect(h.review.capturePreWritePreview(h.input)).toEqual(original);
        expect(h.requests).toHaveLength(1);
        expect(h.requests[0]!.operation.kind).toBe("preview");
        expect(fs.readFileSync(path.join(h.target, "leaf/tool.bin"))).toEqual(Buffer.from([0, 255, 42]));
        const wire = encodeRestrictedPreview(h.input);
        expect(JSON.stringify(wire)).not.toContain("targetRootPath");
        expect(decodeRestrictedPreview(JSON.parse(JSON.stringify(wire)))!.targetPlan).toEqual(h.input.targetPlan);
        expect(Object.keys(wire.baseline[0]!).sort()).toEqual(["baselineState", "managedDirectoryBoundaryPaths", "relativePath"]);
    });

    it("freshly displays an external file change while preserving the confirmed complete-replacement fingerprint", () => {
        const h = fixture();
        const first = h.review.capturePreWritePreview(h.input);
        fs.writeFileSync(path.join(h.target, "leaf/SKILL.md"), "external edit\n");
        const second = h.review.capturePreWritePreview(h.input);
        expect(second.view.actionState).toBe("requires_unmanaged_replacement");
        expect(second.view.previewFingerprint).toBe(first.view.previewFingerprint);
        expect(second.view.files).not.toEqual(first.view.files);
        expect(second).toEqual(captureDeploymentPreWritePreview({ ...h.input, targetRootPath: h.target }));
        expect(h.requests).toHaveLength(2);
    });

    it("rejects mismatched Host roots before exchange and rejects traversal/foreign State fields before service observation", () => {
        const h = fixture();
        const wire = encodeRestrictedPreview(h.input);
        wire.targetPlan.targetFiles[0]!.relativePath = "../outside.md";
        expect(decodeRestrictedPreview(wire)).toBeNull();
        const foreign = encodeRestrictedPreview(h.input);
        Object.assign(foreign.baseline[0]!, { databasePath: "/foreign-state" });
        expect(decodeRestrictedPreview(foreign)).toBeNull();
        expect(() =>
            h.review.capturePreWritePreview({ ...h.input, targetRootPath: `${h.binding.targetRootPath}\\other` }),
        ).toThrow(/binding mismatch/);
        expect(h.requests).toHaveLength(0);
        expect(h.channel.available).toBe(false);
    });

    it.each([
        "invalid_bytes",
        "missing_file",
        "foreign_metadata",
    ])("refuses %s in a response and does not replay on the failed channel", (change) => {
        const h = fixture((result) => {
            if (result.kind !== "preview" || result.outcome !== "captured") throw new Error("expected preview capture");
            if (change === "invalid_bytes") {
                const present = result.authority.files.find((file) => file.expectedState === "present");
                if (present?.expectedState !== "present") throw new Error("expected existing target");
                present.expectedBytesBase64 = "invalid%%%";
            } else if (change === "missing_file") result.authority.files.splice(0, 1);
            else Object.assign(result, { actionState: "ready_apply" });
            return result;
        });
        expect(() => h.review.capturePreWritePreview(h.input)).toThrow();
        expect(h.channel.available).toBe(false);
        expect(() => h.review.capturePreWritePreview(h.input)).toThrow();
        expect(h.requests).toHaveLength(1);
        expect(fs.readFileSync(path.join(h.target, "leaf/SKILL.md"), "utf8")).toBe("old\n");
    });

    it("rejects a replaced selected root before returning replacement-directory facts", () => {
        const h = fixture();
        fs.renameSync(h.target, path.join(h.root, "retained-original"));
        fs.mkdirSync(h.target);
        fs.writeFileSync(path.join(h.target, "foreign.txt"), "preserve");
        expect(() => h.review.capturePreWritePreview(h.input)).toThrow(/identity changed/);
        expect(fs.readdirSync(h.target)).toEqual(["foreign.txt"]);
    });

    it("applies the original JSONC patch to captured bytes, preserving comments, unrelated fields and all materialization authority", async () => {
        const h = fixture();
        const materialization = await patchMaterialization(h.target);
        const target = path.join(h.target, GRAPH_BINARY_RESOURCE_PATH);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const initial = '{\n // keep this comment\n "instructions": ["old.md"], "theme": "warm"\n}\n';
        fs.writeFileSync(target, initial);
        const first = h.review.resolveContainerPatches(materialization);
        expect(first).toEqual(resolveDeploymentContainerPatches(materialization, h.target));
        expect(first.status).toBe("complete");
        expect(fs.readFileSync(target, "utf8")).toBe(initial);
        fs.writeFileSync(target, initial.replace("warm", "cool"));
        const second = h.review.resolveContainerPatches(materialization);
        expect(second).toEqual(resolveDeploymentContainerPatches(materialization, h.target));
        expect(second.value).not.toEqual(first.value);
        expect(h.requests.map((request) => request.operation.kind)).toEqual(["container_patches", "container_patches"]);
    });

    it("preserves missing-container creation and the existing size/unavailable/invalid-JSONC failure distinctions", async () => {
        const h = fixture();
        const materialization = await patchMaterialization(h.target);
        const target = path.join(h.target, GRAPH_BINARY_RESOURCE_PATH);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        expect(h.review.resolveContainerPatches(materialization)).toEqual(
            resolveDeploymentContainerPatches(materialization, h.target),
        );
        expect(fs.existsSync(target)).toBe(false);
        fs.writeFileSync(target, '{"instructions":[], "instructions":[]}');
        expect(h.review.resolveContainerPatches(materialization).diagnostics[0]?.code).toBe(
            "render.materialization_container_patch_rejected",
        );
        fs.writeFileSync(target, Buffer.alloc(4 * 1024 * 1024 + 1, 32));
        expect(h.review.resolveContainerPatches(materialization).diagnostics[0]?.code).toBe(
            "render.materialization_container_patch_limit",
        );
        fs.rmSync(target);
        fs.mkdirSync(target);
        expect(h.review.resolveContainerPatches(materialization).diagnostics[0]?.code).toBe(
            "render.materialization_container_patch_target_unavailable",
        );
    });

    it("rejects an unrelated captured container and malformed patch paths/bytes", async () => {
        const h = fixture((result) => {
            if (result.kind === "container_patches" && result.outcome === "captured")
                result.targets[0]!.relativePath = "unrelated.jsonc";
            return result;
        });
        const materialization = await patchMaterialization(h.target);
        expect(() => h.review.resolveContainerPatches(materialization)).toThrow(/reviewed targets/);
        expect(h.channel.available).toBe(false);
        expect(
            decodeRestrictedContainerPatches([
                { relativePath: "../outside", propertyName: "instructions", fragmentBase64: "W10=" },
            ]),
        ).toBeNull();
        expect(
            decodeRestrictedContainerPatches([
                { relativePath: "file.jsonc", propertyName: "instructions", fragmentBase64: "//8=" },
            ]),
        ).toBeNull();
    });

    it("keeps materializations without container patches local and byte-identical", async () => {
        const h = fixture();
        const materialization = await patchMaterialization(h.target);
        for (const unit of materialization.units) for (const file of unit.files) delete file.containerPatch;
        expect(h.review.resolveContainerPatches(materialization)).toEqual({
            status: "complete",
            value: materialization,
            diagnostics: [],
        });
        expect(h.requests).toHaveLength(0);
    });
});
