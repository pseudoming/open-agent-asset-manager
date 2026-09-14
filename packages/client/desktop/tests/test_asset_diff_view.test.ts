import { cleanup, fireEvent, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
    createDesktopPresentationSnapshot,
    DEFAULT_DESKTOP_PRESENTATION_PREFERENCES,
} from "../src/presentation/presentation-preferences";
import { AssetDiffView, type AssetDiffViewProps } from "../src/renderer/features/project-library/AssetDiffView";
import { createDesktopPresentationTestBridge, renderWithPresentation } from "./desktop-presentation-test-harness";

const FILE = {
    fileId: "11111111-1111-4111-8111-111111111111",
    logicalPath: "AGENTS.md",
    role: "entry",
    mediaType: "text/markdown",
    contentKind: "text",
    contentHash: "a".repeat(64),
    byteLength: 10,
    executable: false,
} as const;

afterEach(cleanup);

describe("Asset Version diff presentation", () => {
    it.each([
        ["en", "Reference: Version 2 → selected: Version 1", "Modified"],
        ["de", "Vergleich: Version 2 → ausgewählt: Version 1", "Geändert"],
    ] as const)("labels completed comparison identities and preserves resource paths in %s", (locale, direction, change) => {
        const comparison: AssetDiffViewProps["comparison"] = {
            schemaVersion: 1,
            assetId: "22222222-2222-4222-8222-222222222222",
            left: { versionId: "33333333-3333-4333-8333-333333333333", versionFingerprint: "a".repeat(64) },
            right: { versionId: "44444444-4444-4444-8444-444444444444", versionFingerprint: "b".repeat(64) },
            files: ["GUIDANCE.md", "references/GUIDANCE.md"].map((logicalPath) => ({
                logicalPath,
                changeKind: "modified",
                left: { state: "present", file: { ...FILE, logicalPath } },
                right: { state: "present", file: { ...FILE, logicalPath } },
            })),
            selectedFile: { comparisonKind: "not_requested" },
        };
        const versions = [comparison.right, comparison.left].map((ref, index) => ({
            assetId: comparison.assetId,
            versionId: ref.versionId,
            revision: index + 1,
            fingerprint: ref.versionFingerprint,
            originAuthorityFingerprint: "c".repeat(64),
            versionCanonicalContentFingerprint: "d".repeat(64),
            status: "complete" as const,
            changeKind: "create" as const,
            sourceVersionId: "",
            sourceDeploymentId: "",
            changeNote: "",
            fileCount: 2,
            createdAt: 1,
        }));
        const props: AssetDiffViewProps = {
            comparison,
            mode: "unified",
            asset: { kind: "Guidance", displayName: "Project rules" },
            versions,
        };
        const view = renderWithPresentation(
            createElement(AssetDiffView, props),
            createDesktopPresentationTestBridge(
                createDesktopPresentationSnapshot(
                    { ...DEFAULT_DESKTOP_PRESENTATION_PREFERENCES, language: locale },
                    ["en-US"],
                    false,
                ),
            ),
        );
        expect(screen.getByText(direction)).not.toBeNull();
        expect(screen.getAllByText(change)).toHaveLength(2);
        expect(screen.getByText("Project rules")).not.toBeNull();
        expect(screen.getByText("references/GUIDANCE.md")).not.toBeNull();
        expect(screen.queryByText("GUIDANCE.md")).toBeNull();
        view.rerender(createElement(AssetDiffView, { ...props, versions: [...versions].reverse() }));
        expect(screen.getByText(direction).getAttribute("data-oaam-compare-left-version")).toBe(comparison.left.versionId);
        // A same-ID observation with a different fingerprint must not relabel this completed result.
        view.rerender(
            createElement(AssetDiffView, {
                ...props,
                versions: versions.map((version) => ({ ...version, fingerprint: "e".repeat(64), revision: 99 })),
            }),
        );
        expect(screen.queryByText(direction)).toBeNull();
        expect(view.container.textContent).not.toContain("99");
    });

    it("renders the file graph and omits a selected-file panel when no member was requested", () => {
        renderWithPresentation(
            createElement(AssetDiffView, {
                comparison: {
                    schemaVersion: 1,
                    assetId: "22222222-2222-4222-8222-222222222222",
                    left: { versionId: "33333333-3333-4333-8333-333333333333", versionFingerprint: "a".repeat(64) },
                    right: { versionId: "44444444-4444-4444-8444-444444444444", versionFingerprint: "b".repeat(64) },
                    files: [
                        {
                            logicalPath: "AGENTS.md",
                            changeKind: "modified",
                            left: { state: "present", file: FILE },
                            right: { state: "present", file: FILE },
                        },
                    ],
                    selectedFile: { comparisonKind: "not_requested" },
                },
                mode: "unified",
            }),
        );

        expect(screen.getByText("File changes")).not.toBeNull();
        expect(screen.getByText("Modified")).not.toBeNull();
        expect(screen.queryByText("Selected file")).toBeNull();
    });

    it("renders metadata-only selected members without inventing text", () => {
        renderWithPresentation(
            createElement(AssetDiffView, {
                comparison: {
                    schemaVersion: 1,
                    assetId: "22222222-2222-4222-8222-222222222222",
                    left: { versionId: "33333333-3333-4333-8333-333333333333", versionFingerprint: "a".repeat(64) },
                    right: { versionId: "44444444-4444-4444-8444-444444444444", versionFingerprint: "b".repeat(64) },
                    files: [],
                    selectedFile: {
                        comparisonKind: "metadata",
                        logicalPath: "binary.bin",
                        left: { state: "missing" },
                        right: { state: "present", file: { ...FILE, logicalPath: "binary.bin", contentKind: "binary" } },
                    },
                },
                mode: "unified",
            }),
        );

        expect(screen.getByText(/no rendered text diff/u)).not.toBeNull();
    });

    it("renders unified and side-by-side text hunks with folds and every line kind", () => {
        const comparison = {
            schemaVersion: 1,
            assetId: "22222222-2222-4222-8222-222222222222",
            left: { versionId: "33333333-3333-4333-8333-333333333333", versionFingerprint: "a".repeat(64) },
            right: { versionId: "44444444-4444-4444-8444-444444444444", versionFingerprint: "b".repeat(64) },
            files: [],
            selectedFile: {
                comparisonKind: "text" as const,
                logicalPath: "AGENTS.md",
                left: { state: "present" as const, file: FILE },
                right: { state: "present" as const, file: FILE },
                algorithm: "myers" as const,
                leftLineCount: 80,
                rightLineCount: 81,
                hunks: [
                    {
                        leftStart: 12,
                        leftLineCount: 3,
                        rightStart: 12,
                        rightLineCount: 4,
                        lines: [
                            { lineKind: "add" as const, text: "inserted-first", rightLine: 12 },
                            { lineKind: "context" as const, text: "before", leftLine: 12, rightLine: 13 },
                            { lineKind: "remove" as const, text: "old", leftLine: 13 },
                            { lineKind: "add" as const, text: "new", rightLine: 14 },
                            { lineKind: "add" as const, text: "new-extra", rightLine: 15 },
                            { lineKind: "remove" as const, text: "old-only", leftLine: 14 },
                        ],
                    },
                    {
                        leftStart: 50,
                        leftLineCount: 1,
                        rightStart: 51,
                        rightLineCount: 1,
                        lines: [{ lineKind: "context" as const, text: "later", leftLine: 50, rightLine: 51 }],
                    },
                ],
            },
        };
        const rendered = renderWithPresentation(createElement(AssetDiffView, { comparison, mode: "unified" }));
        expect(screen.getByRole("table", { name: "Unified" })).not.toBeNull();
        expect(screen.getAllByText("+")).toHaveLength(3);
        expect(screen.getAllByText("-")).toHaveLength(2);
        expect(screen.getAllByText(/unchanged lines folded/u).length).toBeGreaterThanOrEqual(3);

        rendered.rerender(createElement(AssetDiffView, { comparison, mode: "side_by_side" }));
        expect(screen.getByRole("table", { name: "Side by side" })).not.toBeNull();
        expect(screen.getAllByText("old").length).toBe(1);
        expect(screen.getAllByText("new").length).toBe(1);
        expect(screen.getByText("inserted-first")).not.toBeNull();
        expect(screen.getByText("new-extra")).not.toBeNull();
        expect(screen.getByText("old-only")).not.toBeNull();
        const replacement = rendered.container.querySelector('[data-line-kind="replace"]');
        expect(replacement?.textContent).toContain("old");
        expect(replacement?.textContent).toContain("new");
    });

    it("renders an exact empty text comparison without inventing folded lines", () => {
        renderWithPresentation(
            createElement(AssetDiffView, {
                comparison: {
                    schemaVersion: 1,
                    assetId: "22222222-2222-4222-8222-222222222222",
                    left: { versionId: "33333333-3333-4333-8333-333333333333", versionFingerprint: "a".repeat(64) },
                    right: { versionId: "44444444-4444-4444-8444-444444444444", versionFingerprint: "b".repeat(64) },
                    files: [],
                    selectedFile: {
                        comparisonKind: "text",
                        logicalPath: "empty.md",
                        left: { state: "present", file: { ...FILE, logicalPath: "empty.md", byteLength: 0 } },
                        right: { state: "present", file: { ...FILE, logicalPath: "empty.md", byteLength: 0 } },
                        algorithm: "myers",
                        leftLineCount: 0,
                        rightLineCount: 0,
                        hunks: [],
                    },
                },
                mode: "unified",
            }),
        );
        expect(screen.getByText("The selected text is identical in both Versions.")).not.toBeNull();
        expect(screen.queryByRole("table", { name: "Unified" })).toBeNull();
        expect(screen.queryByText(/unchanged lines folded/u)).toBeNull();
    });

    it("keeps a complete large comparison but renders file and diff rows in explicit bounded batches", () => {
        const files = Array.from({ length: 201 }, (_, index) => ({
            logicalPath: `file-${String(index).padStart(3, "0")}.md`,
            changeKind: "modified" as const,
            left: { state: "present" as const, file: { ...FILE, logicalPath: `file-${String(index).padStart(3, "0")}.md` } },
            right: { state: "present" as const, file: { ...FILE, logicalPath: `file-${String(index).padStart(3, "0")}.md` } },
        }));
        const lines = Array.from({ length: 501 }, (_, index) => ({
            lineKind: "remove" as const,
            text: `old-${index}`,
            leftLine: index + 1,
        }));
        const rendered = renderWithPresentation(
            createElement(AssetDiffView, {
                comparison: {
                    schemaVersion: 1,
                    assetId: "22222222-2222-4222-8222-222222222222",
                    left: { versionId: "33333333-3333-4333-8333-333333333333", versionFingerprint: "a".repeat(64) },
                    right: { versionId: "44444444-4444-4444-8444-444444444444", versionFingerprint: "b".repeat(64) },
                    files,
                    selectedFile: {
                        comparisonKind: "text",
                        logicalPath: "AGENTS.md",
                        left: { state: "present", file: FILE },
                        right: { state: "present", file: FILE },
                        algorithm: "coarse_complete",
                        leftLineCount: 501,
                        rightLineCount: 0,
                        hunks: [
                            {
                                leftStart: 1,
                                leftLineCount: 501,
                                rightStart: 1,
                                rightLineCount: 0,
                                lines,
                            },
                        ],
                    },
                },
                mode: "unified",
            }),
        );

        expect(screen.queryByText("file-200.md")).toBeNull();
        expect(screen.queryByText("old-500")).toBeNull();
        expect(rendered.container.querySelectorAll(".asset-diff-line")).toHaveLength(500);
        fireEvent.click(screen.getByRole("button", { name: "Show more files (200 of 201)" }));
        fireEvent.click(screen.getByRole("button", { name: "Show more diff lines (500 of 501)" }));
        expect(screen.getByText("file-200.md")).not.toBeNull();
        expect(screen.getByText("old-500")).not.toBeNull();
        expect(rendered.container.querySelectorAll(".asset-diff-line")).toHaveLength(501);
    });
});
