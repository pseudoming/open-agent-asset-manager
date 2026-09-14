import { describe, expect, it, vi } from "vitest";
import { DiscoveryController } from "../src/renderer/features/discovery/discovery-controller";
import { fakeDiscoveryClient } from "./discovery-test-fixtures";

const FIRST_PROJECT = {
    projectId: "11111111-1111-4111-8111-111111111111",
    displayName: "Shared name",
    rootPath: "/work/first",
    deleted: false,
    createdAt: 1,
    updatedAt: 1,
} as const;

const SECOND_PROJECT = {
    projectId: "22222222-2222-4222-8222-222222222222",
    displayName: "Shared name",
    rootPath: "/work/second",
    deleted: false,
    createdAt: 2,
    updatedAt: 2,
} as const;

const LAST_PROJECT = {
    projectId: "33333333-3333-4333-8333-333333333333",
    displayName: "Zed",
    rootPath: "/work/last",
    deleted: false,
    createdAt: 3,
    updatedAt: 3,
} as const;

describe("Desktop discovery Project registration", () => {
    it("publishes a successful exact registration and keeps failed or interrupted attempts fail-closed", async () => {
        const registerProject = vi
            .fn()
            .mockResolvedValueOnce({ status: "complete", value: FIRST_PROJECT, diagnostics: [] })
            .mockResolvedValueOnce({ status: "failed", diagnostics: [] })
            .mockRejectedValueOnce(new Error("transport closed"));
        const controller = new DiscoveryController(
            fakeDiscoveryClient({
                listProjects: vi.fn(async () => ({
                    status: "complete",
                    value: { projects: [LAST_PROJECT, SECOND_PROJECT] },
                    diagnostics: [],
                })),
                registerProject,
            }),
            { createUserActionId: () => "registration-action", autoProbeWatched: false },
        );

        expect(await controller.registerProject("before-load")).toEqual({ status: "failed", diagnostics: [] });
        await controller.load();
        expect(await controller.registerProject("   ")).toEqual({ status: "failed", diagnostics: [] });

        await expect(controller.registerProject("first-token", "  Shared name  ")).resolves.toEqual({
            status: "complete",
            project: FIRST_PROJECT,
        });
        expect(controller.state).toMatchObject({
            status: "ready",
            projects: [FIRST_PROJECT, SECOND_PROJECT, LAST_PROJECT],
        });

        await expect(controller.registerProject("failed-token")).resolves.toEqual({
            status: "failed",
            diagnostics: [],
        });
        await expect(controller.registerProject("interrupted-token")).resolves.toEqual({
            status: "failed",
            diagnostics: [],
        });
        expect(registerProject.mock.calls.map(([params]) => params)).toEqual([
            { localPathSelectionToken: "first-token", displayName: "Shared name" },
            { localPathSelectionToken: "failed-token" },
            { localPathSelectionToken: "interrupted-token" },
        ]);
    });

    it("publishes the returned Project immediately, then reconciles from the authoritative list", async () => {
        let continueReconciliation: (() => void) | undefined;
        const reconciliationGate = new Promise<void>((resolve) => {
            continueReconciliation = resolve;
        });
        const returnedProject = { ...FIRST_PROJECT, displayName: "My Project" };
        const authoritativeProject = { ...returnedProject, displayName: "My Project (saved)", updatedAt: 4 };
        const listProjects = vi
            .fn()
            .mockResolvedValueOnce({ status: "complete", value: { projects: [] }, diagnostics: [] })
            .mockImplementationOnce(async () => {
                await reconciliationGate;
                return {
                    status: "complete" as const,
                    value: { projects: [authoritativeProject, SECOND_PROJECT] },
                    diagnostics: [],
                };
            });
        const registerProject = vi.fn(async () => ({
            status: "complete" as const,
            value: returnedProject,
            diagnostics: [],
        }));
        const controller = new DiscoveryController(fakeDiscoveryClient({ listProjects, registerProject }), {
            createUserActionId: () => "registration-action",
            autoProbeWatched: false,
        });

        await controller.load();
        await expect(controller.registerProject("exact-token", "  My Project  ")).resolves.toEqual({
            status: "complete",
            project: returnedProject,
        });
        expect(controller.state).toMatchObject({ status: "ready", projects: [returnedProject] });
        expect(registerProject).toHaveBeenCalledWith({
            localPathSelectionToken: "exact-token",
            displayName: "My Project",
        });

        continueReconciliation?.();
        await vi.waitFor(() => {
            expect(controller.state).toMatchObject({
                status: "ready",
                projects: [authoritativeProject, SECOND_PROJECT],
            });
        });
    });

    it("keeps the immediate registration receipt when the background Project-list reconcile is unavailable", async () => {
        const listProjects = vi
            .fn()
            .mockResolvedValueOnce({ status: "complete", value: { projects: [] }, diagnostics: [] })
            .mockRejectedValueOnce(new Error("list unavailable"));
        const controller = new DiscoveryController(
            fakeDiscoveryClient({
                listProjects,
                registerProject: vi.fn(async () => ({ status: "complete" as const, value: FIRST_PROJECT, diagnostics: [] })),
            }),
            { createUserActionId: () => "registration-action", autoProbeWatched: false },
        );

        await controller.load();
        await expect(controller.registerProject("exact-token")).resolves.toEqual({
            status: "complete",
            project: FIRST_PROJECT,
        });
        await vi.waitFor(() => expect(listProjects).toHaveBeenCalledTimes(2));
        expect(controller.state).toMatchObject({ status: "ready", projects: [FIRST_PROJECT] });
    });

    it("keeps stopped Projects separate and accepts only the exact restore receipt", async () => {
        const retainedProject = { ...SECOND_PROJECT, deleted: true } as const;
        const controller = new DiscoveryController(
            fakeDiscoveryClient({
                listProjects: vi.fn(async () => ({
                    status: "complete" as const,
                    value: { projects: [FIRST_PROJECT, retainedProject] },
                    diagnostics: [],
                })),
            }),
            { createUserActionId: () => "registration-action", autoProbeWatched: false },
        );

        await controller.load();
        expect(controller.state).toMatchObject({
            status: "ready",
            projects: [FIRST_PROJECT],
            retainedProjects: [retainedProject],
        });
        expect(
            controller.applyRestoredProject(
                { ...retainedProject, deleted: false },
                FIRST_PROJECT.projectId,
                SECOND_PROJECT.rootPath,
            ),
        ).toBe(false);
        expect(controller.applyRestoredProject({ ...retainedProject, deleted: false }, retainedProject.projectId, "/wrong")).toBe(
            false,
        );
        const restoredProject = { ...retainedProject, deleted: false, updatedAt: 4 } as const;
        expect(controller.applyRestoredProject(restoredProject, retainedProject.projectId, retainedProject.rootPath)).toBe(true);
        expect(controller.state).toMatchObject({
            status: "ready",
            projects: [FIRST_PROJECT, restoredProject],
            retainedProjects: [],
        });
    });
});
