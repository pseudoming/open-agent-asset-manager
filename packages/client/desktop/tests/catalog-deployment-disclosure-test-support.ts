import { fireEvent, screen, within } from "@testing-library/react";
import { expect } from "vitest";

export function reviewCatalogSourceTechnicalDisclosure(root: ParentNode): void {
    const button = root.querySelector<HTMLElement>(
        '[data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_asset_step.003"]',
    );
    if (button === null) throw new Error("source technical disclosure is required");
    const disclosure = button.closest("details");
    expect(screen.getByText("Imported from Claude Code")).toBeTruthy();
    expect(disclosure?.open).toBe(false);
    fireEvent.click(button);
    expect(disclosure?.open).toBe(true);
    expect(screen.getByText("/workspace/source-project")).toBeTruthy();
}

export function reviewCatalogPreviewFile(root: ParentNode): void {
    const preview = root.querySelector<HTMLElement>("[data-oaam-preview-path='CLAUDE.md']");
    if (preview === null) throw new Error("CLAUDE.md preview detail is required");
    expect(preview.textContent).toContain("Create a new file");
    fireEvent.click(within(preview).getByRole("button", { name: "View CLAUDE.md" }));
    const inspector = screen.getByRole("complementary", { name: "Files and folders to be changed" });
    expect(within(inspector).getByText("# Project guidance")).toBeTruthy();
    fireEvent.click(within(inspector).getByRole("button", { name: "Close side preview" }));
    expect(screen.queryByRole("complementary", { name: "Files and folders to be changed" })).toBeNull();
    const button = preview.querySelector<HTMLElement>(
        '[data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_workspace.028"]',
    );
    if (button === null) throw new Error("preview technical disclosure is required");
    const disclosure = button.closest("details");
    expect(disclosure?.open).toBe(false);
    fireEvent.click(button);
    expect(disclosure?.open).toBe(true);
}
