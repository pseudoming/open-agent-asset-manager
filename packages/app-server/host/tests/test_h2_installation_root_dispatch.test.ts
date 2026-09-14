import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createProtocolRequest, type ProtocolOperationOutcomeV1 } from "@oaam/app-server-protocol";
import type { CoreResult, CoreService, PlatformContext } from "@oaam/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchH2Long, type HostH2DispatchContext, type LongH2Request } from "../src/dispatch-h2";
import { HostPathSelectionStore } from "../src/path-selection-store";
import { HostReviewRecordStore } from "../src/review-record-store";
import { HostReviewRecords } from "../src/review-records";
import { createHostRenderApprovalAuthority } from "../src/render-approval-authority";
import { h2ProbeResult } from "./support/h2-review-fixtures";
import { fakeCoreWith } from "./support/host-test-fixtures";

const temporaryRoots: string[] = [];
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

function complete<T>(value: T): CoreResult<T> {
    return { status: "complete", value, diagnostics: [] };
}

function availableContexts(): CoreResult<PlatformContext[]> {
    return complete([{ platform: "linux", platformInstanceId: "local", accessRootPath: "/trusted" }]);
}

function context(): { readonly context: HostH2DispatchContext; readonly store: HostReviewRecordStore } {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-host-installation-root-"));
    temporaryRoots.push(rootPath);
    let pathNumber = 0;
    let recordNumber = 0;
    let memberNumber = 0;
    const store = new HostReviewRecordStore({
        rootPath,
        createToken: () => `review-${++recordNumber}`,
    });
    return {
        store,
        context: {
            connectionId: "connection",
            pathSelections: new HostPathSelectionStore({ createToken: () => `path-${++pathNumber}` }),
            reviews: new HostReviewRecords(store, () => `member-${++memberNumber}`),
            renderApprovals: createHostRenderApprovalAuthority(() => 1_234),
        },
    };
}

async function dispatch(
    core: CoreService,
    request: ReturnType<typeof createProtocolRequest>,
    dispatchContext: HostH2DispatchContext,
): Promise<ProtocolOperationOutcomeV1<unknown>> {
    return (await dispatchH2Long(core, request as LongH2Request, dispatchContext)) as ProtocolOperationOutcomeV1<unknown>;
}

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe("H2 installation-root dispatch", () => {
    it("consumes the exact token once without borrowing another path authority", async () => {
        const harness = context();
        const probeAdapters = vi.fn(async () => complete([h2ProbeResult()]));
        const core = fakeCoreWith({ getAvailablePlatformContexts: availableContexts, probeAdapters });
        const installationToken = harness.context.pathSelections.register("installation_root", "/trusted/tools/zcode");
        const params = {
            adapterIds: ["ZCODE"],
            environments: [{ platform: "linux" as const, platformInstanceId: "local" }],
            installationRootSelectionToken: installationToken,
            authorization: { scope: "global" as const },
        };

        await expect(
            dispatch(core, createProtocolRequest("selected-installation", "adapter.probe", params), harness.context),
        ).resolves.toMatchObject({ status: "complete" });
        expect(probeAdapters).toHaveBeenCalledWith(
            {
                adapterIds: ["ZCODE"],
                contexts: [{ platform: "linux", platformInstanceId: "local", accessRootPath: "/trusted" }],
                target: { authorizationScope: "global", installationRootPath: "/trusted/tools/zcode" },
            },
            expect.any(Function),
        );
        await expect(
            dispatch(core, createProtocolRequest("replayed-installation", "adapter.probe", params), harness.context),
        ).resolves.toMatchObject({ status: "failed", diagnostics: [{ code: "host.path_selection_unavailable" }] });

        const wrongKind = harness.context.pathSelections.register("project_root", "/trusted/project");
        await expect(
            dispatch(
                core,
                createProtocolRequest("wrong-kind-installation", "adapter.probe", {
                    ...params,
                    installationRootSelectionToken: wrongKind,
                }),
                harness.context,
            ),
        ).resolves.toMatchObject({ status: "failed", diagnostics: [{ code: "host.path_selection_unavailable" }] });
        expect(harness.context.pathSelections.consume(wrongKind, "project_root")).toBeNull();
        harness.store.close();
    });
});

describe("H2 registered Project probe dispatch", () => {
    it("resolves one active Core Project UUID without accepting a Client root", async () => {
        const harness = context();
        const probeAdapters = vi.fn(async () => complete([h2ProbeResult()]));
        const getProject = vi.fn(() =>
            complete({
                found: true as const,
                value: {
                    schemaVersion: 1 as const,
                    projectId: PROJECT_ID as never,
                    rootPath: "/registered-project",
                    displayName: "Registered Project",
                    deleted: false,
                    createdAt: 1 as never,
                    updatedAt: 1 as never,
                },
            }),
        );
        const core = fakeCoreWith({ getAvailablePlatformContexts: availableContexts, getProject, probeAdapters });
        const params = {
            adapterIds: ["CLAUDECODE"],
            environments: [{ platform: "linux" as const, platformInstanceId: "local" }],
            authorization: { scope: "registered_project" as const, projectId: PROJECT_ID },
        };

        await expect(
            dispatch(core, createProtocolRequest("registered-project", "adapter.probe", params), harness.context),
        ).resolves.toMatchObject({ status: "complete" });
        expect(getProject).toHaveBeenCalledWith(PROJECT_ID);
        expect(probeAdapters).toHaveBeenCalledWith(
            expect.objectContaining({
                target: { authorizationScope: "project", projectRootPath: "/registered-project" },
            }),
            expect.any(Function),
        );

        getProject.mockReturnValueOnce(complete({ found: false as const }));
        await expect(
            dispatch(core, createProtocolRequest("missing-registered-project", "adapter.probe", params), harness.context),
        ).resolves.toMatchObject({ status: "failed", diagnostics: [{ code: "host.path_selection_unavailable" }] });
        getProject.mockReturnValueOnce(
            complete({
                found: true as const,
                value: {
                    schemaVersion: 1 as const,
                    projectId: PROJECT_ID as never,
                    rootPath: "/retained-project",
                    displayName: "Retained Project",
                    deleted: true,
                    createdAt: 1 as never,
                    updatedAt: 2 as never,
                },
            }),
        );
        await expect(
            dispatch(core, createProtocolRequest("retained-project", "adapter.probe", params), harness.context),
        ).resolves.toMatchObject({ status: "failed", diagnostics: [{ code: "host.path_selection_unavailable" }] });
        getProject.mockReturnValueOnce({ status: "failed", diagnostics: [], value: undefined as never });
        await expect(
            dispatch(core, createProtocolRequest("unavailable-catalog", "adapter.probe", params), harness.context),
        ).resolves.toMatchObject({ status: "failed", diagnostics: [{ code: "host.path_selection_unavailable" }] });
        harness.store.close();
    });
});
