import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    PACKAGED_RUNTIME_ENVIRONMENT_LINE,
    proveWindowsProjectEnvironmentChoice,
    proveWindowsWslEnvironmentChoice,
} from "../src/main/packaged-environment-choice-smoke";

const WINDOWS = JSON.stringify(["win32", "desktop-local"]);
const WSL = JSON.stringify(["wsl", "Ubuntu"]);
const WSL_SOURCE = "\\\\wsl.localhost\\Ubuntu\\home\\example\\.claude";
const WSL_PROJECT = "\\\\wsl.localhost\\Ubuntu\\home\\example\\wsl_code\\project";
const WINDOWS_PROJECT = "C:\\Users\\Example\\source\\project";
const resolveUbuntuHome = vi.fn(() => ({
    status: "available" as const,
    homePath: "\\\\wsl.localhost\\Ubuntu\\home\\example",
}));

function locationProof() {
    return {
        status: "ready",
        defaultEnvironment: WINDOWS,
        selectedEnvironments: [WINDOWS, WSL],
    };
}

function toolProof(selectedAdapterIds: readonly string[] = ["CLAUDECODE"]) {
    return {
        status: "ready",
        selectedAdapterIds,
    };
}

function exactProof() {
    return {
        status: "complete",
        defaultEnvironment: WINDOWS,
        selectedEnvironments: [WINDOWS, WSL],
        probedEnvironments: [WINDOWS, WSL],
        environmentResultStatuses: [
            [WINDOWS, "complete"],
            [WSL, "partial"],
        ],
        selectedWslHomeSourcePath: WSL_SOURCE,
    };
}

function projectLocationProof(projectRootPath: string, selectedEnvironment: string, excludedEnvironmentCount = 1) {
    return {
        status: "ready",
        projectRootPath,
        selectedEnvironment,
        excludedEnvironmentCount,
        incompatibleEnvironmentsDisabled: true,
    };
}

function projectExactProof(projectRootPath: string, selectedEnvironment: string) {
    return {
        status: "complete",
        projectRootPath,
        selectedEnvironment,
        probedEnvironment: selectedEnvironment,
        environmentResultStatus: "complete",
        sourcePaths: [projectRootPath],
        excludedEnvironmentCount: 1,
        incompatibleEnvironmentsDisabled: true,
    };
}

function stagedExecution(finalValue: unknown) {
    return vi.fn().mockResolvedValueOnce(locationProof()).mockResolvedValueOnce(toolProof()).mockResolvedValueOnce(finalValue);
}

afterEach(() => {
    document.body.replaceChildren();
});

describe("packaged Windows and WSL environment-choice smoke", () => {
    it("accepts exact UI evidence and exposes each staged location, tool and scan control", async () => {
        const executeJavaScript = stagedExecution(exactProof());
        const onStageReady = vi.fn(async () => undefined);

        await expect(
            proveWindowsWslEnvironmentChoice({ executeJavaScript }, resolveUbuntuHome, { onStageReady }),
        ).resolves.toEqual(exactProof());
        const scripts = executeJavaScript.mock.calls.map(([script]) => String(script));
        expect(scripts).toHaveLength(3);
        expect(scripts[0]).toContain("selecting WSL performed a probe before the location Continue action");
        expect(scripts[1]).not.toContain("data-oaam-provider-save");
        expect(scripts[1]).toContain('data-oaam-journey-continue="locations"');
        expect(scripts[2]).toContain('data-oaam-journey-continue="tools"');
        expect(scripts[2]).toContain("discovery did not match the exact selected Windows and WSL set");
        expect(scripts[2]).toContain("the source-review transition after successful discovery");
        expect(scripts[2]).toContain("successful discovery still exposes the retired scan-results page");
        expect(onStageReady.mock.calls.map(([stage]) => stage)).toEqual(["locations", "tools"]);
        expect(PACKAGED_RUNTIME_ENVIRONMENT_LINE).toContain("windows-default,wsl-multi-select");
    });

    it("executes all three packaged scripts against real DOM controls instead of trusting a synthetic result", async () => {
        document.body.innerHTML = `
            <div class="discovery-workspace"
                data-oaam-journey-stage="locations"
                data-oaam-discovery-activity="idle"
                data-oaam-enabled-adapter-ids="[]"
                data-oaam-probed-environments="[]"
                data-oaam-probed-source-paths="[]"
                data-oaam-environment-result-statuses="[]"
                data-oaam-selected-environments='["[\\"win32\\",\\"desktop-local\\"]"]'>
                <label data-oaam-environment-platform="win32" data-oaam-environment-instance="desktop-local">
                    <input type="checkbox" checked> Windows
                </label>
                <label data-oaam-environment-platform="wsl" data-oaam-environment-instance="Ubuntu">
                    <input type="checkbox"> WSL Ubuntu
                </label>
                <label data-oaam-provider-id="CLAUDECODE">
                    <input type="checkbox"> Claude Code
                </label>
                <button type="button" data-oaam-journey-continue="locations">Continue</button>
                <button type="button" data-oaam-journey-continue="tools">Scan</button>
            </div>`;
        const workspace = document.querySelector<HTMLElement>(".discovery-workspace");
        const claude = document.querySelector<HTMLInputElement>('[data-oaam-provider-id="CLAUDECODE"] input');
        const wsl = document.querySelector<HTMLInputElement>('[data-oaam-environment-platform="wsl"] input');
        const locations = document.querySelector<HTMLButtonElement>('[data-oaam-journey-continue="locations"]');
        const run = document.querySelector<HTMLButtonElement>('[data-oaam-journey-continue="tools"]');
        if (workspace === null || claude === null || wsl === null || locations === null || run === null) {
            throw new Error("environment-choice fixture is incomplete");
        }
        claude.addEventListener("click", () => {
            claude.checked = true;
        });
        wsl.addEventListener("click", () => {
            wsl.checked = true;
            workspace.dataset.oaamSelectedEnvironments = JSON.stringify([WINDOWS, WSL]);
        });
        locations.addEventListener("click", () => {
            workspace.dataset.oaamJourneyStage = "tools";
        });
        run.addEventListener("click", () => {
            workspace.dataset.oaamDiscoveryActivity = "probing";
            workspace.dataset.oaamEnabledAdapterIds = '["CLAUDECODE"]';
            workspace.dataset.oaamProbedEnvironments = JSON.stringify([WINDOWS, WSL]);
            workspace.dataset.oaamEnvironmentResultStatuses = JSON.stringify([
                [WINDOWS, "complete"],
                [WSL, "partial"],
            ]);
            workspace.dataset.oaamProbedSourcePaths = JSON.stringify([WSL_SOURCE]);
            workspace.dataset.oaamJourneyStage = "sources";
            workspace.dataset.oaamDiscoveryActivity = "idle";
        });
        const executeJavaScript = vi.fn(
            async (script: string) =>
                runInNewContext(script, {
                    document,
                    HTMLButtonElement,
                    HTMLInputElement,
                    HTMLElement,
                    setTimeout,
                }) as unknown,
        );

        await expect(proveWindowsWslEnvironmentChoice({ executeJavaScript }, resolveUbuntuHome)).resolves.toEqual(exactProof());
        expect(executeJavaScript).toHaveBeenCalledTimes(3);
        expect(claude.checked).toBe(true);
        expect(wsl.checked).toBe(true);
        expect(workspace.dataset.oaamProbedEnvironments).toBe(JSON.stringify([WINDOWS, WSL]));
    });

    it.each([
        [WSL_PROJECT, WSL],
        [WINDOWS_PROJECT, WINDOWS],
    ])("binds a Project root to only its exact environment for %s", async (projectRootPath, selectedEnvironment) => {
        const deadlineAtMillisecondsSinceEpoch = Date.now() + 90_000;
        const executeJavaScript = vi
            .fn()
            .mockResolvedValueOnce(projectLocationProof(projectRootPath, selectedEnvironment))
            .mockResolvedValueOnce(toolProof())
            .mockResolvedValueOnce({
                status: "complete",
                projectRootPath,
                selectedEnvironment,
                probedEnvironment: selectedEnvironment,
                environmentResultStatus: "complete",
                sourcePaths: [projectRootPath],
            });

        await expect(
            proveWindowsProjectEnvironmentChoice({ executeJavaScript }, projectRootPath, {
                deadlineAtMillisecondsSinceEpoch,
            }),
        ).resolves.toEqual(projectExactProof(projectRootPath, selectedEnvironment));
        const scripts = executeJavaScript.mock.calls.map(([script]) => String(script));
        expect(scripts.every((script) => script.includes(String(deadlineAtMillisecondsSinceEpoch)))).toBe(true);
        expect(scripts[0]).toContain("an environment outside the exact Project root remains selectable");
        expect(scripts[2]).toContain("Project discovery escaped the exact registered Project environment");
        expect(scripts[2]).toContain(JSON.stringify(projectRootPath));
    });

    it("accepts concrete source paths contained by the authoritative Project root", async () => {
        const sourcePaths = [`${WINDOWS_PROJECT}\\AGENTS.md`, `${WINDOWS_PROJECT}\\.agents\\skills`];
        const executeJavaScript = vi
            .fn()
            .mockResolvedValueOnce(projectLocationProof(WINDOWS_PROJECT, WINDOWS))
            .mockResolvedValueOnce(toolProof())
            .mockResolvedValueOnce({
                status: "complete",
                projectRootPath: WINDOWS_PROJECT,
                selectedEnvironment: WINDOWS,
                probedEnvironment: WINDOWS,
                environmentResultStatus: "complete",
                sourcePaths,
            });

        await expect(proveWindowsProjectEnvironmentChoice({ executeJavaScript }, WINDOWS_PROJECT)).resolves.toEqual({
            ...projectExactProof(WINDOWS_PROJECT, WINDOWS),
            sourcePaths,
        });
    });

    it("rejects a concrete source path outside the authoritative Project root", async () => {
        const executeJavaScript = vi
            .fn()
            .mockResolvedValueOnce(projectLocationProof(WINDOWS_PROJECT, WINDOWS))
            .mockResolvedValueOnce(toolProof())
            .mockResolvedValueOnce({
                status: "complete",
                projectRootPath: WINDOWS_PROJECT,
                selectedEnvironment: WINDOWS,
                probedEnvironment: WINDOWS,
                environmentResultStatus: "complete",
                sourcePaths: [`${WINDOWS_PROJECT}-sibling\\AGENTS.md`],
            });

        await expect(proveWindowsProjectEnvironmentChoice({ executeJavaScript }, WINDOWS_PROJECT)).rejects.toThrow(
            /invalid packaged Project environment-choice proof/u,
        );
    });

    it("executes the Windows-Project restriction against real controls and leaves every WSL choice disabled", async () => {
        document.body.innerHTML = `
            <div class="discovery-workspace"
                data-oaam-target-project-id="99999999-9999-4999-8999-999999999999"
                data-oaam-journey-stage="locations"
                data-oaam-discovery-activity="idle"
                data-oaam-enabled-adapter-ids="[]"
                data-oaam-probed-environments="[]"
                data-oaam-probed-source-paths="[]"
                data-oaam-environment-result-statuses="[]"
                data-oaam-selected-environments='["[\\"win32\\",\\"desktop-local\\"]"]'>
                <label data-oaam-environment-platform="win32" data-oaam-environment-instance="desktop-local">
                    <input type="radio" name="project-environment" checked> Windows
                </label>
                <label data-oaam-environment-platform="wsl" data-oaam-environment-instance="Ubuntu">
                    <input type="radio" name="project-environment" disabled> WSL Ubuntu
                </label>
                <label data-oaam-environment-platform="wsl" data-oaam-environment-instance="Debian">
                    <input type="radio" name="project-environment" disabled> WSL Debian
                </label>
                <label data-oaam-provider-id="CLAUDECODE">
                    <input type="checkbox"> Claude Code
                </label>
                <button type="button" data-oaam-journey-continue="locations">Continue</button>
                <button type="button" data-oaam-journey-continue="tools">Scan</button>
            </div>`;
        const workspace = document.querySelector<HTMLElement>(".discovery-workspace");
        const claude = document.querySelector<HTMLInputElement>('[data-oaam-provider-id="CLAUDECODE"] input');
        const locations = document.querySelector<HTMLButtonElement>('[data-oaam-journey-continue="locations"]');
        const run = document.querySelector<HTMLButtonElement>('[data-oaam-journey-continue="tools"]');
        if (workspace === null || claude === null || locations === null || run === null) {
            throw new Error("Windows Project environment fixture is incomplete");
        }
        claude.addEventListener("click", () => {
            claude.checked = true;
        });
        locations.addEventListener("click", () => {
            workspace.dataset.oaamJourneyStage = "tools";
        });
        run.addEventListener("click", () => {
            workspace.dataset.oaamDiscoveryActivity = "probing";
            workspace.dataset.oaamEnabledAdapterIds = '["CLAUDECODE"]';
            workspace.dataset.oaamProbedEnvironments = JSON.stringify([WINDOWS]);
            workspace.dataset.oaamEnvironmentResultStatuses = JSON.stringify([[WINDOWS, "complete"]]);
            workspace.dataset.oaamProbedSourcePaths = JSON.stringify([WINDOWS_PROJECT]);
            workspace.dataset.oaamJourneyStage = "sources";
            workspace.dataset.oaamDiscoveryActivity = "idle";
        });
        const executeJavaScript = vi.fn(
            async (script: string) =>
                runInNewContext(script, {
                    document,
                    HTMLButtonElement,
                    HTMLInputElement,
                    HTMLElement,
                    setTimeout,
                }) as unknown,
        );

        await expect(proveWindowsProjectEnvironmentChoice({ executeJavaScript }, WINDOWS_PROJECT)).resolves.toEqual({
            ...projectExactProof(WINDOWS_PROJECT, WINDOWS),
            excludedEnvironmentCount: 2,
        });
        expect(
            [...document.querySelectorAll<HTMLInputElement>('[data-oaam-environment-platform="wsl"] input')].every(
                (choice) => choice.disabled && !choice.checked,
            ),
        ).toBe(true);
    });

    it("waits for a guided-import workspace that mounts after the route shell without requiring first-run consent", async () => {
        let invocation = 0;
        const executeJavaScript = vi.fn(async (script: string) => {
            invocation += 1;
            if (invocation === 2) return toolProof();
            if (invocation === 3) return exactProof();
            setTimeout(() => {
                document.body.innerHTML = `
                    <div class="discovery-workspace"
                        data-oaam-journey-stage="locations"
                        data-oaam-probed-environments="[]"
                        data-oaam-selected-environments='["[\\"win32\\",\\"desktop-local\\"]"]'>
                        <label data-oaam-environment-platform="win32" data-oaam-environment-instance="desktop-local">
                            <input type="checkbox" checked> Windows
                        </label>
                        <label data-oaam-environment-platform="wsl" data-oaam-environment-instance="Ubuntu">
                            <input type="checkbox"> WSL Ubuntu
                        </label>
                    </div>`;
                const workspace = document.querySelector<HTMLElement>(".discovery-workspace");
                const wsl = document.querySelector<HTMLInputElement>('[data-oaam-environment-platform="wsl"] input');
                if (workspace === null || wsl === null) throw new Error("delayed guided-import fixture is incomplete");
                wsl.addEventListener("click", () => {
                    wsl.checked = true;
                    workspace.dataset.oaamSelectedEnvironments = JSON.stringify([WINDOWS, WSL]);
                });
            }, 5);
            return runInNewContext(script, {
                document,
                HTMLButtonElement,
                HTMLInputElement,
                setTimeout,
            }) as unknown;
        });

        await expect(proveWindowsWslEnvironmentChoice({ executeJavaScript }, resolveUbuntuHome)).resolves.toEqual(exactProof());
        expect(document.querySelector("[data-oaam-onboarding-start]")).toBeNull();
    });

    it.each([
        undefined,
        null,
        { ...exactProof(), extra: true },
        { ...exactProof(), status: "failed" },
        { ...exactProof(), defaultEnvironment: JSON.stringify(["win32", "other"]) },
        { ...exactProof(), selectedEnvironments: [WSL] },
        { ...exactProof(), selectedEnvironments: [WINDOWS, "not-json"] },
        { ...exactProof(), probedEnvironments: [WINDOWS, JSON.stringify(["wsl", "Other"])] },
        { ...exactProof(), environmentResultStatuses: [[WINDOWS, "complete"]] },
        {
            ...exactProof(),
            environmentResultStatuses: [
                [WINDOWS, "unknown"],
                [WSL, "partial"],
            ],
        },
        { ...exactProof(), selectedWslHomeSourcePath: "\\\\wsl.localhost\\Ubuntu\\.claude" },
        { ...exactProof(), selectedWslHomeSourcePath: "\\\\wsl.localhost\\Debian\\home\\example\\.claude" },
    ])("rejects incomplete or contradictory evidence %#", async (value) => {
        await expect(
            proveWindowsWslEnvironmentChoice({ executeJavaScript: stagedExecution(value) }, resolveUbuntuHome),
        ).rejects.toThrow(/packaged Windows\/WSL environment-choice proof/u);
    });

    it("rejects a selected-distro source that is outside the exact resolved WSL HOME", async () => {
        await expect(
            proveWindowsWslEnvironmentChoice(
                {
                    executeJavaScript: stagedExecution({
                        ...exactProof(),
                        selectedWslHomeSourcePath: "\\\\wsl.localhost\\Ubuntu\\etc\\opencode",
                    }),
                },
                resolveUbuntuHome,
            ),
        ).rejects.toThrow(/did not stay below the selected WSL HOME/u);
    });

    it("rejects proof when the selected WSL HOME cannot be resolved at action time", async () => {
        await expect(
            proveWindowsWslEnvironmentChoice({ executeJavaScript: stagedExecution(exactProof()) }, () => ({
                status: "unavailable",
                reason: "command_failed",
            })),
        ).rejects.toThrow(/did not stay below the selected WSL HOME/u);
    });

    it("preserves an execution failure instead of manufacturing proof", async () => {
        const failure = new Error("renderer rejected the environment journey");
        await expect(
            proveWindowsWslEnvironmentChoice(
                { executeJavaScript: vi.fn(async () => Promise.reject(failure)) },
                resolveUbuntuHome,
            ),
        ).rejects.toBe(failure);
    });
});
