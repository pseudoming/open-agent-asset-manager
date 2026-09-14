import { describe, expect, it, vi } from "vitest";
import { buildMarkdownLinkReferences } from "../src";

describe("runtime-neutral Markdown link mechanics", () => {
    it("scans links and delegates only target policy to the provider", () => {
        const normalizeRelativeTarget = vi.fn((target: string, parent: string) =>
            target.startsWith("../") ? `assets/${target.slice(3)}` : `${parent}/${target}`,
        );
        const isExternalTarget = vi.fn((target: string) => target.startsWith("https://"));
        const references = buildMarkdownLinkReferences({
            text: "[local](guide.md#intro) [asset](../logo.png) [web](https://example.com/x) [missing](no.md)",
            logicalPaths: new Set(["docs/guide.md", "assets/logo.png"]),
            sourceLogicalPath: "docs/README.md",
            normalizeRelativeTarget,
            isExternalTarget,
        });

        expect(references).toEqual([
            {
                kind: "link",
                rawTarget: "guide.md",
                required: false,
                diagnostics: [],
                resolution: "resolved_version_file",
                targetLogicalPath: "docs/guide.md",
            },
            {
                kind: "link",
                rawTarget: "../logo.png",
                required: false,
                diagnostics: [],
                resolution: "resolved_version_file",
                targetLogicalPath: "assets/logo.png",
            },
            {
                kind: "link",
                rawTarget: "https://example.com/x",
                required: false,
                diagnostics: [],
                resolution: "external",
            },
            {
                kind: "link",
                rawTarget: "no.md",
                required: false,
                diagnostics: [],
                resolution: "unresolved",
            },
        ]);
        expect(normalizeRelativeTarget).toHaveBeenNthCalledWith(1, "guide.md", "docs");
        expect(normalizeRelativeTarget).toHaveBeenCalledTimes(4);
        expect(isExternalTarget).toHaveBeenCalledTimes(2);
    });

    it("keeps malformed and empty Markdown targets inert", () => {
        const normalizeRelativeTarget = vi.fn(() => null);
        const isExternalTarget = vi.fn(() => false);
        for (const text of ["plain", "[unfinished", "[x](unfinished", "[x](#fragment)"]) {
            expect(
                buildMarkdownLinkReferences({
                    text,
                    logicalPaths: new Set(),
                    sourceLogicalPath: "README.md",
                    normalizeRelativeTarget,
                    isExternalTarget,
                }),
            ).toEqual([]);
        }
        expect(normalizeRelativeTarget).not.toHaveBeenCalled();
        expect(isExternalTarget).not.toHaveBeenCalled();
    });
});
