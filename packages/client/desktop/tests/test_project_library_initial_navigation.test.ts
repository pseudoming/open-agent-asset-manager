import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/renderer/app/App";
import type { DesktopSession, DesktopSessionState } from "../src/renderer/client";
import { DesktopPresentationProvider } from "../src/renderer/presentation";
import { renderWithPresentation } from "./desktop-presentation-test-harness";
import {
    ASSET,
    completedBridge,
    fakeClient,
    PROJECT,
    PROJECT_ID,
    SECOND_ASSET,
    SECOND_PROJECT,
    SECOND_PROJECT_ID,
} from "./project-library-test-fixtures";

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
const library = () => document.querySelector<HTMLElement>('main[data-oaam-route="library"]');

afterEach(async () => {
    for (const { root, container } of mounted.splice(0)) {
        await act(async () => root.unmount());
        container.remove();
    }
    cleanup();
});

function fixture() {
    const value = fakeClient([PROJECT, SECOND_PROJECT], [ASSET, SECOND_ASSET]);
    const bridge = completedBridge(PROJECT_ID);
    const state: DesktopSessionState = {
        status: "ready",
        mode: "normal",
        hostInstanceId: "initial-navigation-fixture",
        assetCount: 2,
        catalogWarningCount: 0,
    };
    const session = {
        state,
        applicationClient: value.client,
        desktopBridge: bridge,
        subscribe: (listener: (next: DesktopSessionState) => void) => {
            listener(state);
            return () => undefined;
        },
        close: vi.fn(),
        refreshCatalogSummary: vi.fn(async () => undefined),
    } as unknown as DesktopSession;
    return { ...value, bridge, session };
}

async function clickAtFirstProjectCommit(click: (button: HTMLButtonElement) => void) {
    const value = fixture();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    let observer: MutationObserver | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let clicked = false;
    try {
        // A real post-commit event must be allowed before pending passive effects are drained by act.
        actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
        const firstClick = new Promise<void>((resolve, reject) => {
            deadline = setTimeout(() => reject(new Error("Project choices did not commit")), 3_000);
            observer = new MutationObserver(() => {
                const button = container.querySelector<HTMLButtonElement>(
                    `button.asset-tree-project[data-oaam-project-id="${SECOND_PROJECT_ID}"]`,
                );
                if (clicked || button === null) return;
                clicked = true;
                try {
                    expect(button.isConnected).toBe(true);
                    expect(library()?.dataset.oaamProjectId).toBe(PROJECT_ID);
                    click(button);
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
            observer.observe(container, { subtree: true, childList: true });
        });
        root.render(
            createElement(DesktopPresentationProvider, { bridge: value.bridge }, createElement(App, { session: value.session })),
        );
        await firstClick;
    } finally {
        clearTimeout(deadline);
        observer?.disconnect();
        actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
    await act(async () => undefined);
    expect(clicked).toBe(true);
    expect(value.client.listProjects).toHaveBeenCalledTimes(1);
    return value;
}

describe("Project defaults and newer App navigation", () => {
    it("keeps a connected Project click made after the first DOM commit instead of replacing it with the old default", async () => {
        await clickAtFirstProjectCommit((button) => button.click());
        await vi.waitFor(() => expect(library()?.dataset.oaamProjectId).toBe(SECOND_PROJECT_ID));
        expect(screen.getByRole("heading", { level: 1, name: SECOND_PROJECT.displayName })).not.toBeNull();
    });

    it("keeps an early Global navigation when the old Project default effect completes", async () => {
        await clickAtFirstProjectCommit(() => {
            const global = document.querySelector<HTMLButtonElement>('button[data-oaam-subject-choice="global"]');
            expect(global).not.toBeNull();
            global?.click();
        });
        await vi.waitFor(() => expect(library()?.dataset.oaamSubject).toBe("global"));
        expect(library()?.hasAttribute("data-oaam-project-id")).toBe(false);
    });

    it("still completes the remembered initial Project and preserves explicit Back and Forward selection", async () => {
        const value = fixture();
        renderWithPresentation(createElement(App, { session: value.session }), value.bridge);
        await screen.findByRole("heading", { level: 1, name: PROJECT.displayName });
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: /^Second project/u }));
        });
        await vi.waitFor(() => expect(library()?.dataset.oaamProjectId).toBe(SECOND_PROJECT_ID));
        await act(async () => {
            fireEvent.mouseUp(window, { button: 3 });
        });
        await vi.waitFor(() => expect(library()?.dataset.oaamProjectId).toBe(PROJECT_ID));
        await act(async () => {
            fireEvent.mouseUp(window, { button: 4 });
        });
        await vi.waitFor(() => expect(library()?.dataset.oaamProjectId).toBe(SECOND_PROJECT_ID));
        expect(value.client.listProjects).toHaveBeenCalledTimes(1);
    });
});
