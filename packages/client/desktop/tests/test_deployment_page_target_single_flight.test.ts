import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeploymentPage } from "../src/renderer/pages/DeploymentPage";
import { renderWithPresentation } from "./desktop-presentation-test-harness";
import { PROBE } from "./discovery-test-fixtures";
import { ASSET_ID, deploymentClient, PROJECT, PROJECT_ID } from "./deployment-page-test-fixtures";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

afterEach(cleanup);

describe("Project target discovery single-flight", () => {
    it("holds one lock through authorization, probing, and relationship settlement", async () => {
        const authorization = deferred<{
            readonly status: "authorized";
            readonly displayPath: string;
            readonly localPathSelectionToken: string;
        }>();
        const probeProject = vi.fn(async () => ({ status: "complete" as const, value: PROBE, diagnostics: [] }));
        const authorizeRegisteredProjectRoot = vi.fn(() => authorization.promise);
        renderWithPresentation(
            createElement(DeploymentPage, {
                client: deploymentClient({ probeProject }),
                subject: { subjectKind: "project", projectId: PROJECT_ID },
                assetId: ASSET_ID,
                sidebarVisible: true,
                pickInstallationRoot: vi.fn(async () => ({ status: "cancelled" as const })),
                authorizeRegisteredProjectRoot,
                revealRegisteredProjectRoot: vi.fn(),
                onClose: vi.fn(),
            }),
        );

        const action = await screen.findByRole<HTMLButtonElement>("button", {
            name: "Check tools",
        });
        await waitFor(() => expect(action.disabled).toBe(false));
        fireEvent.click(action);
        fireEvent.click(action);
        await waitFor(() => expect(authorizeRegisteredProjectRoot).toHaveBeenCalledOnce());
        expect(action.getAttribute("aria-disabled")).toBe("true");
        expect(probeProject).not.toHaveBeenCalled();

        authorization.resolve({
            status: "authorized",
            displayPath: PROJECT.rootPath,
            localPathSelectionToken: "single-flight-project-token",
        });
        await waitFor(() => expect(probeProject).toHaveBeenCalledOnce());
        await waitFor(() => expect(action.getAttribute("aria-disabled")).toBeNull());
    });
});
