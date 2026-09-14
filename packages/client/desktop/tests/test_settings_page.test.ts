import type { ProtocolOperationName } from "@oaam/app-server-protocol";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RetainedProjectSettings } from "../src/renderer/features/project-library/RetainedProjectSettings";
import { SettingsPage } from "../src/renderer/pages/SettingsPage";
import { exerciseKeyboardResize, exercisePersistentInteractionSidebar } from "./desktop-interaction-test-harness";
import { createDesktopPresentationTestBridge, renderWithPresentation } from "./desktop-presentation-test-harness";
import { fakeDiscoveryClient } from "./discovery-test-fixtures";
import {
    ASSET,
    completedBridge,
    DIGEST,
    fakeClient,
    PROJECT,
    SECOND_PROJECT,
    SECOND_PROJECT_ID,
} from "./project-library-test-fixtures";
import { clickSemanticAction } from "./semantic-action-test-harness";

afterEach(cleanup);

describe("Desktop truthful Settings", () => {
    it("shows one exact category, navigates categories, and keeps save-and-scan as the discovery primary action", async () => {
        const client = fakeDiscoveryClient();
        const close = vi.fn();
        const guidedSetup = vi.fn();
        const categoryChange = vi.fn();
        const bridge = createDesktopPresentationTestBridge();
        const props = {
            category: "general" as const,
            client,
            desktopBridge: bridge,
            sidebarVisible: true,
            onCategoryChange: categoryChange,
            onClose: close,
            onOpenGuidedImport: guidedSetup,
            onInterfaceDefaultsRestored: vi.fn(),
        };
        const view = renderWithPresentation(createElement(SettingsPage, props), bridge);

        expect(screen.getByRole("heading", { level: 1, name: "General" })).not.toBeNull();
        exercisePersistentInteractionSidebar("pages.settings_page.002", view.container);
        exerciseKeyboardResize("pages.settings_page.006", view.container);
        expect(screen.getByRole("combobox", { name: "Language" })).not.toBeNull();
        expect(screen.getByRole("combobox", { name: "Appearance" })).not.toBeNull();
        expect(screen.getByRole("heading", { name: "Privacy and data access" })).not.toBeNull();
        expect(screen.queryByRole("heading", { name: "Locations and AI coding tools" })).toBeNull();
        expect(screen.queryByText(/Handoff Automation/u)).toBeNull();
        expect(document.querySelector("[data-oaam-settings-scroll-owner='general']")).not.toBeNull();
        expect(document.querySelector("[data-oaam-settings-scroll-sentinel='general']")).not.toBeNull();
        expect(document.querySelector(".settings-category-copy")).toBeNull();
        expect(document.querySelector(".settings-scroll-content")).not.toBeNull();

        fireEvent.click(screen.getByRole("button", { name: /^Locations and AI coding tools/u }));
        expect(categoryChange).toHaveBeenCalledWith("environments");
        view.rerender(
            createElement(SettingsPage, {
                ...props,
                category: "environments",
            }),
        );

        expect(screen.getByRole("heading", { level: 1, name: "Locations and AI coding tools" })).not.toBeNull();
        expect(screen.queryByRole("combobox", { name: "Language" })).toBeNull();
        expect(document.querySelector("[data-oaam-settings-scroll-owner='environments']")).not.toBeNull();
        expect(document.querySelector("[data-oaam-settings-scroll-sentinel='environments']")).not.toBeNull();
        await screen.findByRole("button", { name: "Scan now" });
        expect(screen.getByRole("heading", { name: "Choose systems and tools" })).not.toBeNull();
        expect(screen.getByRole("heading", { name: "Review scan locations" })).not.toBeNull();
        expect(screen.getByText(/Nothing is imported from this panel/u)).not.toBeNull();
        expect(client.getAdapterEnablement).toHaveBeenCalledOnce();
        expect(client.getWatchedScanIntent).toHaveBeenCalledOnce();
        fireEvent.click(screen.getByRole("checkbox", { name: /OpenCode/u }));
        const saveAndRun = screen.getByRole("button", { name: "Save choices and scan" });
        expect(saveAndRun.hasAttribute("disabled")).toBe(false);
        fireEvent.click(saveAndRun);
        await vi.waitFor(() => expect(client.replaceAdapterEnablement).toHaveBeenCalledOnce());
        await screen.findByText("/brand-new");
        expect(document.querySelector(".environment-result-list")).toBeNull();
        expect(
            screen.queryByRole("checkbox", {
                name: "Scan /brand-new",
            }),
        ).toBeNull();
        expect(screen.queryByRole("button", { name: "Review selected locations" })).toBeNull();

        fireEvent.change(screen.getByRole("searchbox", { name: "Search settings" }), {
            target: { value: "restore" },
        });
        expect(screen.getByRole("button", { name: "Data safety" })).not.toBeNull();
        expect(screen.queryByRole("button", { name: "General" })).toBeNull();
        fireEvent.change(screen.getByRole("searchbox", { name: "Search settings" }), {
            target: { value: "" },
        });
        await clickSemanticAction("settings.guided_import.runtime", "settings.start_guided_import", {
            expected: guidedSetup,
            expectedArgs: [],
            unrelated: [close],
        });
        await clickSemanticAction("settings.application.sidebar", "settings.open_application", {
            expected: close,
            expectedArgs: [],
            unrelated: [guidedSetup],
        });

        view.rerender(
            createElement(SettingsPage, {
                ...props,
                category: "maintenance",
            }),
        );
        expect(await screen.findByRole("heading", { level: 1, name: "Local maintenance" })).not.toBeNull();
        expect(screen.getAllByRole("heading", { name: "Local maintenance" })).toHaveLength(1);
        expect(await screen.findByRole("heading", { name: "Interface cache" })).not.toBeNull();
        expect(document.querySelector("[data-oaam-settings-scroll-sentinel='maintenance']")).not.toBeNull();
    });

    it("keeps recovery focused without exposing the ordinary category sidebar", () => {
        const client = fakeDiscoveryClient();
        const bridge = createDesktopPresentationTestBridge();
        const close = vi.fn();
        renderWithPresentation(
            createElement(SettingsPage, {
                category: "backup_recovery",
                client,
                desktopBridge: bridge,
                sidebarVisible: false,
                onCategoryChange: vi.fn(),
                onClose: close,
                onOpenGuidedImport: vi.fn(),
                onInterfaceDefaultsRestored: vi.fn(),
                recoveryReason: "missing_database",
            }),
            bridge,
        );

        expect(screen.getByRole("heading", { name: "Restore OAAM state" })).not.toBeNull();
        expect(screen.queryByRole("navigation", { name: "Settings" })).toBeNull();
        expect(document.querySelector("[data-oaam-settings-scroll-owner='backup_recovery']")).not.toBeNull();
    });

    it("restores stopped Projects only from General project management", async () => {
        const retained = { ...SECOND_PROJECT, deleted: true, rootPath: "/work/missing-project" };
        const fixture = fakeClient([PROJECT, retained], [ASSET]);
        const operations = fixture.client.availableOperations as ProtocolOperationName[];
        operations.push("project_lifecycle.inspect", "project_lifecycle.commit");
        fixture.client.inspectProjectLifecycle = vi.fn(async () => ({
            status: "complete",
            value: {
                schemaVersion: 1,
                action: "restore",
                projectLifecycleReviewToken: "settings-restore-review",
                projectId: SECOND_PROJECT_ID,
                projectAuthorityFingerprint: DIGEST,
                displayName: SECOND_PROJECT.displayName,
                rootPath: retained.rootPath,
                rootAccessState: "unavailable",
            },
            diagnostics: [],
        }));
        fixture.client.commitProjectLifecycle = vi.fn(async () => ({
            status: "complete",
            value: { ...retained, deleted: false, updatedAt: 3 },
            diagnostics: [],
        }));
        const bridge = completedBridge();
        renderWithPresentation(
            createElement(SettingsPage, {
                category: "general",
                client: fixture.client,
                desktopBridge: bridge,
                sidebarVisible: true,
                onCategoryChange: vi.fn(),
                onClose: vi.fn(),
                onOpenGuidedImport: vi.fn(),
                onInterfaceDefaultsRestored: vi.fn(),
            }),
            bridge,
        );

        expect(await screen.findByRole("heading", { name: "Project management" })).not.toBeNull();
        fireEvent.click(screen.getByText("Stopped Projects (1)").closest("summary") as HTMLElement);
        expect(document.querySelector(`li[data-oaam-project-id="${SECOND_PROJECT_ID}"]`)).not.toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Restore" }));
        fireEvent.click(screen.getByRole("button", { name: "Close Project management" }));
        fireEvent.click(screen.getByRole("button", { name: "Restore" }));
        fireEvent.click(screen.getByRole("button", { name: "Review restore" }));
        await vi.waitFor(() => expect(screen.queryByText(/retained root is currently unavailable/u)).not.toBeNull());
        fireEvent.click(screen.getByRole("button", { name: "Confirm exact Project change" }));
        await vi.waitFor(() => expect(document.querySelector('[data-oaam-project-lifecycle-state="succeeded"]')).not.toBeNull());
        expect(screen.getByText(`Project restored: ${SECOND_PROJECT.displayName}`)).not.toBeNull();
        expect(screen.getByRole("button", { name: "Close Project management" })).not.toBeNull();
        expect(fixture.client.commitProjectLifecycle).toHaveBeenCalledWith({
            projectLifecycleReviewToken: "settings-restore-review",
            userActionId: expect.any(String),
        });
        fireEvent.click(screen.getByRole("button", { name: "Close Project management" }));
        expect(screen.queryByRole("heading", { name: "Project management" })).toBeNull();
    });

    it("retries retained Project loading in place without leaving General settings", async () => {
        const fixture = fakeClient([PROJECT], [ASSET]);
        vi.mocked(fixture.client.listProjects)
            .mockResolvedValueOnce({ status: "failed", diagnostics: [] })
            .mockResolvedValueOnce({ status: "complete", value: { projects: [PROJECT] }, diagnostics: [] });
        const bridge = completedBridge();
        renderWithPresentation(
            createElement(RetainedProjectSettings, {
                client: fixture.client,
                desktopBridge: bridge,
            }),
            bridge,
        );

        expect(await screen.findByRole("alert")).not.toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));

        await vi.waitFor(() => expect(screen.queryByRole("heading", { name: "Project management" })).toBeNull());
        expect(fixture.client.listProjects).toHaveBeenCalledTimes(2);
    });
});
