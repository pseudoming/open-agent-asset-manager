import { describe, expect, it } from "vitest";
import { isPackagedZcodeCompleteDirectoryPreview } from "../src/renderer/client/packaged-zcode-target-proof";
import { packagedZcodeSkillPreviewFixture } from "./packaged-zcode-target-proof-fixtures";

describe("packaged ZCode complete-directory preview proof", () => {
    it("accepts only the exact five-directory/four-file graph under one managed boundary", () => {
        const preview = packagedZcodeSkillPreviewFixture();
        expect(isPackagedZcodeCompleteDirectoryPreview(preview)).toBe(true);
        expect(isPackagedZcodeCompleteDirectoryPreview({ ...preview, schemaVersion: 1 })).toBe(false);
        expect(isPackagedZcodeCompleteDirectoryPreview({ ...preview, files: preview.files.slice(1) })).toBe(false);
        expect(isPackagedZcodeCompleteDirectoryPreview({ ...preview, directories: preview.directories.slice(1) })).toBe(false);
        expect(
            isPackagedZcodeCompleteDirectoryPreview({
                ...preview,
                directories: [
                    ...preview.directories.slice(0, -1),
                    { managedBoundaryRelativePath: ".zcode/skills/sibling", relativePath: "sibling" },
                ],
            }),
        ).toBe(false);
    });
});
