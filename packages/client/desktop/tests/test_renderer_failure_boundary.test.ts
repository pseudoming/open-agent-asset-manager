import { cleanup, fireEvent, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boundedRendererComponentTrail, RendererFailureBoundary } from "../src/renderer/app/RendererFailureBoundary";
import { renderWithPresentation } from "./desktop-presentation-test-harness";

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe("Desktop renderer failure boundary", () => {
    it("replaces an uncaught page failure with a bounded restart action and clears it after recovery", async () => {
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        let shouldThrow = true;
        function Page(): React.JSX.Element {
            if (shouldThrow) throw new Error("fixture body must not be shown");
            return createElement("p", null, "Recovered workspace");
        }
        const onRecover = vi.fn(async () => {
            shouldThrow = false;
        });
        const onDiagnostic = vi.fn(async () => undefined);
        const marker = document.createElement("div");
        marker.dataset.oaamRoute = "library";
        document.body.append(marker);
        const { container } = renderWithPresentation(
            createElement(RendererFailureBoundary, { onDiagnostic, onRecover }, createElement(Page)),
        );

        expect(screen.getByRole("heading", { name: "This page could not continue" })).not.toBeNull();
        expect(document.querySelector("[data-oaam-renderer-failure-kind='render']")).not.toBeNull();
        expect(container.textContent).not.toContain("fixture body must not be shown");
        await vi.waitFor(() =>
            expect(onDiagnostic).toHaveBeenCalledWith(
                expect.objectContaining({ event: "failure", failureKind: "render", surface: "library" }),
            ),
        );
        fireEvent.click(screen.getByRole("button", { name: "Reload interface" }));
        await vi.waitFor(() => expect(screen.queryByText("Recovered workspace")).not.toBeNull());
        expect(onRecover).toHaveBeenCalledOnce();
        expect(onDiagnostic).toHaveBeenCalledWith({
            event: "recovery_started",
            failureKind: "render",
            surface: "library",
            componentTrail: [],
        });
        expect(onDiagnostic).toHaveBeenCalledWith({
            event: "recovery_dispatched",
            failureKind: "render",
            surface: "library",
            componentTrail: [],
        });
        expect(document.querySelector("[data-oaam-renderer-failure]")).toBeNull();
        marker.remove();
    });

    it("keeps the friendly fallback and permits another bounded attempt when restart fails", async () => {
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        const onRecover = vi.fn(async () => {
            throw new Error("restart detail must not be shown");
        });
        const onDiagnostic = vi.fn(async () => undefined);
        function FailedPage(): React.JSX.Element {
            throw new Error("page detail must not be shown");
        }
        const { container } = renderWithPresentation(
            createElement(RendererFailureBoundary, { onDiagnostic, onRecover }, createElement(FailedPage)),
        );

        fireEvent.click(screen.getByRole("button", { name: "Reload interface" }));
        await vi.waitFor(() =>
            expect(screen.queryByText("The interface could not reload yet. You can try again.")).not.toBeNull(),
        );
        expect(container.textContent).not.toContain("restart detail must not be shown");
        expect(container.textContent).not.toContain("page detail must not be shown");
        expect(screen.getByRole("button", { name: "Reload interface" })).not.toBeNull();
        expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ event: "recovery_failed", failureKind: "render" }));
    });

    it.each([
        ["error", "window_error"],
        ["unhandledrejection", "unhandled_rejection"],
    ] as const)("converts a global %s into the same friendly recovery surface without exposing its body", async (eventName, kind) => {
        const onRecover = vi.fn(async () => undefined);
        const onDiagnostic = vi.fn(async () => undefined);
        const { container } = renderWithPresentation(
            createElement(RendererFailureBoundary, { onDiagnostic, onRecover }, createElement("p", null, "Workspace")),
        );
        const event = new Event(eventName, { cancelable: true });
        Object.defineProperty(event, eventName === "error" ? "error" : "reason", {
            value: new Error("private fixture body"),
        });

        expect(window.dispatchEvent(event)).toBe(false);
        await vi.waitFor(() => expect(document.querySelector(`[data-oaam-renderer-failure-kind='${kind}']`)).not.toBeNull());
        expect(container.textContent).not.toContain("private fixture body");
        expect(onRecover).not.toHaveBeenCalled();
        expect(onDiagnostic).toHaveBeenCalledWith(
            expect.objectContaining({ event: "failure", failureKind: kind, componentTrail: [] }),
        );
    });

    it("extracts only bounded code-like component identities", () => {
        expect(
            boundedRendererComponentTrail({
                componentStack:
                    "\n    at AssetVersionPanel (/private/user/file.tsx:1:2)\n    at ProjectLibraryWorkspace\n    at bad/name\n    at AssetVersionPanel",
            }),
        ).toEqual(["AssetVersionPanel", "ProjectLibraryWorkspace"]);
    });
});
