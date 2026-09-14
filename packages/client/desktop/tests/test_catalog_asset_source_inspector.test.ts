import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    CatalogAssetSourceDetails,
    CatalogAssetSourceInspector,
} from "../src/renderer/features/catalog-deployment/CatalogAssetSourceInspector";
import { CatalogDeploymentAssetStep } from "../src/renderer/features/catalog-deployment/CatalogDeploymentAssetStep";
import type { AssetVersionView } from "../src/renderer/features/catalog-deployment/catalog-deployment-model";
import { DEPLOYMENT_PROVIDERS } from "./catalog-deployment-test-fixtures";
import { ASSET } from "./catalog-deployment-test-support";
import { renderWithPresentation } from "./desktop-presentation-test-harness";

const IMPORT_SOURCE: NonNullable<AssetVersionView["importSource"]> = {
    adapterId: "ANTIGRAVITY",
    sourceSnapshotFingerprint: "b".repeat(64),
    roots: [
        {
            sourceRootId: "root-1",
            rootRole: "project_actual",
            sourceDomain: "project_root",
            canonicalPath: "/workspace/demo-plugin",
        },
    ],
    files: [
        {
            sourceRootId: "root-1",
            relativePath: "AGENTS.md",
            contentHash: "c".repeat(64),
        },
    ],
};

afterEach(cleanup);

describe("Catalog Asset source inspector", () => {
    it("keeps the source tag and original source roots inside the selected Asset card", () => {
        const firstRoot = IMPORT_SOURCE.roots[0];
        if (firstRoot === undefined) throw new Error("source root fixture is required");
        const secondRoot = { ...firstRoot, sourceRootId: "root-2", canonicalPath: "C:\\source-project" };
        const { container } = renderWithPresentation(
            createElement(CatalogDeploymentAssetStep, {
                asset: ASSET,
                allowIncomplete: false,
                disabled: false,
                importSource: { ...IMPORT_SOURCE, roots: [...IMPORT_SOURCE.roots, secondRoot] },
                providers: DEPLOYMENT_PROVIDERS,
                onAllowIncompleteChange: vi.fn(),
                onPreview: vi.fn(),
            }),
        );
        const source = container.querySelector('[data-oaam-asset-import-source="ANTIGRAVITY"]');
        const card = source?.closest(".deployment-selected-asset-row");
        expect(card?.textContent).toContain(ASSET.displayName);
        const summary = card?.querySelector("summary");
        if (summary === null || summary === undefined) throw new Error("source disclosure is required");
        expect(summary.textContent).toBe("Asset source");
        fireEvent.click(summary);
        expect(card?.querySelector("details")?.open).toBe(true);
        expect(card?.querySelector("details")?.textContent).toContain("/workspace/demo-plugin");
        expect(card?.querySelector("details")?.textContent).toContain("C:\\source-project");
    });

    it("binds the imported Provider, root and file identities in the right detail surface", () => {
        const onClose = vi.fn();
        const writeText = vi.fn(async () => undefined);
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
        const { container } = renderWithPresentation(
            createElement(CatalogAssetSourceInspector, {
                importSource: IMPORT_SOURCE,
                providers: DEPLOYMENT_PROVIDERS,
                onClose,
            }),
        );

        const inspector = screen.getByRole("complementary", { name: "Asset source" });
        expect(inspector.dataset).toMatchObject({
            oaamSourceAdapterId: "ANTIGRAVITY",
            oaamSourceSnapshotFingerprint: "b".repeat(64),
            oaamSourceRootCount: "1",
            oaamSourceFileCount: "1",
        });
        expect(container.querySelector('[data-oaam-source-root-id="root-1"]')?.textContent).toContain("/workspace/demo-plugin");
        expect(container.querySelector('[data-oaam-source-relative-path="AGENTS.md"]')).toMatchObject({
            dataset: expect.objectContaining({
                oaamSourceContentHash: "c".repeat(64),
                oaamSourceFullPath: "/workspace/demo-plugin/AGENTS.md",
            }),
        });
        const copyButtons = screen.getAllByRole("button", { name: "Copy path" });
        fireEvent.click(copyButtons[0] as HTMLElement);
        expect(writeText).toHaveBeenCalledWith("/workspace/demo-plugin");
        fireEvent.click(copyButtons[1] as HTMLElement);
        expect(writeText).toHaveBeenCalledWith("/workspace/demo-plugin/AGENTS.md");
        fireEvent.click(screen.getByRole("button", { name: "Close Asset inspector" }));
        expect(onClose).toHaveBeenCalledOnce();
    });

    it("reveals only an explicitly bound registered Project source root", async () => {
        const onRevealSourceRoot = vi.fn(async () => ({ status: "complete" as const }));
        renderWithPresentation(
            createElement(CatalogAssetSourceDetails, {
                importSource: IMPORT_SOURCE,
                providers: DEPLOYMENT_PROVIDERS,
                revealableSourceRootIds: ["root-1"],
                onRevealSourceRoot,
            }),
        );

        fireEvent.click(screen.getByRole("button", { name: "Open Project folder" }));
        await waitFor(() => expect(onRevealSourceRoot).toHaveBeenCalledWith("root-1"));
        expect(screen.getByText("Opened the containing folder in File Explorer.")).toBeTruthy();
    });

    it("keeps copy and reveal failures inside the source detail pane", async () => {
        const writeText = vi.fn(async () => Promise.reject(new Error("clipboard unavailable")));
        const onRevealSourceRoot = vi.fn(async () => Promise.reject(new Error("file manager unavailable")));
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
        renderWithPresentation(
            createElement(CatalogAssetSourceDetails, {
                importSource: IMPORT_SOURCE,
                providers: DEPLOYMENT_PROVIDERS,
                revealableSourceRootIds: ["root-1"],
                onRevealSourceRoot,
            }),
        );

        fireEvent.click(screen.getAllByRole("button", { name: "Copy path" })[0] as HTMLElement);
        expect(await screen.findByRole("button", { name: "Path could not be copied" })).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Open Project folder" }));
        expect((await screen.findByRole("alert")).textContent).toContain(
            "The containing folder could not be opened. Scan again and retry.",
        );
        expect(onRevealSourceRoot).toHaveBeenCalledWith("root-1");
    });
});
