import { cleanup, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/renderer/app/App";
import type { DesktopSession } from "../src/renderer/client";
import { createDesktopPresentationTestBridge, renderWithPresentation } from "./desktop-presentation-test-harness";

afterEach(cleanup);

describe("Desktop startup failure presentation", () => {
    it("keeps an empty failure code out of the UI while retaining safe recovery actions", () => {
        const state = {
            status: "failed" as const,
            message: "session.host_startup_failed" as const,
            reasonCode: "",
            canRetry: true as const,
        };
        const session = {
            state,
            applicationClient: undefined,
            subscribe(listener: (next: typeof state) => void) {
                listener(state);
                return () => undefined;
            },
            close: vi.fn(),
            retry: vi.fn(),
            openDiagnostics: vi.fn(async () => ({ status: "complete" as const })),
            attach: vi.fn(),
        } as unknown as DesktopSession;
        const bridge = createDesktopPresentationTestBridge();
        renderWithPresentation(createElement(App, { session }), bridge);

        expect(screen.getByRole("heading", { name: "OAAM could not finish starting." })).not.toBeNull();
        expect(screen.getByText("OAAM could not start. It will not keep retrying in the background.")).not.toBeNull();
        expect(screen.queryByText("Failure code:")).toBeNull();
        expect(document.querySelector(".host-failure-reason code")).toBeNull();
        expect(screen.getByRole("button", { name: "Retry" })).not.toBeNull();
        expect(screen.getByRole("button", { name: "Ordinary logs" })).not.toBeNull();
    });
});
