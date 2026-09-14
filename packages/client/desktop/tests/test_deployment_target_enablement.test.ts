import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApplicationClientApi } from "../src/renderer/client";
import { DeploymentPage } from "../src/renderer/pages/DeploymentPage";
import {
    ASSET_ID,
    deploymentClient,
    missingInstallationProbe,
    ONE_ENABLED_PROVIDER,
    PROJECT,
    PROJECT_ID,
} from "./deployment-page-test-fixtures";
import { renderWithPresentation } from "./desktop-presentation-test-harness";

type EnablementResult = Awaited<ReturnType<DesktopApplicationClientApi["replaceAdapterEnablement"]>>;

afterEach(cleanup);

function renderEnablementJourney() {
    let settle!: (result: EnablementResult) => void;
    const replaceAdapterEnablement = vi.fn(
        () =>
            new Promise<EnablementResult>((resolve) => {
                settle = resolve;
            }),
    );
    const probeProject = vi.fn(async () => ({ status: "partial" as const, value: missingInstallationProbe(), diagnostics: [] }));
    const authorizeRegisteredProjectRoot = vi.fn(async () => ({
        status: "authorized" as const,
        displayPath: PROJECT.rootPath,
        localPathSelectionToken: "enablement-project-token",
    }));
    const client = deploymentClient({
        getAdapterEnablement: vi.fn(async () => ({ status: "complete" as const, value: ONE_ENABLED_PROVIDER, diagnostics: [] })),
        replaceAdapterEnablement,
        probeProject,
    });
    const view = renderWithPresentation(
        createElement(DeploymentPage, {
            client,
            assetId: ASSET_ID,
            subject: { subjectKind: "project", projectId: PROJECT_ID },
            sidebarVisible: true,
            authorizeRegisteredProjectRoot,
            revealRegisteredProjectRoot: vi.fn(),
            onClose: vi.fn(),
        }),
    );
    return {
        view,
        replaceAdapterEnablement,
        probeProject,
        authorizeRegisteredProjectRoot,
        settle: (result: EnablementResult) => settle(result),
    };
}

describe("Target check enablement decision", () => {
    it("keeps focus on the same primary action after explicit enablement and retains a partial result with no usable location", async () => {
        const journey = renderEnablementJourney();
        const action = await screen.findByRole<HTMLButtonElement>("button", { name: "Enable selected tools" });
        expect(screen.getByText("Enabled tools stay enabled in OAAM. You can change this in Settings.")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Check tools" })).toBeNull();
        expect(screen.queryByText("Confirm the Asset")).toBeNull();
        expect(journey.view.container.querySelector(".asset-usage-relationships")).toBeNull();
        expect(journey.replaceAdapterEnablement).not.toHaveBeenCalled();
        action.focus();
        fireEvent.click(action);
        expect(action.getAttribute("aria-disabled")).toBe("true");
        expect(action.disabled).toBe(false);
        for (const key of [" ", "Enter"]) {
            const press = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
            fireEvent(action, press);
            expect(press.defaultPrevented).toBe(true);
        }
        const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
        fireEvent(action, tab);
        expect(tab.defaultPrevented).toBe(false);
        fireEvent.click(action);
        expect(journey.probeProject).not.toHaveBeenCalled();
        expect(journey.replaceAdapterEnablement).toHaveBeenCalledOnce();
        expect(journey.replaceAdapterEnablement).toHaveBeenCalledWith(
            expect.objectContaining({
                expectedRevision: ONE_ENABLED_PROVIDER.revision,
                expectedSettingFingerprint: ONE_ENABLED_PROVIDER.settingFingerprint,
                enabledAdapterIds: ["CLAUDECODE", "OPENCODE"],
            }),
        );
        await act(async () =>
            journey.settle({
                status: "complete",
                value: { ...ONE_ENABLED_PROVIDER, revision: 2, enabledAdapterIds: ["CLAUDECODE", "OPENCODE"] },
                diagnostics: [],
            }),
        );
        const check = await screen.findByRole<HTMLButtonElement>("button", { name: "Check tools" });
        expect(check).toBe(action);
        expect(check.getAttribute("aria-disabled")).toBeNull();
        expect(document.activeElement).toBe(action);
        for (const key of [" ", "Enter"]) {
            const held = new KeyboardEvent("keydown", { key, repeat: true, bubbles: true, cancelable: true });
            fireEvent(check, held);
            expect(held.defaultPrevented).toBe(true);
            const fresh = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
            fireEvent(check, fresh);
            expect(fresh.defaultPrevented).toBe(false);
        }
        expect(journey.probeProject).not.toHaveBeenCalled();
        expect(journey.authorizeRegisteredProjectRoot).not.toHaveBeenCalled();
        fireEvent.click(check);
        await waitFor(() => expect(journey.probeProject).toHaveBeenCalledOnce());
        expect(await screen.findByText("Not installed")).toBeTruthy();
        expect(
            journey.view.container.querySelector(".asset-usage-relationships")?.getAttribute("data-oaam-asset-usage-state"),
        ).toBe("none");
    });

    it("keeps the enable action available after a failed save without authorizing or probing the Project", async () => {
        const journey = renderEnablementJourney();
        const action = await screen.findByRole<HTMLButtonElement>("button", { name: "Enable selected tools" });
        action.focus();
        fireEvent.click(action);
        await act(async () => journey.settle({ status: "failed", diagnostics: [] }));
        await waitFor(() => expect(action.getAttribute("aria-disabled")).toBeNull());
        expect(screen.getByRole("button", { name: "Enable selected tools" })).toBe(action);
        expect(document.activeElement).toBe(action);
        expect(
            journey.view.container.querySelector(".deployment-target-discovery")?.getAttribute("data-oaam-target-probe-activity"),
        ).toBe("save_failed");
        expect(screen.queryByRole("button", { name: "Check tools" })).toBeNull();
        expect(journey.authorizeRegisteredProjectRoot).not.toHaveBeenCalled();
        expect(journey.probeProject).not.toHaveBeenCalled();
    });

    it("does not take focus back when the user moves away while enablement is pending", async () => {
        const journey = renderEnablementJourney();
        const action = await screen.findByRole<HTMLButtonElement>("button", { name: "Enable selected tools" });
        action.focus();
        fireEvent.click(action);
        const otherAction = screen.getByRole<HTMLButtonElement>("button", { name: "Back to library" });
        otherAction.focus();
        expect(document.activeElement).toBe(otherAction);
        await act(async () =>
            journey.settle({
                status: "complete",
                value: { ...ONE_ENABLED_PROVIDER, revision: 2, enabledAdapterIds: ["CLAUDECODE", "OPENCODE"] },
                diagnostics: [],
            }),
        );
        await screen.findByRole("button", { name: "Check tools" });
        expect(document.activeElement).toBe(otherAction);
        expect(journey.replaceAdapterEnablement).toHaveBeenCalledOnce();
        expect(journey.probeProject).not.toHaveBeenCalled();
    });
});
