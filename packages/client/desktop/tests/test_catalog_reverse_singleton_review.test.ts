import { cleanup, fireEvent, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogReverseReview } from "../src/renderer/features/catalog-deployment/CatalogReverseReview";
import type { CatalogDeploymentController } from "../src/renderer/features/catalog-deployment/catalog-deployment-controller";
import type { PreparedReverseView } from "../src/renderer/features/catalog-deployment/catalog-deployment-model";
import { DEPLOYMENT_PROVIDERS, PREPARED_REVERSE, RENDER_ANALYSIS } from "./catalog-deployment-test-fixtures";
import { renderWithPresentation } from "./desktop-presentation-test-harness";

afterEach(cleanup);

function fixtureEntry<T>(entries: readonly T[], index = 0): T {
    const value = entries[index];
    if (value === undefined) throw new Error(`missing reverse fixture entry ${index}`);
    return value;
}

function singletonPreparation(degraded = false): PreparedReverseView {
    const semantic = fixtureEntry(RENDER_ANALYSIS.semantics);
    const option = fixtureEntry(RENDER_ANALYSIS.options, degraded ? 1 : 0);
    const output = fixtureEntry(RENDER_ANALYSIS.outputUnits);
    return {
        ...PREPARED_REVERSE,
        renderAnalysis: {
            ...RENDER_ANALYSIS,
            semantics: [semantic],
            options: [option],
            outputUnits: [{ ...output, claims: [fixtureEntry(output.claims)], managedDirectoryPaths: [] }],
        },
    };
}

function setup(value: PreparedReverseView, locked: { busy?: boolean; stale?: boolean } = {}) {
    const controller = {
        commitReverse: vi.fn(async () => undefined),
        cancelReverse: vi.fn(async () => undefined),
    } as unknown as CatalogDeploymentController;
    const element = (preparation: PreparedReverseView) =>
        createElement(CatalogReverseReview, {
            controller,
            reverse: { status: "prepared", value: preparation },
            busy: locked.busy ?? false,
            stale: locked.stale ?? false,
            providers: DEPLOYMENT_PROVIDERS,
        });
    return { controller, element, view: renderWithPresentation(element(value)) };
}

describe("Singleton reverse choices preserve explicit approval", () => {
    it("deduplicates passive labels and one shared output while retaining every exact semantic selection", () => {
        const value = singletonPreparation();
        const semantics = [
            ["guidance.content", "a"],
            ["guidance.base_context", "d"],
            ["asset.file_inventory", "e"],
            ["guidance.content", "f"],
        ] as const;
        const semantic = fixtureEntry(value.renderAnalysis.semantics);
        const option = fixtureEntry(value.renderAnalysis.options);
        const preparation: PreparedReverseView = {
            ...value,
            renderAnalysis: {
                ...value.renderAnalysis,
                semantics: semantics.map(([semanticKind, fingerprint]) => ({
                    ...semantic,
                    semanticKind,
                    semanticRefFingerprint: fingerprint.repeat(64),
                })),
                options: semantics.map(([_kind, fingerprint], index) => ({
                    ...option,
                    semanticRefFingerprint: fingerprint.repeat(64),
                    optionFingerprint: String(index + 1).repeat(64),
                })),
            },
        };
        const { controller, view } = setup(preparation);
        expect(screen.queryAllByRole("radio")).toHaveLength(0);
        expect(view.container.querySelectorAll("[data-oaam-render-passive-summary]")).toHaveLength(1);
        expect(
            [...view.container.querySelectorAll<HTMLElement>("[data-oaam-passive-semantic-kind]")].map(
                (entry) => entry.dataset.oaamPassiveSemanticKind,
            ),
        ).toEqual([...new Set(semantics.map(([kind]) => kind))]);
        expect(view.container.querySelectorAll("[data-oaam-render-output-summary] li")).toHaveLength(1);
        expect(screen.getByText("Instructions")).toBeTruthy();
        expect(screen.getByText("Project context")).toBeTruthy();
        const commit = screen.getByRole("button", { name: "Keep as a new library version" }) as HTMLButtonElement;
        expect(commit.disabled).toBe(true);
        expect(controller.commitReverse).not.toHaveBeenCalled();
        fireEvent.click(screen.getByLabelText(/Allow this tool setup to select this exact new Asset Version/u));
        expect(commit.disabled).toBe(false);
        fireEvent.click(commit);
        expect(controller.commitReverse).toHaveBeenCalledWith(
            semantics.map(([_kind, fingerprint], index) => ({
                semanticRefFingerprint: fingerprint.repeat(64),
                optionFingerprint: String(index + 1).repeat(64),
                approved: false,
            })),
            true,
        );
    });

    it("never implicitly approves a single degraded strategy or carries consent into a new preparation", () => {
        const value = singletonPreparation(true);
        const { controller, view, element } = setup(value);
        const commit = screen.getByRole("button", { name: "Keep as a new library version" }) as HTMLButtonElement;
        const approval = screen.getByLabelText("Approve this degraded render once") as HTMLInputElement;
        expect(screen.queryByRole("radio")).toBeNull();
        expect(approval.checked).toBe(false);
        fireEvent.click(screen.getByLabelText(/Allow this tool setup to select this exact new Asset Version/u));
        expect(commit.disabled).toBe(true);
        fireEvent.click(approval);
        expect(commit.disabled).toBe(false);
        fireEvent.click(commit);
        expect(controller.commitReverse).toHaveBeenCalledWith(
            [
                {
                    semanticRefFingerprint: fixtureEntry(value.renderAnalysis.semantics).semanticRefFingerprint,
                    optionFingerprint: fixtureEntry(value.renderAnalysis.options).optionFingerprint,
                    approved: true,
                },
            ],
            true,
        );
        view.rerender(element({ ...value, preparationId: "88888888-8888-4888-8888-888888888888" }));
        expect(approval.checked).toBe(false);
        expect(commit.disabled).toBe(true);
        expect(controller.commitReverse).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByRole("button", { name: "Cancel without saving" }));
        expect(controller.cancelReverse).toHaveBeenCalledTimes(1);
    });

    it.each([
        { busy: true },
        { stale: true },
    ])("keeps the commit blocked for %j even when promotion was already authorized", (locked) => {
        const { controller } = setup({ ...singletonPreparation(), promotionState: "already_authorized" }, locked);
        const commit = screen.getByRole("button", { name: "Keep as a new library version" }) as HTMLButtonElement;
        expect(commit.disabled).toBe(true);
        fireEvent.click(commit);
        expect(controller.commitReverse).not.toHaveBeenCalled();
    });
});
