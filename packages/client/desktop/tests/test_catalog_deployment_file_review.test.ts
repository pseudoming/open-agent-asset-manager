import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogDeploymentPreviewFiles } from "../src/renderer/features/catalog-deployment/CatalogDeploymentPreviewFiles";
import { CatalogPreviewTextDiff } from "../src/renderer/features/catalog-deployment/CatalogPreviewTextDiff";
import type { RenderPreviewView } from "../src/renderer/features/catalog-deployment/catalog-deployment-model";
import { renderWithPresentation } from "./desktop-presentation-test-harness";

type PreviewFile = RenderPreviewView["files"][number];
const present = (text: string): PreviewFile["current"] => ({
    state: "present",
    contentKind: "text",
    contentHash: "a".repeat(64),
    byteSize: Buffer.byteLength(text),
    executable: false,
    text,
});
const files: RenderPreviewView["files"] = [
    {
        relativePath: "guide.md",
        baselineState: "managed",
        changeKind: "update_managed",
        current: present("# Before\n"),
        desired: present("# After\n"),
    },
    {
        relativePath: "new.md",
        baselineState: "unmanaged",
        changeKind: "create",
        current: { state: "missing" },
        desired: present("new\n"),
    },
    {
        relativePath: "old.md",
        baselineState: "managed",
        changeKind: "remove_managed",
        current: present("old\n"),
        desired: { state: "missing" },
    },
    {
        relativePath: "marker.bin",
        baselineState: "managed",
        changeKind: "unchanged",
        current: {
            state: "present",
            contentKind: "binary",
            contentHash: "b".repeat(64),
            byteSize: 8,
            executable: false,
        },
        desired: { state: "missing" },
    },
];
const directories: RenderPreviewView["directories"] = [
    {
        managedBoundaryRelativePath: "empty",
        relativePath: "empty",
        baselineState: "unmanaged",
        changeKind: "create",
        currentState: "missing",
        desiredState: "present",
    },
];

afterEach(cleanup);

describe("Deployment file review", () => {
    it("reviews exact text and directory changes in one side inspector with internal snapshot tabs", () => {
        const onOpenReview = vi.fn();
        const { container } = renderWithPresentation(
            createElement(
                "div",
                { className: "deployment-page" },
                createElement(CatalogDeploymentPreviewFiles, { files, directories, onOpenReview }),
            ),
        );
        const page = container.querySelector<HTMLElement>(".deployment-page");
        expect(screen.queryByRole("complementary")).toBeNull();
        const directoryRow = container.querySelector('[data-oaam-preview-entry-kind="directory"]')!;
        expect(directoryRow.textContent).toContain("Create this folder");
        expect(directoryRow.querySelector("button")).toBeNull();
        const trigger = screen.getByRole("button", { name: "View guide.md" });
        fireEvent.click(trigger);
        expect(onOpenReview).toHaveBeenCalledOnce();
        const inspector = screen.getByRole("complementary", { name: "Files and folders to be changed" });
        expect(page?.dataset.fileInspectorOpen).toBe("true");
        expect(inspector.querySelector('[data-line-kind="remove"] code')?.textContent).toBe("# Before\n");
        expect(inspector.querySelector('[data-line-kind="add"] code')?.textContent).toBe("# After\n");
        expect(inspector.textContent).toContain("Showing file content captured for this preview.");
        fireEvent.click(within(inspector).getByRole("button", { name: "Open current file in a tab" }));
        expect(inspector.querySelector('[data-oaam-preview-text-kind="current"]')?.textContent).toContain("# Before");
        fireEvent.click(within(inspector).getByRole("button", { name: "Open desired file in a tab" }));
        expect(inspector.querySelector('[data-oaam-preview-text-kind="desired"]')?.textContent).toContain("# After");
        expect(within(inspector).getAllByRole("tab")).toHaveLength(3);
        fireEvent.click(within(inspector).getByRole("tab", { name: "Current guide.md" }));
        expect(inspector.querySelector('[data-oaam-preview-text-kind="current"]')?.textContent).toContain("# Before");
        fireEvent.click(within(inspector).getByRole("button", { name: "Close Current target text · guide.md" }));
        expect(within(inspector).getByRole("tab", { name: "File changes" }).getAttribute("aria-selected")).toBe("true");
        expect(document.activeElement).toBe(within(inspector).getByRole("tab", { name: "File changes" }));

        const list = within(inspector).getByRole("navigation", { name: "Files and folders to be changed" });
        fireEvent.click(within(list).getByRole("button", { name: "new.md" }));
        expect(within(inspector).queryByRole("button", { name: "Open current file in a tab" })).toBeNull();
        expect(inspector.querySelector('[data-line-kind="remove"]')).toBeNull();
        expect(inspector.querySelector('[data-line-kind="add"] code')?.textContent).toBe("new\n");
        fireEvent.click(within(list).getByRole("button", { name: "old.md" }));
        expect(within(inspector).queryByRole("button", { name: "Open desired file in a tab" })).toBeNull();
        expect(inspector.querySelector('[data-line-kind="add"]')).toBeNull();
        fireEvent.click(within(list).getByRole("button", { name: "marker.bin" }));
        expect(inspector.querySelector(".catalog-file-diff")).toBeNull();
        fireEvent.click(within(inspector).getByRole("button", { name: "Open current file in a tab" }));
        expect(inspector.querySelector(".catalog-preview-file-document")).toBeNull();
        fireEvent.click(within(list).getByRole("button", { name: "empty/" }));
        expect(inspector.textContent).toContain("Create this folder");
        expect(within(inspector).queryByRole("button", { name: "Open current file in a tab" })).toBeNull();
        fireEvent.click(within(inspector).getByRole("button", { name: "Hide file list" }));
        expect(within(inspector).queryByRole("navigation", { name: "Files and folders to be changed" })).toBeNull();
        fireEvent.click(within(inspector).getByRole("button", { name: "Show file list" }));
        expect(within(inspector).getByRole("navigation", { name: "Files and folders to be changed" })).not.toBeNull();
        const separator = within(inspector).getByRole("separator");
        fireEvent.keyDown(separator, { key: "Home" });
        expect(page?.style.getPropertyValue("--oaam-file-inspector-width")).toBe("320px");
        fireEvent.click(within(inspector).getByRole("button", { name: "Close side preview" }));
        expect(screen.queryByRole("complementary")).toBeNull();
        expect(page?.dataset.fileInspectorOpen).toBeUndefined();
        expect(document.activeElement).toBe(trigger);
    });

    it("retires an open file review when the Asset inspector opens or the preview identity changes", () => {
        const view = renderWithPresentation(
            createElement(CatalogDeploymentPreviewFiles, { files, directories, key: "preview-one" }),
        );
        fireEvent.click(screen.getByRole("button", { name: "View guide.md" }));
        expect(screen.getByRole("complementary")).not.toBeNull();
        view.rerender(createElement(CatalogDeploymentPreviewFiles, { files, directories, key: "preview-one", suspended: true }));
        expect(screen.queryByRole("complementary")).toBeNull();
        view.rerender(createElement(CatalogDeploymentPreviewFiles, { files, directories, key: "preview-one", suspended: false }));
        expect(screen.queryByRole("complementary")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "View guide.md" }));
        view.rerender(createElement(CatalogDeploymentPreviewFiles, { files: files.slice(1), directories, key: "preview-two" }));
        expect(screen.queryByRole("complementary")).toBeNull();
        expect(screen.queryByRole("button", { name: "View guide.md" })).toBeNull();
    });

    it.each([
        ["same\n", "same\n"],
        ["", ""],
        ["", "new\n"],
        ["old\n", ""],
        ["head\nold\ntail\n", "head\nnew\ntail\n"],
        ["a\nb\nc\n", "b\nd\nc\n"],
        ["same\r\n", "same\n"],
        ["same", "same\n"],
        ["a\nb\na\nb\n", "b\na\nb\na\n"],
        ["a\nb\nc\nd\n", "a\nx\nb\nd\n"],
    ])("preserves both exact text inputs in the review (%j to %j)", (current, desired) => {
        const { container } = renderWithPresentation(createElement(CatalogPreviewTextDiff, { current, desired }));
        const rows = [...container.querySelectorAll<HTMLTableRowElement>("tbody tr")];
        const read = (excluded: string) =>
            rows
                .filter((row) => row.dataset.lineKind !== excluded)
                .map((row) => row.querySelector("code")?.textContent ?? "")
                .join("");
        expect(read("add")).toBe(current);
        expect(read("remove")).toBe(desired);
    });

    it("bounds visible diff rows and lets the user reveal the remaining exact lines", () => {
        const desired = Array.from({ length: 501 }, (_, index) => `line ${index}\n`).join("");
        const { container } = renderWithPresentation(createElement(CatalogPreviewTextDiff, { current: "", desired }));
        expect(container.querySelectorAll("tbody tr")).toHaveLength(500);
        fireEvent.click(screen.getByRole("button"));
        expect(container.querySelectorAll("tbody tr")).toHaveLength(501);
        expect([...container.querySelectorAll("tbody code")].map((code) => code.textContent).join("")).toBe(desired);
        expect(screen.queryByRole("button")).toBeNull();
    });

    it("keeps both distant small edits visible and folds only unchanged context", () => {
        const before = Array.from({ length: 1_000 }, (_, index) => `original ${index + 1}\n`);
        const after = [...before];
        after[1] = "updated line 2\n";
        after[899] = "updated line 900\n";
        const { container } = renderWithPresentation(
            createElement(CatalogPreviewTextDiff, {
                current: before.join(""),
                desired: after.join(""),
            }),
        );
        expect(container.querySelectorAll('[data-line-kind="remove"]')).toHaveLength(2);
        expect(container.querySelectorAll('[data-line-kind="add"]')).toHaveLength(2);
        expect(screen.getByText("updated line 2")).not.toBeNull();
        expect(screen.getByText("updated line 900")).not.toBeNull();
        expect(container.querySelectorAll("tbody tr").length).toBeLessThan(30);
        expect(container.querySelectorAll("[data-oaam-preview-expand-context]").length).toBeGreaterThan(0);
        const moreContent =
            '[data-oaam-preview-expand-context], [data-oaam-interaction-entry="features.catalog-deployment.catalog_preview_text_diff.001"]';
        for (let step = 0; step < 10; step += 1) {
            const action = container.querySelector<HTMLElement>(moreContent);
            if (action === null) break;
            fireEvent.click(action);
        }
        expect(container.querySelector(moreContent)).toBeNull();
        const rows = [...container.querySelectorAll<HTMLTableRowElement>(".asset-diff-line")];
        expect(
            rows
                .filter((row) => row.dataset.lineKind !== "add")
                .map((row) => row.querySelector("code")?.textContent)
                .join(""),
        ).toBe(before.join(""));
        expect(
            rows
                .filter((row) => row.dataset.lineKind !== "remove")
                .map((row) => row.querySelector("code")?.textContent)
                .join(""),
        ).toBe(after.join(""));
    });

    it("discloses the bounded fallback for substantially different files without dropping text", () => {
        const current = Array.from({ length: 75 }, (_, index) => `before ${index}\n`).join("");
        const desired = Array.from({ length: 75 }, (_, index) => `after ${index}\n`).join("");
        const { container } = renderWithPresentation(createElement(CatalogPreviewTextDiff, { current, desired }));
        expect(screen.getByText(/files differ substantially/u)).not.toBeNull();
        expect([...container.querySelectorAll('[data-line-kind="remove"] code')].map((code) => code.textContent).join("")).toBe(
            current,
        );
        expect([...container.querySelectorAll('[data-line-kind="add"] code')].map((code) => code.textContent).join("")).toBe(
            desired,
        );
    });

    it("expands a large unchanged block without overflowing argument limits or rendering every line", () => {
        const current = "unchanged\n".repeat(140_000);
        const { container } = renderWithPresentation(createElement(CatalogPreviewTextDiff, { current, desired: current }));
        fireEvent.click(screen.getByRole("button"));
        expect(container.querySelectorAll(".asset-diff-line")).toHaveLength(500);
        expect(container.querySelectorAll('[data-line-kind="context"] code')).toHaveLength(500);
        expect(screen.getByRole("button").getAttribute("data-oaam-interaction-entry")).toBe(
            "features.catalog-deployment.catalog_preview_text_diff.001",
        );
    });
});
