/** Compiled patch and complete replacement scopes remain separate authority boundaries. */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { validateTargetPlanPaths } from "../../src/deployment/deployment-execution-validation";
import { applyRuntimeReplacementAuthority } from "../../src/deployment/deployment-target-replacement";
import type { TargetPlan } from "../../src/deployment/deployment-target-plan";
import { publicationFixture } from "./fixtures/deployment-publication-fixtures";

describe("complete replacement plan validation", () => {
    it("rejects malformed patch preimages and shared fields inside a complete-directory plan", () => {
        const h = publicationFixture();
        const fingerprint = h.journal.compilationFingerprint;
        const file = {
            relativePath: "leaf/shared.json",
            content: { contentKind: "text" as const, text: "{}" },
            executable: false,
            outputUnitFingerprint: fingerprint,
            materializationFingerprint: fingerprint,
            semanticRefFingerprints: [],
            sectionBindings: [],
            containerPatchPreimageHash: "invalid",
        };
        const plan: TargetPlan = { schemaVersion: 1, managedDirectoryBoundaries: [], targetFiles: [file] };
        expect(validateTargetPlanPaths(plan)).toBe("shared-container patch preimage must be a content hash or missing state");
        file.containerPatchPreimageHash = fingerprint;
        expect(validateTargetPlanPaths(plan)).toBeNull();
        plan.managedDirectoryBoundaries = [{ relativePath: "sibling", outputUnitFingerprint: fingerprint }];
        expect(validateTargetPlanPaths(plan)).toBeNull();
        plan.managedDirectoryBoundaries = [{ relativePath: "leaf", outputUnitFingerprint: fingerprint }];
        expect(validateTargetPlanPaths(plan)).toBe(
            "shared-container patches cannot be included in a complete-directory replacement",
        );
        expect(fs.readFileSync(path.join(h.target, h.leaf, "SKILL.md"), "utf8")).toBe("# original\n");
    });

    it.each([
        { filePaths: ["leaf/SKILL.md", "leaf/SKILL.md"], directoryPaths: [] },
        { filePaths: [], directoryPaths: ["leaf", "leaf"] },
        { filePaths: ["unowned.md"], directoryPaths: [] },
        { filePaths: [], directoryPaths: ["unowned"] },
    ])("rejects a scope that does not match unique desired ownership: %j", (replacementScope) => {
        const h = publicationFixture();
        const result = applyRuntimeReplacementAuthority(
            h.journal.entries,
            h.ctx,
            {
                ...h.preview.runtimeReplacementAuthority,
                replacementScope,
            },
            h.input.desiredDirectoryPaths,
        );
        expect(result).toEqual({
            status: "conflict",
            reason: "complete replacement scope differs from the desired target closure",
        });
        expect(fs.readFileSync(path.join(h.target, h.leaf, "SKILL.md"), "utf8")).toBe("# original\n");
    });

    it("refuses a complete target file that became a directory while capturing recovery state", () => {
        const h = publicationFixture();
        const file = path.join(h.target, h.leaf, "SKILL.md");
        fs.renameSync(file, path.join(h.root, "retained-original.md"));
        fs.mkdirSync(file);
        const result = applyRuntimeReplacementAuthority(
            h.journal.entries,
            h.ctx,
            h.preview.runtimeReplacementAuthority,
            h.input.desiredDirectoryPaths,
        );
        expect(result.status).toBe("conflict");
        expect(fs.statSync(file).isDirectory()).toBe(true);
        expect(fs.readFileSync(path.join(h.root, "retained-original.md"), "utf8")).toBe("# original\n");
    });
});
