import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscoveryWorkspace } from "../src/renderer/features/discovery/DiscoveryWorkspace";
import { DiscoveryController } from "../src/renderer/features/discovery/discovery-controller";
import { GuidedImportPage } from "../src/renderer/pages/GuidedImportPage";
import { renderWithPresentation } from "./desktop-presentation-test-harness";
import { DIGEST, fakeDiscoveryClient } from "./discovery-test-fixtures";

const WINDOWS_ENVIRONMENT = { platform: "win32" as const, platformInstanceId: "desktop-local" };
const WSL_ENVIRONMENT = { platform: "wsl" as const, platformInstanceId: "Ubuntu" };
const SECOND_WSL_ENVIRONMENT = { platform: "wsl" as const, platformInstanceId: "Debian" };
const TARGET_PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ROOT_SELECTION_TOKEN = "project-root-selection-token";
const CODEX_PROVIDER = {
    adapterId: "CODEX",
    displayName: "Codex",
    version: "1.0.0",
    enabled: true,
    agentRuntimes: [{ agentRuntimeId: "CODEX_APP", displayName: "Codex App", entryClass: "app" as const }],
    sourceCapabilities: [],
    targetCapabilities: [],
};
const CODEX_REFERENCE = {
    adapterId: "CODEX",
    agentRuntimeId: "CODEX_APP",
    originEnvironment: WINDOWS_ENVIRONMENT,
    referencedEnvironment: WSL_ENVIRONMENT,
    referenceKind: "project" as const,
    validationState: "not_checked" as const,
};

function environmentClient(
    probeGlobal: ReturnType<typeof vi.fn>,
    environments = [
        { environment: WSL_ENVIRONMENT, displayName: "WSL · Ubuntu" },
        { environment: WINDOWS_ENVIRONMENT, displayName: "Windows" },
    ],
) {
    return fakeDiscoveryClient({
        listEnvironments: vi.fn(async () => ({
            status: "complete",
            value: { environments },
            diagnostics: [],
        })),
        probeGlobal,
    });
}

function successfulProbe() {
    return vi.fn(async () => ({
        status: "complete" as const,
        value: { probeToken: "environment-probe", results: [] },
        diagnostics: [],
    }));
}

function codexEnvironmentClient(probeGlobal: ReturnType<typeof vi.fn>, listProbeEnvironmentReferences: ReturnType<typeof vi.fn>) {
    return fakeDiscoveryClient({
        supportsOperation: vi.fn((operation) => operation === "probe_environment_reference.list"),
        listAdapterProviders: vi.fn(async () => ({
            status: "complete" as const,
            value: { providers: [CODEX_PROVIDER] },
            diagnostics: [],
        })),
        getAdapterEnablement: vi.fn(async () => ({
            status: "complete" as const,
            value: {
                configVersion: 1 as const,
                settingId: "adapter_enablement_v1" as const,
                revision: 1,
                enabledAdapterIds: ["CODEX"],
                userActionEvidenceId: "codex-enabled",
                updatedAt: 1,
                settingFingerprint: DIGEST,
            },
            diagnostics: [],
        })),
        listEnvironments: vi.fn(async () => ({
            status: "complete" as const,
            value: {
                environments: [
                    { environment: WINDOWS_ENVIRONMENT, displayName: "Local Windows" },
                    { environment: WSL_ENVIRONMENT, displayName: "WSL — Ubuntu" },
                ],
            },
            diagnostics: [],
        })),
        probeGlobal,
        listProbeEnvironmentReferences,
    });
}

function projectEnvironmentClient(
    probeProject: ReturnType<typeof vi.fn>,
    rootPath: string,
    options: {
        readonly environments?: readonly {
            readonly environment: typeof WINDOWS_ENVIRONMENT | typeof WSL_ENVIRONMENT | typeof SECOND_WSL_ENVIRONMENT;
            readonly displayName: string;
        }[];
        readonly watchedEnvironment?: typeof WSL_ENVIRONMENT | typeof SECOND_WSL_ENVIRONMENT;
    } = {},
) {
    const environments = options.environments ?? [
        { environment: SECOND_WSL_ENVIRONMENT, displayName: "WSL · Debian" },
        { environment: WSL_ENVIRONMENT, displayName: "WSL · Ubuntu" },
        { environment: WINDOWS_ENVIRONMENT, displayName: "Windows" },
    ];
    return fakeDiscoveryClient({
        listEnvironments: vi.fn(async () => ({
            status: "complete" as const,
            value: {
                environments,
            },
            diagnostics: [],
        })),
        ...(options.watchedEnvironment === undefined
            ? {}
            : {
                  getWatchedScanIntent: vi.fn(async () => ({
                      status: "complete" as const,
                      value: {
                          configVersion: 1 as const,
                          settingId: "watched_scan_intent_v1" as const,
                          revision: 1,
                          environments: [
                              {
                                  environment: options.watchedEnvironment,
                                  sourceSelectors: [
                                      {
                                          disposition: "included" as const,
                                          source: {
                                              adapterId: "CLAUDECODE",
                                              rootRole: "project_actual" as const,
                                              sourceDomain: "project_root" as const,
                                              canonicalPath: rootPath,
                                              locatorIdentities: [
                                                  {
                                                      locatorKind: "runtime_known_rule" as const,
                                                      locatorKey: "exact-project-root",
                                                  },
                                              ],
                                          },
                                          agentRuntimeIds: ["CLAUDE_CODE_CLI"],
                                          binding: { assetScope: "project" as const, projectId: TARGET_PROJECT_ID },
                                          selectorFingerprint: DIGEST,
                                      },
                                  ],
                              },
                          ],
                          userActionEvidenceId: "project-environment-choice",
                          updatedAt: 1,
                          settingFingerprint: DIGEST,
                      },
                      diagnostics: [],
                  })),
              }),
        listProjects: vi.fn(async () => ({
            status: "complete" as const,
            value: {
                projects: [
                    {
                        projectId: TARGET_PROJECT_ID,
                        displayName: "Exact Project",
                        rootPath,
                        deleted: false,
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
            },
            diagnostics: [],
        })),
        probeProject,
    });
}

function authorizedProjectRoot(displayPath: string) {
    return vi.fn(async () => ({
        status: "authorized" as const,
        displayPath,
        localPathSelectionToken: PROJECT_ROOT_SELECTION_TOKEN,
    }));
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

function environmentCheckbox(platform: string, platformInstanceId: string): HTMLInputElement {
    const card = [...document.querySelectorAll<HTMLElement>(".environment-card")].find(
        (candidate) =>
            candidate.dataset.oaamEnvironmentPlatform === platform &&
            candidate.dataset.oaamEnvironmentInstance === platformInstanceId,
    );
    if (card === undefined) throw new Error(`Missing environment ${platform}/${platformInstanceId}`);
    const input = card.querySelector<HTMLInputElement>("input");
    if (input === null) throw new Error(`Missing environment input ${platform}/${platformInstanceId}`);
    return input;
}

afterEach(() => {
    cleanup();
});

describe("Desktop Windows and WSL discovery choice", () => {
    it("moves Settings focus to the existing environment choices without selecting or probing Ubuntu", async () => {
        const probeGlobal = successfulProbe();
        const references = vi.fn(async () => ({
            status: "complete" as const,
            value: { references: [CODEX_REFERENCE] },
            diagnostics: [],
        }));
        const controller = new DiscoveryController(codexEnvironmentClient(probeGlobal, references), {
            createUserActionId: () => "action",
            autoProbeWatched: false,
        });
        renderWithPresentation(createElement(DiscoveryWorkspace, { controller }));
        await screen.findByRole("checkbox", { name: /Local Windows/u });
        await act(async () => {
            await controller.probe();
        });
        fireEvent.click(await screen.findByRole("button", { name: "Choose environments" }));
        expect(document.activeElement?.id).toBe("oaam-discovery-environments");
        expect(environmentCheckbox("wsl", "Ubuntu").checked).toBe(false);
        expect(probeGlobal).toHaveBeenCalledTimes(1);
        expect(references).toHaveBeenCalledTimes(1);
        controller.dispose();
    });
    it("retains only the probe-owned unchecked reference until Ubuntu is explicitly selected and checked", async () => {
        const probeGlobal = successfulProbe();
        const listProbeEnvironmentReferences = vi
            .fn()
            .mockResolvedValueOnce({
                status: "complete" as const,
                value: { references: [CODEX_REFERENCE] },
                diagnostics: [],
            })
            .mockResolvedValueOnce({ status: "complete" as const, value: { references: [] }, diagnostics: [] });
        const client = codexEnvironmentClient(probeGlobal, listProbeEnvironmentReferences);
        const controller = new DiscoveryController(client, { createUserActionId: () => "action" });

        await controller.load();
        await controller.probe();
        expect(listProbeEnvironmentReferences).toHaveBeenLastCalledWith({ probeToken: "environment-probe" });
        expect(controller.state).toMatchObject({
            status: "ready",
            selectedEnvironmentKeys: ["win32\0desktop-local"],
            environmentReferences: [CODEX_REFERENCE],
        });

        controller.toggleEnvironment("wsl\0Ubuntu");
        expect(controller.state).toMatchObject({
            status: "ready",
            selectedEnvironmentKeys: ["win32\0desktop-local", "wsl\0Ubuntu"],
            probeReview: undefined,
            environmentReferences: [],
        });
        expect(probeGlobal).toHaveBeenCalledTimes(1);
        expect(listProbeEnvironmentReferences).toHaveBeenCalledTimes(1);

        await controller.probe();
        expect(probeGlobal).toHaveBeenCalledTimes(2);
        expect(probeGlobal).toHaveBeenLastCalledWith(
            ["CODEX"],
            [WINDOWS_ENVIRONMENT, WSL_ENVIRONMENT],
            undefined,
            expect.any(Function),
        );
        expect(controller.state).toMatchObject({ status: "ready", environmentReferences: [] });
    });

    it.each([
        "back",
        "choose_environments",
    ] as const)("keeps hint-only Results and returns without new authority through %s", async (entry) => {
        const probeGlobal = successfulProbe();
        const listProbeEnvironmentReferences = vi
            .fn()
            .mockResolvedValueOnce({
                status: "complete" as const,
                value: { references: [CODEX_REFERENCE] },
                diagnostics: [],
            })
            .mockResolvedValueOnce({ status: "complete" as const, value: { references: [] }, diagnostics: [] });
        const client = codexEnvironmentClient(probeGlobal, listProbeEnvironmentReferences);
        const { container } = renderWithPresentation(
            createElement(GuidedImportPage, { client, assetCount: 0, onClose: vi.fn() }),
        );

        const windows = await screen.findByRole("checkbox", { name: /Local Windows/u });
        expect((windows as HTMLInputElement).checked).toBe(true);
        fireEvent.click(screen.getByRole("button", { name: "Continue" }));
        expect(await screen.findByRole("heading", { name: "Which tools do you use?" })).not.toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Start scan" }));

        const notice = await screen.findByText(
            "Codex App references a project in Ubuntu. It has not been checked. Select Ubuntu and continue to check it.",
        );
        expect(container.querySelector("[data-oaam-step='results']")).not.toBeNull();
        expect(container.querySelector("[data-oaam-step='complete']")).toBeNull();
        expect(notice).toMatchObject({
            dataset: expect.objectContaining({
                oaamReferenceKind: "project",
                oaamReferenceState: "not_checked",
                oaamReferenceRuntimeId: "CODEX_APP",
                oaamReferenceOriginPlatform: "win32",
                oaamReferenceOriginInstance: "desktop-local",
                oaamReferenceTargetPlatform: "wsl",
                oaamReferenceTargetInstance: "Ubuntu",
            }),
        });
        expect(container.querySelector(".discovery-workspace")).toMatchObject({
            dataset: expect.objectContaining({
                oaamJourneyStage: "results",
                oaamUncheckedReferenceCount: "1",
                oaamSelectedEnvironments: '["[\\"win32\\",\\"desktop-local\\"]"]',
            }),
        });
        expect(container.innerHTML).not.toMatch(
            /environment-probe|private-reference|private-locator|config\.toml|\\\\wsl\.localhost/u,
        );
        expect(screen.queryByRole("button", { name: "Add Project" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Review Assets" })).toBeNull();

        if (entry === "back") {
            fireEvent.click(screen.getByRole("button", { name: "Back" }));
            expect(await screen.findByRole("heading", { name: "Which tools do you use?" })).not.toBeNull();
            fireEvent.click(screen.getByRole("button", { name: "Back" }));
        } else {
            fireEvent.click(screen.getByRole("button", { name: "Choose environments" }));
        }
        expect(await screen.findByRole("heading", { name: "Where should OAAM look?" })).not.toBeNull();
        const returnedWindows = screen.getByRole("checkbox", { name: /Local Windows/u });
        const ubuntu = screen.getByRole("checkbox", { name: /WSL — Ubuntu/u });
        expect((returnedWindows as HTMLInputElement).checked).toBe(true);
        expect((ubuntu as HTMLInputElement).checked).toBe(false);
        expect(probeGlobal).toHaveBeenCalledTimes(1);

        fireEvent.click(ubuntu);
        expect((ubuntu as HTMLInputElement).checked).toBe(true);
        expect(screen.queryByText(/Codex App references a project/u)).toBeNull();
        expect(probeGlobal).toHaveBeenCalledTimes(1);
        expect(listProbeEnvironmentReferences).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByRole("button", { name: "Continue" }));
        fireEvent.click(await screen.findByRole("button", { name: "Start scan" }));
        await vi.waitFor(() => expect(probeGlobal).toHaveBeenCalledTimes(2));
        expect(probeGlobal).toHaveBeenLastCalledWith(
            ["CODEX"],
            [WINDOWS_ENVIRONMENT, WSL_ENVIRONMENT],
            undefined,
            expect.any(Function),
        );
    });

    it("selects Windows by default and probes every explicitly selected environment", async () => {
        const probeGlobal = successfulProbe();
        const controller = new DiscoveryController(environmentClient(probeGlobal), {
            createUserActionId: () => "action",
        });
        await controller.load();
        expect(controller.state).toMatchObject({ status: "ready", selectedEnvironmentKeys: ["win32\0desktop-local"] });
        expect(probeGlobal).not.toHaveBeenCalled();
        await controller.probe();
        expect(probeGlobal).toHaveBeenLastCalledWith(["CLAUDECODE"], [WINDOWS_ENVIRONMENT], undefined, expect.any(Function));

        controller.toggleEnvironment("wsl\0Ubuntu");
        expect(controller.state).toMatchObject({
            status: "ready",
            selectedEnvironmentKeys: ["win32\0desktop-local", "wsl\0Ubuntu"],
        });
        expect(probeGlobal).toHaveBeenCalledTimes(1);
        await controller.probe();
        expect(probeGlobal).toHaveBeenCalledTimes(2);
        expect(probeGlobal).toHaveBeenLastCalledWith(
            ["CLAUDECODE"],
            [WINDOWS_ENVIRONMENT, WSL_ENVIRONMENT],
            undefined,
            expect.any(Function),
        );

        controller.toggleEnvironment("win32\0desktop-local");
        await controller.probe();
        expect(probeGlobal).toHaveBeenCalledTimes(3);
        expect(probeGlobal).toHaveBeenLastCalledWith(["CLAUDECODE"], [WSL_ENVIRONMENT], undefined, expect.any(Function));

        controller.toggleEnvironment("wsl\0Ubuntu");
        expect(controller.state).toMatchObject({ status: "ready", selectedEnvironmentKeys: [] });
        await controller.probe();
        expect(probeGlobal).toHaveBeenCalledTimes(3);
        expect(controller.state).toMatchObject({ status: "ready", activity: "probe_failed" });
    });

    it("keeps every explicitly selected WSL distribution in deterministic selection order", async () => {
        const probeGlobal = successfulProbe();
        const controller = new DiscoveryController(
            environmentClient(probeGlobal, [
                { environment: SECOND_WSL_ENVIRONMENT, displayName: "WSL · Debian" },
                { environment: WSL_ENVIRONMENT, displayName: "WSL · Ubuntu" },
                { environment: WINDOWS_ENVIRONMENT, displayName: "Windows" },
            ]),
            { createUserActionId: () => "action" },
        );
        await controller.load();

        controller.toggleEnvironment("wsl\0Debian");
        controller.toggleEnvironment("wsl\0Ubuntu");
        await controller.probe();

        expect(probeGlobal).toHaveBeenCalledWith(
            ["CLAUDECODE"],
            [WINDOWS_ENVIRONMENT, SECOND_WSL_ENVIRONMENT, WSL_ENVIRONMENT],
            undefined,
            expect.any(Function),
        );
    });

    it("renders checkboxes, keeps Windows selected, and adds WSL without probing", async () => {
        const probeGlobal = successfulProbe();
        const controller = new DiscoveryController(environmentClient(probeGlobal), {
            createUserActionId: () => "action",
        });
        renderWithPresentation(createElement(DiscoveryWorkspace, { controller, onReviewSources: vi.fn() }));

        const windows = await screen.findByRole("checkbox", {
            name: /This Windows computer is selected by default/u,
        });
        const wsl = screen.getByRole("checkbox", { name: /Select this WSL distribution/u });
        expect((windows as HTMLInputElement).checked).toBe(true);
        expect((wsl as HTMLInputElement).checked).toBe(false);
        expect(windows.closest("label")).toMatchObject({
            dataset: expect.objectContaining({
                oaamEnvironmentPlatform: "win32",
                oaamEnvironmentInstance: "desktop-local",
            }),
        });
        expect(wsl.closest("label")).toMatchObject({
            dataset: expect.objectContaining({ oaamEnvironmentPlatform: "wsl", oaamEnvironmentInstance: "Ubuntu" }),
        });
        const workspace = document.querySelector(".discovery-workspace");
        expect(workspace).toMatchObject({
            dataset: expect.objectContaining({
                oaamDiscoveryActivity: "idle",
                oaamEnabledAdapterIds: '["CLAUDECODE"]',
                oaamProbedEnvironments: "[]",
                oaamProbedSourcePaths: "[]",
                oaamSelectedEnvironments: '["[\\"win32\\",\\"desktop-local\\"]"]',
            }),
        });
        expect(probeGlobal).not.toHaveBeenCalled();

        fireEvent.click(wsl);
        expect((windows as HTMLInputElement).checked).toBe(true);
        expect((wsl as HTMLInputElement).checked).toBe(true);
        expect(workspace).toMatchObject({
            dataset: expect.objectContaining({
                oaamSelectedEnvironments: '["[\\"wsl\\",\\"Ubuntu\\"]","[\\"win32\\",\\"desktop-local\\"]"]',
            }),
        });
        expect(probeGlobal).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Scan now" }));
        await vi.waitFor(() =>
            expect(probeGlobal).toHaveBeenCalledWith(
                ["CLAUDECODE"],
                [WINDOWS_ENVIRONMENT, WSL_ENVIRONMENT],
                undefined,
                expect.any(Function),
            ),
        );
    });

    it("locks a WSL Project import to its exact registered distribution", async () => {
        const projectPath = "\\\\wsl.localhost\\Ubuntu\\home\\example\\work\\exact-project";
        const probeProject = successfulProbe();
        const client = projectEnvironmentClient(probeProject, projectPath);
        const authorizeRegisteredProjectRoot = authorizedProjectRoot(projectPath);
        const controller = new DiscoveryController(client, {
            createUserActionId: () => "action",
            targetProjectId: TARGET_PROJECT_ID,
        });
        renderWithPresentation(
            createElement(DiscoveryWorkspace, {
                controller,
                targetProjectId: TARGET_PROJECT_ID,
                authorizeRegisteredProjectRoot,
                onReviewSources: vi.fn(),
            }),
        );
        await screen.findByText("This Project is here, so this is the only location used for this import.");

        const windows = environmentCheckbox("win32", "desktop-local");
        const ubuntu = environmentCheckbox("wsl", "Ubuntu");
        const debian = environmentCheckbox("wsl", "Debian");
        expect(ubuntu.checked).toBe(true);
        expect(ubuntu.disabled).toBe(false);
        expect(windows.checked).toBe(false);
        expect(windows.disabled).toBe(true);
        expect(debian.checked).toBe(false);
        expect(debian.disabled).toBe(true);

        const windowsCard = windows.closest("label");
        expect(windowsCard).not.toBeNull();
        fireEvent.pointerEnter(windowsCard as HTMLLabelElement);
        expect(
            screen.getByRole("tooltip", {
                name: "To avoid reading or writing Assets in the wrong system location, this environment is unavailable for this Project.",
            }),
        ).toBeTruthy();
        fireEvent.pointerLeave(windowsCard as HTMLLabelElement);
        expect(windowsCard?.tabIndex).toBe(0);
        fireEvent.focus(windowsCard as HTMLLabelElement);
        expect(screen.getByRole("tooltip").textContent).toBe(
            "To avoid reading or writing Assets in the wrong system location, this environment is unavailable for this Project.",
        );
        fireEvent.blur(windowsCard as HTMLLabelElement);

        fireEvent.click(windows);
        fireEvent.click(debian);
        expect(controller.state).toMatchObject({ selectedEnvironmentKeys: ["wsl\0Ubuntu"] });
        fireEvent.click(screen.getByRole("button", { name: "Scan now" }));
        await vi.waitFor(() =>
            expect(probeProject).toHaveBeenCalledWith(
                ["CLAUDECODE"],
                [WSL_ENVIRONMENT],
                PROJECT_ROOT_SELECTION_TOKEN,
                undefined,
                expect.any(Function),
            ),
        );
        expect(authorizeRegisteredProjectRoot).toHaveBeenCalledWith(TARGET_PROJECT_ID);
        expect(client.probeGlobal).not.toHaveBeenCalled();
    });

    it("locks a Windows Project import to Windows and disables every WSL distribution", async () => {
        const projectPath = "C:\\work\\exact-project";
        const probeProject = successfulProbe();
        const client = projectEnvironmentClient(probeProject, projectPath);
        const authorizeRegisteredProjectRoot = authorizedProjectRoot(projectPath);
        const controller = new DiscoveryController(client, {
            createUserActionId: () => "action",
            targetProjectId: TARGET_PROJECT_ID,
        });
        renderWithPresentation(
            createElement(DiscoveryWorkspace, {
                controller,
                targetProjectId: TARGET_PROJECT_ID,
                authorizeRegisteredProjectRoot,
                onReviewSources: vi.fn(),
            }),
        );
        await screen.findByText("This Project is here, so this is the only location used for this import.");

        const windows = environmentCheckbox("win32", "desktop-local");
        const ubuntu = environmentCheckbox("wsl", "Ubuntu");
        const debian = environmentCheckbox("wsl", "Debian");
        expect(windows.checked).toBe(true);
        expect(windows.disabled).toBe(false);
        expect(ubuntu.checked).toBe(false);
        expect(ubuntu.disabled).toBe(true);
        expect(debian.checked).toBe(false);
        expect(debian.disabled).toBe(true);

        fireEvent.click(ubuntu);
        expect(controller.state).toMatchObject({ selectedEnvironmentKeys: ["win32\0desktop-local"] });
        fireEvent.click(screen.getByRole("button", { name: "Scan now" }));
        await vi.waitFor(() =>
            expect(probeProject).toHaveBeenCalledWith(
                ["CLAUDECODE"],
                [WINDOWS_ENVIRONMENT],
                PROJECT_ROOT_SELECTION_TOKEN,
                undefined,
                expect.any(Function),
            ),
        );
        expect(authorizeRegisteredProjectRoot).toHaveBeenCalledWith(TARGET_PROJECT_ID);
        expect(client.probeGlobal).not.toHaveBeenCalled();
    });

    it("fails closed when the registered Project root cannot be authorized", async () => {
        const probeProject = successfulProbe();
        const client = projectEnvironmentClient(probeProject, "C:\\work\\exact-project");
        const authorizeRegisteredProjectRoot = vi.fn(async () => ({
            status: "failed" as const,
            code: "unavailable" as const,
        }));
        const controller = new DiscoveryController(client, {
            createUserActionId: () => "action",
            targetProjectId: TARGET_PROJECT_ID,
        });
        renderWithPresentation(
            createElement(DiscoveryWorkspace, {
                controller,
                targetProjectId: TARGET_PROJECT_ID,
                authorizeRegisteredProjectRoot,
                onReviewSources: vi.fn(),
            }),
        );

        await screen.findByText("This Project is here, so this is the only location used for this import.");
        fireEvent.click(screen.getByRole("button", { name: "Scan now" }));

        expect(
            await screen.findByText(
                "OAAM could not use this Project's registered folder. Return to Project settings to check the location.",
            ),
        ).not.toBeNull();
        expect(authorizeRegisteredProjectRoot).toHaveBeenCalledWith(TARGET_PROJECT_ID);
        expect(probeProject).not.toHaveBeenCalled();
        expect(client.probeGlobal).not.toHaveBeenCalled();
    });

    it("keeps registered Project authorization and probing single-flight", async () => {
        const projectPath = "C:\\work\\exact-project";
        const authorization = deferred<{
            readonly status: "authorized";
            readonly displayPath: string;
            readonly localPathSelectionToken: string;
        }>();
        const probeProject = successfulProbe();
        const client = projectEnvironmentClient(probeProject, projectPath);
        const authorizeRegisteredProjectRoot = vi.fn(() => authorization.promise);
        const controller = new DiscoveryController(client, {
            createUserActionId: () => "action",
            targetProjectId: TARGET_PROJECT_ID,
        });
        renderWithPresentation(
            createElement(DiscoveryWorkspace, {
                controller,
                targetProjectId: TARGET_PROJECT_ID,
                authorizeRegisteredProjectRoot,
                onReviewSources: vi.fn(),
            }),
        );

        await screen.findByText("This Project is here, so this is the only location used for this import.");
        const action = screen.getByRole<HTMLButtonElement>("button", { name: "Scan now" });
        fireEvent.click(action);
        fireEvent.click(action);
        await vi.waitFor(() => expect(authorizeRegisteredProjectRoot).toHaveBeenCalledOnce());
        expect(action.disabled).toBe(true);
        expect(probeProject).not.toHaveBeenCalled();

        authorization.resolve({
            status: "authorized",
            displayPath: projectPath,
            localPathSelectionToken: PROJECT_ROOT_SELECTION_TOKEN,
        });
        await vi.waitFor(() => expect(probeProject).toHaveBeenCalledOnce());
        expect(client.probeGlobal).not.toHaveBeenCalled();
    });

    it("uses the retained Project-bound WSL identity for a POSIX Project root", async () => {
        const probeGlobal = successfulProbe();
        const controller = new DiscoveryController(
            projectEnvironmentClient(probeGlobal, "/home/example/work/exact-project", { watchedEnvironment: WSL_ENVIRONMENT }),
            { createUserActionId: () => "action", targetProjectId: TARGET_PROJECT_ID },
        );
        renderWithPresentation(
            createElement(DiscoveryWorkspace, { controller, targetProjectId: TARGET_PROJECT_ID, onReviewSources: vi.fn() }),
        );
        await screen.findByText("This Project is here, so this is the only location used for this import.");

        expect(environmentCheckbox("wsl", "Ubuntu")).toMatchObject({ checked: true, disabled: false, type: "radio" });
        expect(environmentCheckbox("wsl", "Debian")).toMatchObject({ checked: false, disabled: true, type: "radio" });
        expect(environmentCheckbox("win32", "desktop-local")).toMatchObject({
            checked: false,
            disabled: true,
            type: "radio",
        });
    });

    it("auto-selects one WSL environment for an unbound POSIX Project root", async () => {
        const controller = new DiscoveryController(
            projectEnvironmentClient(successfulProbe(), "/home/example/work/exact-project", {
                environments: [
                    { environment: WSL_ENVIRONMENT, displayName: "WSL · Ubuntu" },
                    { environment: WINDOWS_ENVIRONMENT, displayName: "Windows" },
                ],
            }),
            { createUserActionId: () => "action", targetProjectId: TARGET_PROJECT_ID },
        );
        await controller.load();

        expect(controller.state).toMatchObject({ selectedEnvironmentKeys: ["wsl\0Ubuntu"] });
        expect(controller.isEnvironmentSelectable("wsl\0Ubuntu")).toBe(true);
        expect(controller.isEnvironmentSelectable("win32\0desktop-local")).toBe(false);
    });

    it("requires exactly one explicit WSL choice when an unbound POSIX Project has multiple distributions", async () => {
        const projectPath = "/home/example/work/exact-project";
        const probeProject = successfulProbe();
        const client = projectEnvironmentClient(probeProject, projectPath);
        const authorizeRegisteredProjectRoot = authorizedProjectRoot(projectPath);
        const controller = new DiscoveryController(client, {
            createUserActionId: () => "action",
            targetProjectId: TARGET_PROJECT_ID,
        });
        renderWithPresentation(
            createElement(DiscoveryWorkspace, {
                controller,
                targetProjectId: TARGET_PROJECT_ID,
                authorizeRegisteredProjectRoot,
                onReviewSources: vi.fn(),
            }),
        );
        await screen.findAllByText("Choose the one location that contains this Project; only one can be used for this import.");

        const windows = environmentCheckbox("win32", "desktop-local");
        const ubuntu = environmentCheckbox("wsl", "Ubuntu");
        const debian = environmentCheckbox("wsl", "Debian");
        expect(windows).toMatchObject({ checked: false, disabled: true, type: "radio" });
        expect(ubuntu).toMatchObject({ checked: false, disabled: false, type: "radio" });
        expect(debian).toMatchObject({ checked: false, disabled: false, type: "radio" });
        expect(controller.state).toMatchObject({ selectedEnvironmentKeys: [] });

        fireEvent.click(ubuntu);
        expect(controller.state).toMatchObject({ selectedEnvironmentKeys: ["wsl\0Ubuntu"] });
        fireEvent.click(debian);
        expect(controller.state).toMatchObject({ selectedEnvironmentKeys: ["wsl\0Debian"] });
        fireEvent.click(debian);
        expect(controller.state).toMatchObject({ selectedEnvironmentKeys: ["wsl\0Debian"] });
        fireEvent.click(screen.getByRole("button", { name: "Scan now" }));
        await vi.waitFor(() =>
            expect(probeProject).toHaveBeenCalledWith(
                ["CLAUDECODE"],
                [SECOND_WSL_ENVIRONMENT],
                PROJECT_ROOT_SELECTION_TOKEN,
                undefined,
                expect.any(Function),
            ),
        );
        expect(authorizeRegisteredProjectRoot).toHaveBeenCalledWith(TARGET_PROJECT_ID);
        expect(client.probeGlobal).not.toHaveBeenCalled();
    });

    it("passes the guided Project identity into the environment constraint before any scan", async () => {
        renderWithPresentation(
            createElement(GuidedImportPage, {
                client: projectEnvironmentClient(
                    successfulProbe(),
                    "\\\\wsl.localhost\\Ubuntu\\home\\example\\work\\exact-project",
                ),
                assetCount: 0,
                targetProjectId: TARGET_PROJECT_ID,
                onClose: vi.fn(),
            }),
        );

        await screen.findByRole("heading", { name: "Where should OAAM look?" });
        expect(environmentCheckbox("wsl", "Ubuntu")).toMatchObject({ checked: true, disabled: false });
        expect(environmentCheckbox("win32", "desktop-local")).toMatchObject({ checked: false, disabled: true });
        expect(environmentCheckbox("wsl", "Debian")).toMatchObject({ checked: false, disabled: true });
    });
});
