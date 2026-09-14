import { cleanup, fireEvent, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApplicationClientApi } from "../src/renderer/client/desktop-application-client";
import { GuidedImportPage } from "../src/renderer/pages/GuidedImportPage";
import { renderWithPresentation } from "./desktop-presentation-test-harness";
import { EMPTY_WATCHED, ENABLEMENT, fakeDiscoveryClient, probeSource } from "./discovery-test-fixtures";

afterEach(cleanup);

describe("Desktop guided-import environment selection", () => {
    it("keeps Windows and WSL as an explicit multi-select location step without probing", async () => {
        const client = fakeDiscoveryClient({
            listEnvironments: vi.fn(async () => ({
                status: "complete" as const,
                value: {
                    environments: [
                        {
                            environment: { platform: "win32" as const, platformInstanceId: "desktop-local" },
                            displayName: "Local Windows",
                        },
                        {
                            environment: { platform: "wsl" as const, platformInstanceId: "Ubuntu" },
                            displayName: "WSL — Ubuntu",
                        },
                    ],
                },
                diagnostics: [],
            })),
        });
        renderWithPresentation(createElement(GuidedImportPage, { client, assetCount: 0, onClose: vi.fn() }));

        const windows = await screen.findByRole("checkbox", { name: /Local Windows/u });
        const wsl = screen.getByRole("checkbox", { name: /WSL — Ubuntu/u });
        expect((windows as HTMLInputElement).checked).toBe(true);
        expect((wsl as HTMLInputElement).checked).toBe(false);
        expect(document.querySelector("[data-oaam-step='locations']")).not.toBeNull();
        expect(client.probeGlobal).not.toHaveBeenCalled();

        fireEvent.click(wsl);
        fireEvent.click(screen.getByRole("button", { name: "Continue" }));
        expect(await screen.findByRole("heading", { name: "Which tools do you use?" })).not.toBeNull();
        expect(client.probeGlobal).not.toHaveBeenCalled();
    });

    it("keeps a historical Windows location out of a current WSL-only ZCode journey", async () => {
        const windows = { platform: "win32" as const, platformInstanceId: "desktop-local" };
        const wsl = { platform: "wsl" as const, platformInstanceId: "Ubuntu" };
        const wslSourcePath = "/home/user/.zcode";
        const historicalWindowsPath = "C:\\Users\\user\\.zcode";
        const readSources = vi.fn<DesktopApplicationClientApi["readSources"]>(async () => ({
            status: "complete",
            value: {
                readToken: "wsl-zcode-read",
                reports: [
                    {
                        adapterId: "ZCODE",
                        agentRuntimeId: "ZCODE_APP",
                        sourceRootId: "root-zcode-wsl-source",
                        status: "complete",
                        candidateCount: 0,
                        diagnostics: [],
                    },
                ],
                candidateCount: 0,
            },
            diagnostics: [],
        }));
        const client = fakeDiscoveryClient({
            listAdapterProviders: vi.fn(async () => ({
                status: "complete",
                value: {
                    providers: [
                        {
                            adapterId: "ZCODE",
                            displayName: "ZCode",
                            version: "1.0.0",
                            enabled: true,
                            agentRuntimes: [
                                {
                                    agentRuntimeId: "ZCODE_APP",
                                    displayName: "ZCode App",
                                    entryClass: "app" as const,
                                },
                            ],
                            sourceCapabilities: [],
                            targetCapabilities: [],
                        },
                    ],
                },
                diagnostics: [],
            })),
            getAdapterEnablement: vi.fn(async () => ({
                status: "complete",
                value: { ...ENABLEMENT, enabledAdapterIds: ["ZCODE"] },
                diagnostics: [],
            })),
            getWatchedScanIntent: vi.fn(async () => ({
                status: "complete",
                value: {
                    ...EMPTY_WATCHED,
                    revision: 1,
                    environments: [
                        {
                            environment: windows,
                            sourceSelectors: [
                                {
                                    disposition: "included" as const,
                                    source: {
                                        adapterId: "ZCODE",
                                        rootRole: "source" as const,
                                        sourceDomain: "agent_runtime_private" as const,
                                        canonicalPath: historicalWindowsPath,
                                        locatorIdentities: [
                                            {
                                                locatorKind: "runtime_known_rule" as const,
                                                locatorKey: "historical-windows-zcode",
                                            },
                                        ],
                                    },
                                    agentRuntimeIds: ["ZCODE_APP"],
                                    binding: { assetScope: "global" as const },
                                    selectorFingerprint: "d".repeat(64),
                                },
                            ],
                        },
                    ],
                },
                diagnostics: [],
            })),
            listEnvironments: vi.fn(async () => ({
                status: "complete",
                value: {
                    environments: [
                        { environment: windows, displayName: "Local Windows" },
                        { environment: wsl, displayName: "WSL — Ubuntu" },
                    ],
                },
                diagnostics: [],
            })),
            probeGlobal: vi.fn(async () => ({
                status: "complete",
                value: {
                    probeToken: "wsl-zcode-probe",
                    results: [
                        {
                            rowId: "zcode-wsl-result",
                            adapterId: "ZCODE",
                            environment: wsl,
                            status: "complete" as const,
                            runtimes: [
                                {
                                    rowId: "zcode-wsl-runtime",
                                    agentRuntimeId: "ZCODE_APP",
                                    versionText: "1.0.0",
                                    installationStatus: "available" as const,
                                    projectDiscoveryStatus: "complete" as const,
                                    sourceRootRowIds: ["zcode-wsl-source"],
                                    diagnostics: [],
                                },
                            ],
                            sources: [
                                {
                                    ...probeSource("zcode-wsl-source", "zcode-wsl", wslSourcePath),
                                    sourceDomain: "agent_runtime_private" as const,
                                },
                            ],
                            projects: [],
                            targets: [],
                            diagnostics: [],
                        },
                    ],
                },
                diagnostics: [],
            })),
            readSources,
        });
        const { container } = renderWithPresentation(
            createElement(GuidedImportPage, { client, assetCount: 0, onClose: vi.fn() }),
        );
        const localWindows = await screen.findByRole("checkbox", { name: /Local Windows/u });
        const ubuntu = screen.getByRole("checkbox", { name: /WSL — Ubuntu/u });
        fireEvent.click(localWindows);
        fireEvent.click(ubuntu);
        fireEvent.click(screen.getByRole("button", { name: "Continue" }));
        expect(await screen.findByRole("heading", { name: "Which tools do you use?" })).not.toBeNull();
        expect((screen.getByRole("checkbox", { name: "ZCode" }) as HTMLInputElement).checked).toBe(true);
        fireEvent.click(screen.getByRole("button", { name: "Start scan" }));

        expect(await screen.findByRole("heading", { name: "Review found locations" })).not.toBeNull();
        expect(container.textContent).toContain(wslSourcePath);
        expect(container.textContent).not.toContain(historicalWindowsPath);
        expect(client.probeGlobal).toHaveBeenCalledWith(["ZCODE"], [wsl], undefined, expect.any(Function));

        fireEvent.click(screen.getByRole("button", { name: "Scan selected locations" }));
        await vi.waitFor(() =>
            expect(readSources).toHaveBeenCalledWith({
                probeToken: "wsl-zcode-probe",
                selections: [{ probeResultRowId: "zcode-wsl-result", sourceRootRowIds: ["zcode-wsl-source"] }],
            }),
        );
        expect(await screen.findByRole("heading", { name: "No Assets ready to import" })).not.toBeNull();
        expect(client.previewImport).toHaveBeenCalledWith({ readToken: "wsl-zcode-read" });
        expect(JSON.stringify(readSources.mock.calls)).not.toContain(historicalWindowsPath);
        expect(JSON.stringify(vi.mocked(client.previewImport).mock.calls)).not.toContain(historicalWindowsPath);
    });
});
