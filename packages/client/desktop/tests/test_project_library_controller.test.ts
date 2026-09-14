import type { ProtocolInvalidationV1, ProtocolOperationName } from "@oaam/app-server-protocol";
import { describe, expect, it, vi } from "vitest";
import type { DesktopApplicationClientApi } from "../src/renderer/client";
import { ProjectLibraryController, type ProjectLibraryState } from "../src/renderer/features/project-library";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const DIGEST = "a".repeat(64);
const PROJECT = {
    projectId: PROJECT_ID,
    displayName: "OAAM",
    rootPath: "/work/oaam",
    deleted: false,
    createdAt: 1,
    updatedAt: 2,
};
const RETAINED_PROJECT = {
    ...PROJECT,
    projectId: "66666666-6666-4666-8666-666666666666",
    displayName: "Retained OAAM",
    rootPath: "/work/retained-oaam",
    deleted: true,
};
const WARNING = {
    severity: "warning" as const,
    code: "test.warning",
    operation: "project" as const,
    causeKind: "partial" as const,
    retryable: true,
    suggestedActions: ["retry"],
    message: "fixture warning",
};
const ERROR = { ...WARNING, severity: "error" as const, message: "fixture error" };

interface FakeClientFixture {
    readonly client: DesktopApplicationClientApi;
    invalidate(value: ProtocolInvalidationV1): void;
    readonly unsubscribe: ReturnType<typeof vi.fn>;
}

function fakeClient(
    operations: readonly ProtocolOperationName[] = ["project.list", "project.register", "watched_scan_intent.get"],
    overrides: Partial<DesktopApplicationClientApi> = {},
): FakeClientFixture {
    let invalidationListener: ((value: ProtocolInvalidationV1) => void) | undefined;
    const unsubscribe = vi.fn();
    const base = {
        availableOperations: operations,
        supportsOperation: vi.fn((operation: ProtocolOperationName) => operations.includes(operation)),
        listProjects: vi.fn(async () => ({ status: "complete", value: { projects: [PROJECT] }, diagnostics: [] })),
        registerProject: vi.fn(async () => ({ status: "complete", value: PROJECT, diagnostics: [] })),
        getWatchedScanIntent: vi.fn(async () => ({
            status: "complete",
            value: {
                configVersion: 1,
                settingId: "watched_scan_intent_v1",
                revision: 0,
                environments: [],
                updatedAt: 0,
                settingFingerprint: DIGEST,
            },
            diagnostics: [],
        })),
        subscribeInvalidation: vi.fn((listener: (value: ProtocolInvalidationV1) => void) => {
            invalidationListener = listener;
            return unsubscribe;
        }),
        ...overrides,
    } as unknown as DesktopApplicationClientApi;
    return { client: base, invalidate: (value) => invalidationListener?.(value), unsubscribe };
}

function readyState(controller: ProjectLibraryController): Extract<ProjectLibraryState, { readonly status: "ready" }> {
    expect(controller.state.status).toBe("ready");
    return controller.state as Extract<ProjectLibraryState, { readonly status: "ready" }>;
}

describe("ProjectLibraryController", () => {
    it("fails closed when required list operations are unavailable and ignores invalid actions before load", async () => {
        const fixture = fakeClient([]);
        const controller = new ProjectLibraryController(fixture.client);
        const states: ProjectLibraryState[] = [];
        const unsubscribeListener = controller.subscribe((state) => states.push(state));

        expect(controller.selectProject(PROJECT_ID)).toBe(false);
        expect(await controller.registerProject(" ")).toBeUndefined();
        await controller.load();

        expect(controller.state.status).toBe("failed");
        expect(states.map((state) => state.status)).toEqual(["loading", "failed"]);
        unsubscribeListener();
        controller.dispose();
        expect(fixture.unsubscribe).toHaveBeenCalledOnce();
    });

    it("loads partial Project results and marks only Project invalidations stale", async () => {
        const fixture = fakeClient(["project.list"], {
            listProjects: vi.fn(async () => ({
                status: "partial",
                value: { projects: [PROJECT, RETAINED_PROJECT] },
                diagnostics: [WARNING],
            })),
        });
        const controller = new ProjectLibraryController(fixture.client, PROJECT_ID);
        controller.subscribe(() => undefined);
        await controller.load();

        expect(readyState(controller)).toMatchObject({ selectedProjectId: PROJECT_ID });
        expect(fixture.client.getWatchedScanIntent).not.toHaveBeenCalled();
        expect(readyState(controller).retainedProjects).toEqual([RETAINED_PROJECT]);
        expect(fixture.client.listProjects).toHaveBeenCalledWith({ includeDeleted: true });
        expect(readyState(controller).diagnostics).toEqual([WARNING]);
        const restoredProject = { ...RETAINED_PROJECT, deleted: false, updatedAt: 3 };
        expect(controller.applyLifecycleProject(restoredProject)).toBe(restoredProject.projectId);
        expect(readyState(controller)).toMatchObject({
            selectedProjectId: restoredProject.projectId,
            retainedProjects: [],
        });
        expect(controller.applyLifecycleProject({ ...restoredProject, deleted: true, updatedAt: 4 })).toBe(PROJECT_ID);
        expect(readyState(controller).retainedProjects).toHaveLength(1);
        expect(controller.selectProject("44444444-4444-4444-8444-444444444444")).toBe(false);
        fixture.invalidate({ resourceKind: "deployment", deploymentId: "55555555-5555-4555-8555-555555555555" });
        expect(readyState(controller).stale).toBe(false);
        fixture.invalidate({ resourceKind: "collection", collection: "projects" });
        expect(readyState(controller).stale).toBe(true);
    });

    it("preserves explicit load failures and converts thrown reads into an interrupted failure", async () => {
        const failed = fakeClient(["project.list"], {
            listProjects: vi.fn(async () => ({ status: "failed", diagnostics: [ERROR] })),
        });
        const failedController = new ProjectLibraryController(failed.client);
        failedController.subscribe(() => undefined);
        await failedController.load();
        expect(failedController.state).toMatchObject({
            status: "failed",
            message: { kind: "localized", id: "library.load_failed" },
            diagnostics: [ERROR],
        });

        const interrupted = fakeClient(["project.list"], {
            listProjects: vi.fn(async () => {
                throw new Error("offline");
            }),
        });
        const interruptedController = new ProjectLibraryController(interrupted.client);
        interruptedController.subscribe(() => undefined);
        await interruptedController.load();
        expect(interruptedController.state).toMatchObject({ status: "failed", message: { kind: "localized" } });
    });

    it("handles successful, rejected, and interrupted Project registration without inventing a Project", async () => {
        const created = { ...PROJECT, projectId: "77777777-7777-4777-8777-777777777777", displayName: "New Project" };
        const successful = fakeClient(undefined, {
            registerProject: vi.fn(async () => ({ status: "complete", value: created, diagnostics: [WARNING] })),
        });
        const successfulController = new ProjectLibraryController(successful.client);
        successfulController.subscribe(() => undefined);
        await successfulController.load();
        expect(await successfulController.registerProject("token")).toBe(created.projectId);
        expect(readyState(successfulController)).toMatchObject({
            selectedProjectId: created.projectId,
            registeringProject: false,
        });
        expect(readyState(successfulController).diagnostics).toContainEqual(WARNING);

        const rejected = fakeClient(undefined, {
            registerProject: vi.fn(async () => ({ status: "failed", diagnostics: [ERROR] })),
        });
        const rejectedController = new ProjectLibraryController(rejected.client);
        rejectedController.subscribe(() => undefined);
        await rejectedController.load();
        expect(await rejectedController.registerProject("token")).toBeUndefined();
        expect(readyState(rejectedController)).toMatchObject({
            registeringProject: false,
            message: { kind: "localized", id: "library.project_register_failed" },
            diagnostics: [ERROR],
        });

        const interrupted = fakeClient(undefined, {
            registerProject: vi.fn(async () => {
                throw new Error("offline");
            }),
        });
        const interruptedController = new ProjectLibraryController(interrupted.client);
        interruptedController.subscribe(() => undefined);
        await interruptedController.load();
        expect(await interruptedController.registerProject("token")).toBeUndefined();
        expect(readyState(interruptedController)).toMatchObject({ registeringProject: false, message: { kind: "localized" } });
    });
});
