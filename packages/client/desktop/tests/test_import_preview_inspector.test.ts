import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportPreviewInspector } from "../src/renderer/features/import-review/ImportPreviewInspector";
import { ImportReviewWorkspace } from "../src/renderer/features/import-review/ImportReviewWorkspace";
import { renderWithPresentation } from "./desktop-presentation-test-harness";
import { candidate, controller, fakeImportClient, PREVIEW, READ_PARAMS } from "./import-review-test-fixtures";

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("Desktop import preview inspector", () => {
    it("opens a multi-file candidate from one view action and navigates its existing file list", async () => {
        const client = fakeImportClient({
            previewImport: vi.fn(async () => ({
                status: "complete",
                value: {
                    ...PREVIEW,
                    candidates: [
                        candidate("review-notes", "Skill", {
                            fileCount: 2,
                            logicalPaths: ["SKILL.md", "resources/checklist.md"],
                        }),
                    ],
                },
                diagnostics: [],
            })),
        });
        const review = controller(client);
        const { container } = renderWithPresentation(createElement(ImportReviewWorkspace, { controller: review }));
        await act(async () => review.prepare(READ_PARAMS));
        expect(container.querySelectorAll(".import-candidate-files button")).toHaveLength(1);
        expect(screen.queryByRole("complementary")).toBeNull();
        const trigger = screen.getByRole("button", { name: "View review-notes" });
        trigger.focus();
        fireEvent.click(trigger);
        const inspector = screen.getByRole("complementary");
        expect(document.activeElement).toBe(screen.getByRole("tab", { name: "SKILL.md" }));
        const fileList = await screen.findByRole("navigation", { name: "Files in this Asset" });
        expect(within(fileList).getAllByRole("button")).toHaveLength(2);
        fireEvent.click(within(fileList).getByRole("button", { name: "resources/checklist.md" }));
        await vi.waitFor(() =>
            expect(client.getImportPreviewDetail).toHaveBeenLastCalledWith({
                previewToken: "preview-token",
                candidateId: "review-notes",
                logicalPath: "resources/checklist.md",
            }),
        );
        expect(screen.getByRole("tab", { name: "checklist.md" }).getAttribute("aria-selected")).toBe("true");
        expect(document.activeElement).toBe(screen.getByRole("tab", { name: "checklist.md" }));
        fireEvent.click(screen.getByRole("button", { name: "Hide file list" }));
        expect(screen.queryByRole("navigation", { name: "Files in this Asset" })).toBeNull();
        expect(screen.getByRole("tab", { name: "checklist.md" })).not.toBeNull();
        fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Home" });
        expect(document.activeElement).toBe(screen.getByRole("tab", { name: "SKILL.md" }));
        expect(screen.getByRole("complementary")).toBe(inspector);
        fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowRight" });
        expect(document.activeElement).toBe(screen.getByRole("tab", { name: "checklist.md" }));
        fireEvent.click(screen.getByRole("button", { name: "Close checklist.md" }));
        expect(document.activeElement).toBe(screen.getByRole("tab", { name: "SKILL.md" }));
        fireEvent.click(screen.getByRole("button", { name: "Close SKILL.md" }));
        expect(screen.queryByRole("complementary")).toBeNull();
        expect(document.activeElement).toBe(trigger);
    });

    it("updates the inspector and page width together when the viewport shrinks and restores the preferred width", async () => {
        vi.stubGlobal("innerWidth", 3840);
        const review = controller(fakeImportClient());
        const { container } = renderWithPresentation(
            createElement(
                "div",
                { className: "guided-import-shell" },
                createElement(ImportReviewWorkspace, { controller: review }),
            ),
        );
        await act(async () => review.prepare(READ_PARAMS));
        fireEvent.click(screen.getByRole("button", { name: "View workflow" }));
        const inspector = screen.getByRole("complementary");
        const page = container.querySelector<HTMLElement>(".guided-import-shell");
        for (const [viewport, expected] of [
            [3840, "1382px"],
            [1080, "760px"],
            [860, "540px"],
            [3840, "1382px"],
        ] as const) {
            act(() => {
                vi.stubGlobal("innerWidth", viewport);
                globalThis.dispatchEvent(new Event("resize"));
            });
            expect(inspector.style.getPropertyValue("--oaam-file-inspector-width")).toBe(expected);
            expect(page?.style.getPropertyValue("--import-preview-rail-width")).toBe(expected);
        }
    });

    it("explains incomplete Assets and keeps a tabbed, revealable right-side file inspector", async () => {
        const revealImportPreviewFile = vi.fn(async () => ({ status: "complete" as const }));
        const client = fakeImportClient({
            previewImport: vi.fn(async () => ({
                status: "complete",
                value: {
                    ...PREVIEW,
                    candidates: [
                        ...PREVIEW.candidates,
                        candidate("incomplete", "Skill", {
                            status: "incomplete",
                            logicalPaths: ["SKILL.md"],
                            diagnosticCodes: ["antigravity.skill_trigger_frontmatter_unverified"],
                        }),
                    ],
                },
                diagnostics: [],
            })),
        });
        const review = controller(client);
        renderWithPresentation(
            createElement(
                "div",
                { className: "guided-import-shell" },
                createElement(ImportReviewWorkspace, {
                    controller: review,
                    revealImportPreviewFile,
                }),
            ),
        );

        await act(async () => review.prepare(READ_PARAMS));
        for (const name of ["workflow", "subagent", "skill"]) {
            expect((screen.getByRole("checkbox", { name: `Select ${name}` }) as HTMLInputElement).checked).toBe(true);
        }
        expect((screen.getByRole("checkbox", { name: "Select incomplete" }) as HTMLInputElement).disabled).toBe(true);
        expect(screen.getByText(/uses a trigger setting/u)).not.toBeNull();
        expect(screen.getByText(/cannot yet confirm how Antigravity handles it/u)).not.toBeNull();
        expect(screen.getByText(/other selected Assets are unaffected/u)).not.toBeNull();
        expect(screen.queryByText(/recognized only part of this Asset/u)).toBeNull();
        expect(screen.queryByText(/complete it in the original AI coding tool/u)).toBeNull();
        expect(screen.queryByRole("combobox", { name: /How to save/u })).toBeNull();
        expect(screen.queryByText("Choose a destination")).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "View workflow" }));
        await vi.waitFor(() => expect(screen.queryByRole("complementary", { name: "Scanned file preview" })).not.toBeNull());
        const inspector = screen.getByRole("complementary", { name: "Scanned file preview" });
        expect(screen.queryByText("Scan result")).toBeNull();
        expect(within(inspector).queryByRole("heading")).toBeNull();
        const workflowTab = within(inspector).getByRole("tab", { name: "workflow.md" });
        expect(workflowTab.getAttribute("aria-selected")).toBe("true");
        expect(workflowTab.getAttribute("title")).toBe("workflow/workflow.md");
        await vi.waitFor(() => expect(inspector.querySelector(".import-preview-source")?.textContent).toContain("# reviewed"));
        expect(inspector.querySelector(".import-preview-document")).not.toBeNull();
        expect(within(inspector).getByRole("region", { name: "File source with line numbers" })).not.toBeNull();
        expect(inspector.querySelectorAll(".import-preview-line-number")).toHaveLength(1);
        expect(within(inspector).queryByText("Technical details")).toBeNull();
        expect(within(inspector).getAllByText("workflow.md")).toHaveLength(1);

        fireEvent.click(within(inspector).getByRole("button", { name: "Preview Markdown" }));
        expect(within(inspector).getByRole("region", { name: "Rendered Markdown preview" })).not.toBeNull();
        expect(within(inspector).getByRole("heading", { name: "reviewed" })).not.toBeNull();
        fireEvent.click(within(inspector).getByRole("button", { name: "Show Markdown source" }));
        expect(within(inspector).getByRole("region", { name: "File source with line numbers" })).not.toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "View subagent" }));
        await vi.waitFor(() =>
            expect(screen.getByRole("tab", { name: "subagent.md" }).getAttribute("aria-selected")).toBe("true"),
        );
        expect(screen.getAllByRole("tab")).toHaveLength(2);

        fireEvent.click(screen.getByRole("tab", { name: "workflow.md" }));
        await vi.waitFor(() =>
            expect(screen.getByRole("tab", { name: "workflow.md" }).getAttribute("aria-selected")).toBe("true"),
        );
        fireEvent.click(screen.getByRole("tab", { name: "subagent.md" }));

        fireEvent.click(screen.getByRole("button", { name: "Show file list" }));
        const fileList = screen.getByRole("navigation", { name: "Files in this Asset" });
        const listedFile = fileList.querySelector("button");
        if (listedFile === null) throw new Error("Expected one file-list button");
        fireEvent.click(listedFile);
        fireEvent.click(screen.getByRole("button", { name: "Open containing folder" }));
        await vi.waitFor(() => expect(screen.queryByText("Opened the containing folder in File Explorer.")).not.toBeNull());
        expect(revealImportPreviewFile).toHaveBeenCalledWith({
            previewToken: "preview-token",
            candidateId: "subagent",
            logicalPath: "subagent.md",
        });

        revealImportPreviewFile.mockResolvedValueOnce({ status: "failed", code: "unavailable" });
        fireEvent.click(screen.getByRole("button", { name: "Open containing folder" }));
        await vi.waitFor(() =>
            expect(screen.queryByText("The containing folder could not be opened. Scan again and retry.")).not.toBeNull(),
        );
        revealImportPreviewFile.mockRejectedValueOnce(new Error("transport failed"));
        fireEvent.click(screen.getByRole("button", { name: "Open containing folder" }));
        await vi.waitFor(() => expect(revealImportPreviewFile).toHaveBeenCalledTimes(3));

        fireEvent.click(screen.getByRole("button", { name: "Close subagent.md" }));
        expect(screen.getByRole("tab", { name: "workflow.md" }).getAttribute("aria-selected")).toBe("true");
        fireEvent.click(screen.getByRole("button", { name: "Close side preview" }));
        expect(screen.queryByRole("complementary", { name: "Scanned file preview" })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Show side preview" }));
        expect(screen.getByRole("complementary", { name: "Scanned file preview" })).not.toBeNull();

        const scrollOwner = document.querySelector<HTMLElement>(".guided-import-shell");
        if (scrollOwner === null) throw new Error("Expected guided-import scroll owner");
        Object.defineProperties(scrollOwner, {
            clientHeight: { configurable: true, value: 300 },
            scrollHeight: { configurable: true, value: 900 },
        });
        scrollOwner.scrollTop = 320;
        fireEvent.click(screen.getByRole("checkbox", { name: "Select workflow" }));
        expect(scrollOwner.scrollTop).toBe(320);
        expect(screen.queryByRole("complementary", { name: "Scanned file preview" })).toBeNull();
        expect(screen.getByRole("heading", { name: "Choose Assets and any required related Assets" })).not.toBeNull();
        expect(screen.getByRole("button", { name: "Import selected Assets" })).not.toBeNull();
    });

    it("formats valid JSON and exposes the bounded keyboard resize separator", () => {
        const resizeRail = vi.fn();
        const jsonCandidate = candidate("settings", "Rule", { logicalPaths: ["settings.json"] });
        renderWithPresentation(
            createElement(ImportPreviewInspector, {
                previewToken: "preview-token",
                candidates: [jsonCandidate],
                tabs: [
                    {
                        tabKey: "settings\0settings.json",
                        candidateId: "settings",
                        logicalPath: "settings.json",
                        label: "settings.json",
                    },
                ],
                activeTabKey: "settings\0settings.json",
                detail: {
                    status: "ready",
                    value: {
                        candidateId: "settings",
                        logicalPath: "settings.json",
                        mediaType: "application/json",
                        contentKind: "text",
                        text: { text: '{"enabled":true,"name":"OAAM"}', byteLength: 30, truncated: false },
                        byteLength: 30,
                        contentHash: "a".repeat(64),
                    },
                },
                fileListVisible: false,
                busy: false,
                railWidth: 400,
                onSelectTab: vi.fn(),
                onCloseTab: vi.fn(),
                onOpenFile: vi.fn(),
                onToggleFileList: vi.fn(),
                onResizeRail: resizeRail,
                onClose: vi.fn(),
            }),
        );

        const inspector = screen.getByRole("complementary", { name: "Scanned file preview" });
        expect(inspector.querySelectorAll(".import-preview-line-number")).toHaveLength(1);
        expect(inspector.querySelectorAll(".import-preview-token-property")).toHaveLength(2);
        const formatJson = within(inspector).getByRole("button", { name: "Format JSON" });
        expect(formatJson.querySelector("[data-oaam-icon='format']")).not.toBeNull();
        fireEvent.click(formatJson);
        expect(inspector.querySelectorAll(".import-preview-line-number")).toHaveLength(4);
        expect(inspector.querySelector(".import-preview-token-literal")?.textContent).toBe("true");
        const showJsonSource = within(inspector).getByRole("button", { name: "Show JSON source" });
        expect(showJsonSource.querySelector("[data-oaam-icon='source']")).not.toBeNull();
        fireEvent.click(showJsonSource);
        expect(inspector.querySelectorAll(".import-preview-line-number")).toHaveLength(1);
        const wrapLines = within(inspector).getByRole("button", { name: "Wrap long lines" });
        expect(wrapLines.querySelector("[data-oaam-icon='wrap']")).not.toBeNull();
        fireEvent.click(wrapLines);
        expect(inspector.querySelector(".import-preview-source")?.getAttribute("data-soft-wrap")).toBe("true");
        expect(within(inspector).getByRole("button", { name: "Keep lines unwrapped" })).not.toBeNull();

        const separator = within(inspector).getByRole("separator", { name: "Resize file preview" });
        expect(separator.getAttribute("aria-valuenow")).toBe("400");
        fireEvent.keyDown(separator, { key: "ArrowLeft" });
        expect(resizeRail).toHaveBeenLastCalledWith(408);
    });
});
