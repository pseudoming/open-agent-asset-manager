import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Sha256Digest, UuidV4 } from "../../src/contracts/primitives";
import {
    captureDeploymentPreWritePreview,
    DeploymentPreWritePreviewError,
    projectCapturedDeploymentPreWritePreview,
} from "../../src/deployment/deployment-prewrite-preview";
import {
    decodeRestrictedReplacementAuthority,
    encodeRestrictedReplacementAuthority,
} from "../../src/deployment/restricted-target-graph-codec";
import type { ActiveDeploymentBaseline } from "../../src/deployment/deployment-state-ops";
import type { TargetFilePlan, TargetPlan } from "../../src/deployment/deployment-target-plan";
import { sha256Bytes } from "../../src/foundation/crypto-bytes";

const DEPLOYMENT_ID = "11111111-1111-4111-8111-111111111111" as UuidV4;
const SHA_A = `sha256:${"a".repeat(64)}` as Sha256Digest;
const SHA_B = `sha256:${"b".repeat(64)}` as Sha256Digest;

function textFile(relativePath: string, text: string, executable = false): TargetFilePlan {
    return {
        relativePath: relativePath as TargetFilePlan["relativePath"],
        content: { contentKind: "text", text },
        executable,
        outputUnitFingerprint: SHA_A,
        materializationFingerprint: SHA_B,
        semanticRefFingerprints: [],
        sectionBindings: [],
    };
}

function binaryFile(relativePath: string, bytes: Uint8Array, executable = false): TargetFilePlan {
    return {
        ...textFile(relativePath, "", executable),
        content: { contentKind: "binary", bytes },
    };
}

function plan(...targetFiles: TargetFilePlan[]): TargetPlan {
    return { schemaVersion: 1, managedDirectoryBoundaries: [], targetFiles };
}

function managedPlan(boundary: string, ...targetFiles: TargetFilePlan[]): TargetPlan {
    return {
        schemaVersion: 1,
        managedDirectoryBoundaries: [
            {
                relativePath: boundary as TargetPlan["managedDirectoryBoundaries"][number]["relativePath"],
                outputUnitFingerprint: SHA_A,
            },
        ],
        targetFiles,
    };
}

function activeBaseline(relativePath: string, bytes: Uint8Array, executable = false): ActiveDeploymentBaseline {
    const contentHash = sha256Bytes(bytes);
    return {
        deploymentFileId: `baseline:${relativePath}`,
        deploymentId: DEPLOYMENT_ID,
        relativePath,
        baselineState: {
            rowState: "active",
            appliedPayload: { contentKind: "text", contentHash, byteSize: bytes.byteLength },
            appliedExecutable: executable,
            provenance: {
                schemaVersion: 1,
                provenanceFingerprint: SHA_A,
                appliedRenderSnapshotFingerprint: SHA_A,
                outputUnitFingerprint: SHA_A,
                materializationFingerprint: SHA_B,
                semanticRefFingerprints: [],
                sectionBindings: [],
            },
        },
        observedState: "present",
        observedContentHash: contentHash,
        observedExecutable: executable ? 1 : 0,
        observedAt: 1,
        deleted: 0,
        createdAt: 1,
        updatedAt: 1,
        managedDirectoryBoundaryPaths: [],
    };
}

function capture(root: string, targetPlan: TargetPlan, baseline: ActiveDeploymentBaseline[] = []) {
    return captureDeploymentPreWritePreview(captureInput(root, targetPlan, baseline));
}

function captureInput(root: string, targetPlan: TargetPlan, baseline: ActiveDeploymentBaseline[] = []) {
    return {
        deploymentId: DEPLOYMENT_ID,
        targetRootPath: root,
        renderInputFingerprint: SHA_A,
        selectionFingerprint: SHA_B,
        compilationFingerprint: SHA_A,
        targetPlan,
        baseline,
    };
}

function expectPreviewError(run: () => unknown, code: string): void {
    try {
        run();
        throw new Error("expected preview failure");
    } catch (error) {
        expect(error).toBeInstanceOf(DeploymentPreWritePreviewError);
        expect((error as DeploymentPreWritePreviewError).code).toBe(code);
        expect((error as DeploymentPreWritePreviewError).name).toBe("DeploymentPreWritePreviewError");
    }
}

describe("deployment pre-write preview", () => {
    let root = "";

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-prewrite-preview-"));
    });

    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it("recomputes the same complete preview at Host coordinates from binary-safe captured facts without target I/O", () => {
        fs.mkdirSync(path.join(root, "leaf/old-empty"), { recursive: true });
        fs.writeFileSync(path.join(root, "leaf/old.bin"), Buffer.from([0, 255, 128, 10]), { mode: 0o750 });
        const targetPlan = managedPlan(
            "leaf",
            textFile("leaf/SKILL.md", "# New skill\n"),
            binaryFile("leaf/run.bin", new Uint8Array([0, 128, 255]), true),
        );
        targetPlan.managedDirectoryBoundaries[0]!.desiredDirectoryPaths = ["leaf", "leaf/new-empty"];
        const observed = capture(root, targetPlan);
        const decoded = decodeRestrictedReplacementAuthority(
            JSON.parse(JSON.stringify(encodeRestrictedReplacementAuthority(observed.runtimeReplacementAuthority))),
        );
        if (decoded === null) throw new Error("captured preview did not survive its explicit byte codec");
        const hostInput = captureInput(`\\\\wsl.localhost\\test-selected\\${root.slice(1).replaceAll("/", "\\")}`, targetPlan);
        expect(projectCapturedDeploymentPreWritePreview(hostInput, decoded)).toEqual(observed);
        expect(observed.view.actionState).toBe("requires_unmanaged_replacement");
        expect(observed.view.directories.map((directory) => [directory.relativePath, directory.changeKind])).toContainEqual([
            "leaf/old-empty",
            "remove_unmanaged",
        ]);
    });

    it("derives the displayed difference from captured bytes while retaining confirmed whole-file authority", () => {
        const targetPlan = plan(textFile("AGENTS.md", "desired"));
        fs.writeFileSync(path.join(root, "AGENTS.md"), "desired");
        const observed = capture(root, targetPlan);
        expect(observed.view.actionState).toBe("ready_apply");
        const authority = structuredClone(observed.runtimeReplacementAuthority);
        const file = authority.files[0]!;
        if (file.expectedState !== "present") throw new Error("expected captured file");
        file.expectedBytes = new TextEncoder().encode("external replacement");
        const projected = projectCapturedDeploymentPreWritePreview(captureInput(root, targetPlan), authority);
        expect(projected.view.actionState).toBe("requires_unmanaged_replacement");
        expect(projected.view.previewFingerprint).toBe(observed.view.previewFingerprint);
        expect(projected.view.files[0]!.current).toEqual(
            expect.objectContaining({ contentHash: sha256Bytes(file.expectedBytes), text: "external replacement" }),
        );
    });

    it("rejects omitted required files, unrelated paths and a changed directory-removal decision", () => {
        fs.mkdirSync(path.join(root, "leaf/obsolete"), { recursive: true });
        const targetPlan = managedPlan("leaf", textFile("leaf/SKILL.md", "skill"));
        const observed = capture(root, targetPlan);
        const missing = structuredClone(observed.runtimeReplacementAuthority);
        missing.files = [];
        expect(() => projectCapturedDeploymentPreWritePreview(captureInput(root, targetPlan), missing)).toThrow(
            /exact target closure/,
        );
        const unrelated = structuredClone(observed.runtimeReplacementAuthority);
        unrelated.files.push({ relativePath: "sibling/secret.md", expectedState: "missing" });
        expect(() => projectCapturedDeploymentPreWritePreview(captureInput(root, targetPlan), unrelated)).toThrow(
            /exact target closure/,
        );
        const changed = structuredClone(observed.runtimeReplacementAuthority);
        changed.directoryRemovalPaths = [];
        expect(() => projectCapturedDeploymentPreWritePreview(captureInput(root, targetPlan), changed)).toThrow(
            /changes its replacement authority/,
        );
    });

    it("rejects invalid paths, excessive file sets, excessive text, and unreadable exact targets", () => {
        expectPreviewError(() => capture(root, plan(textFile("../escape.md", "bad"))), "render.preview_target_invalid");

        const tooMany = Array.from({ length: 257 }, (_, index) => textFile(`files/${String(index).padStart(3, "0")}.md`, "x"));
        expectPreviewError(() => capture(root, plan(...tooMany)), "render.preview_file_limit");

        expectPreviewError(
            () => capture(root, plan(textFile("large.md", "x".repeat(4 * 1024 * 1024 + 1)))),
            "render.preview_text_limit",
        );

        fs.mkdirSync(path.join(root, "directory.md"));
        expectPreviewError(() => capture(root, plan(textFile("directory.md", "desired"))), "render.preview_target_unavailable");

        fs.writeFileSync(path.join(root, "managed-file"), "not a directory");
        expectPreviewError(
            () => capture(root, managedPlan("managed-file", textFile("managed-file/SKILL.md", "desired"))),
            "render.preview_target_unavailable",
        );

        const overlappingBaseline = activeBaseline("leaf/nested/old.txt", Buffer.from("old"));
        overlappingBaseline.managedDirectoryBoundaryPaths = ["leaf/nested" as never];
        expect(() => capture(root, managedPlan("leaf", textFile("leaf/SKILL.md", "desired")), [overlappingBaseline])).toThrow(
            /one exact managed boundary/,
        );
    });

    it("classifies unmanaged text and binary targets without hiding current bytes", () => {
        fs.writeFileSync(path.join(root, "same.md"), "same");
        fs.writeFileSync(path.join(root, "different.md"), new Uint8Array([0xff, 0xfe]));
        fs.writeFileSync(path.join(root, "binary.bin"), new Uint8Array([1, 2, 3]));

        const preview = capture(
            root,
            plan(
                textFile("new.md", "new"),
                textFile("same.md", "same"),
                textFile("different.md", "desired"),
                binaryFile("binary.bin", new Uint8Array([1, 2, 3])),
            ),
        );

        expect(preview.view.actionState).toBe("requires_unmanaged_replacement");
        expect(preview.view.files.map(({ relativePath, changeKind }) => ({ relativePath, changeKind }))).toEqual([
            { relativePath: "binary.bin", changeKind: "establish_baseline" },
            { relativePath: "different.md", changeKind: "replace_unmanaged" },
            { relativePath: "new.md", changeKind: "create" },
            { relativePath: "same.md", changeKind: "establish_baseline" },
        ]);
        expect(preview.view.files[0]?.current).toMatchObject({ state: "present", contentKind: "binary", byteSize: 3 });
        expect(preview.view.files[1]?.current).toMatchObject({ state: "present", contentKind: "binary", byteSize: 2 });
        expect(preview.view.files[2]?.current).toEqual({ state: "missing" });
        expect(preview.runtimeReplacementAuthority.files).toMatchObject([
            {
                relativePath: "binary.bin",
                expectedState: "present",
                expectedBytes: new Uint8Array([1, 2, 3]),
                expectedExecutable: false,
            },
            {
                relativePath: "different.md",
                expectedState: "present",
                expectedBytes: new Uint8Array([0xff, 0xfe]),
                expectedExecutable: false,
            },
            { relativePath: "new.md", expectedState: "missing" },
            {
                relativePath: "same.md",
                expectedState: "present",
                expectedBytes: new Uint8Array(Buffer.from("same")),
                expectedExecutable: false,
            },
        ]);
        for (const authority of preview.runtimeReplacementAuthority.files) {
            if (authority.expectedState === "present") {
                expect(authority.expectedIdentity).toMatchObject({ entryKind: "file" });
            }
        }
    });

    it("permits complete managed-file replacement while retaining old-output removal classification", () => {
        const baselineBytes = new Uint8Array(Buffer.from("baseline"));
        for (const relativePath of ["unchanged.md", "update.md", "remove.md", "conflict.md"]) {
            fs.writeFileSync(path.join(root, relativePath), relativePath === "conflict.md" ? "third value" : baselineBytes);
        }

        const baselines = [
            "unchanged.md",
            "update.md",
            "remove.md",
            "conflict.md",
            "missing-conflict.md",
            "missing-remove.md",
        ].map((relativePath) => activeBaseline(relativePath, baselineBytes));
        const preview = capture(
            root,
            plan(
                textFile("unchanged.md", "baseline"),
                textFile("update.md", "updated"),
                textFile("conflict.md", "updated"),
                textFile("missing-conflict.md", "updated"),
            ),
            baselines,
        );

        expect(preview.view.actionState).toBe("ready_apply");
        expect(preview.view.files.map(({ relativePath, changeKind }) => ({ relativePath, changeKind }))).toEqual([
            { relativePath: "conflict.md", changeKind: "update_managed" },
            { relativePath: "missing-conflict.md", changeKind: "create" },
            { relativePath: "missing-remove.md", changeKind: "remove_managed" },
            { relativePath: "remove.md", changeKind: "remove_managed" },
            { relativePath: "unchanged.md", changeKind: "unchanged" },
            { relativePath: "update.md", changeKind: "update_managed" },
        ]);
        expect(preview.view.files.find((file) => file.relativePath === "remove.md")?.desired).toEqual({ state: "missing" });
    });

    it("discloses executable drift without changing the confirmed desired mode", () => {
        const target = path.join(root, "tool.sh");
        fs.writeFileSync(target, "run", { mode: 0o644 });
        const first = capture(root, plan(textFile("tool.sh", "run", true)));
        expect(first.view.files[0]?.changeKind).toBe("replace_unmanaged");
        expect(first.view.files[0]?.current).toMatchObject({ executable: false });
        expect(first.view.files[0]?.desired).toMatchObject({ executable: true });

        fs.chmodSync(target, 0o755);
        const second = capture(root, plan(textFile("tool.sh", "run", true)));
        expect(second.view.files[0]?.changeKind).toBe("establish_baseline");
        expect(second.view.previewFingerprint).toBe(first.view.previewFingerprint);
    });

    it("reviews the exact complete leaf graph while excluding shared parents and sibling leaves", () => {
        fs.mkdirSync(path.join(root, "skills/demo/resources/empty"), { recursive: true });
        fs.mkdirSync(path.join(root, "skills/sibling"), { recursive: true });
        fs.writeFileSync(path.join(root, "skills/demo/SKILL.md"), "old\n");
        fs.writeFileSync(path.join(root, "skills/demo/resources/obsolete.txt"), "remove\n");
        fs.writeFileSync(path.join(root, "skills/sibling/KEEP.md"), "sibling\n");

        const preview = capture(
            root,
            managedPlan(
                "skills/demo",
                textFile("skills/demo/SKILL.md", "new\n"),
                textFile("skills/demo/assets/wanted.txt", "wanted\n"),
            ),
        );

        expect(preview.view.actionState).toBe("requires_unmanaged_replacement");
        expect(preview.view.files.map((file) => [file.relativePath, file.changeKind])).toEqual([
            ["skills/demo/SKILL.md", "replace_unmanaged"],
            ["skills/demo/assets/wanted.txt", "create"],
            ["skills/demo/resources/obsolete.txt", "replace_unmanaged"],
        ]);
        expect(preview.view.directories.map((directory) => [directory.relativePath, directory.changeKind])).toEqual([
            ["skills/demo", "unchanged"],
            ["skills/demo/assets", "create"],
            ["skills/demo/resources", "remove_unmanaged"],
            ["skills/demo/resources/empty", "remove_unmanaged"],
        ]);
        expect(preview.runtimeReplacementAuthority).toMatchObject({
            managedDirectoryBoundaryPaths: ["skills/demo"],
            desiredManagedDirectoryBoundaryPaths: ["skills/demo"],
            unmanagedRemovalPaths: ["skills/demo/resources/obsolete.txt"],
            directoryRemovalPaths: ["skills/demo/resources", "skills/demo/resources/empty"],
        });
        expect(preview.runtimeReplacementAuthority.files.map((file) => file.relativePath)).not.toContain(
            "skills/sibling/KEEP.md",
        );
        expect(preview.runtimeReplacementAuthority.directories.map((directory) => directory.relativePath)).not.toContain(
            "skills",
        );
    });

    it("keeps a confirmed whole-file target valid when only current bytes, mode or existence change", () => {
        const targetPlan = plan(textFile("AGENTS.md", "confirmed version"));
        const initial = capture(root, targetPlan);
        const target = path.join(root, "AGENTS.md");
        fs.writeFileSync(target, "external edit", { mode: 0o755 });
        const edited = capture(root, targetPlan);
        fs.writeFileSync(target, "another external edit");
        fs.chmodSync(target, 0o644);
        const editedAgain = capture(root, targetPlan);

        expect(edited.view.files[0]!.current).not.toEqual(initial.view.files[0]!.current);
        expect(editedAgain.view.files[0]!.current).not.toEqual(edited.view.files[0]!.current);
        expect(edited.view.previewFingerprint).toBe(initial.view.previewFingerprint);
        expect(editedAgain.view.previewFingerprint).toBe(initial.view.previewFingerprint);
        expect(capture(root, plan(textFile("AGENTS.md", "different version"))).view.previewFingerprint).not.toBe(
            initial.view.previewFingerprint,
        );
        expect(capture(root, plan(textFile("OTHER.md", "confirmed version"))).view.previewFingerprint).not.toBe(
            initial.view.previewFingerprint,
        );
    });

    it("binds the complete desired leaf while current descendants appear, disappear or change", () => {
        const targetPlan = managedPlan("skills/demo", textFile("skills/demo/SKILL.md", "confirmed version"));
        const initial = capture(root, targetPlan);
        fs.mkdirSync(path.join(root, "skills/demo/external/empty"), { recursive: true });
        fs.writeFileSync(path.join(root, "skills/demo/external/new.txt"), "external resource");
        const edited = capture(root, targetPlan);
        fs.renameSync(path.join(root, "skills/demo/external"), path.join(root, "skills/demo/renamed"));
        const renamed = capture(root, targetPlan);

        expect(edited.view.files).toHaveLength(2);
        expect(edited.view.directories).toHaveLength(3);
        expect(edited.view.previewFingerprint).toBe(initial.view.previewFingerprint);
        expect(renamed.view.previewFingerprint).toBe(initial.view.previewFingerprint);
        expect(capture(root, plan(...targetPlan.targetFiles)).view.previewFingerprint).not.toBe(initial.view.previewFingerprint);
        const withEmptyDirectory = structuredClone(targetPlan);
        withEmptyDirectory.managedDirectoryBoundaries[0]!.desiredDirectoryPaths = [
            "skills/demo",
            "skills/demo/wanted-empty",
        ] as never;
        expect(capture(root, withEmptyDirectory).view.previewFingerprint).not.toBe(initial.view.previewFingerprint);
    });

    it("continues protecting a removed old output outside the newly confirmed replacement scope", () => {
        const oldBytes = new TextEncoder().encode("previous output");
        fs.writeFileSync(path.join(root, "old.md"), oldBytes);
        const baseline = [activeBaseline("old.md", oldBytes)];
        const targetPlan = plan(textFile("AGENTS.md", "confirmed version"));
        const initial = capture(root, targetPlan, baseline);
        fs.writeFileSync(path.join(root, "old.md"), "external edit to removed output");
        const edited = capture(root, targetPlan, baseline);

        expect(edited.view.previewFingerprint).not.toBe(initial.view.previewFingerprint);
        expect(edited.view.actionState).toBe("blocked_managed_conflict");
        expect(edited.view.files.find((file) => file.relativePath === "old.md")!.changeKind).toBe("managed_conflict");
    });

    it("binds a shared-container patch to the actual container used to preserve unrelated fields", () => {
        const bytes = new TextEncoder().encode('{"instructions":[],"external":"keep"}');
        fs.writeFileSync(path.join(root, "config.jsonc"), bytes);
        const targetPlan = plan({
            ...textFile("config.jsonc", '{"instructions":["desired"],"external":"keep"}'),
            containerPatchPreimageHash: sha256Bytes(bytes),
        });
        const initial = capture(root, targetPlan);
        expect(initial.view.replacementScope).toEqual({ filePaths: [], directoryPaths: [] });
        fs.writeFileSync(path.join(root, "config.jsonc"), '{"instructions":[],"external":"new"}');
        expectPreviewError(() => capture(root, targetPlan), "render.preview_container_changed");

        const missingPlan = plan({ ...textFile("missing.jsonc", "{}"), containerPatchPreimageHash: null });
        expect(capture(root, missingPlan).view.files[0]!.current).toEqual({ state: "missing" });
        fs.writeFileSync(path.join(root, "missing.jsonc"), "{}");
        expectPreviewError(() => capture(root, missingPlan), "render.preview_container_changed");
    });
});
