import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RUN_PROJECT_ASSET_USAGE_CHECK_SCRIPT } from "../src/main/packaged-asset-usage-ui-script-support";

const EXPECTED = {
    projectId: "11111111-1111-4111-8111-111111111111",
    assetId: "22222222-2222-4222-8222-222222222222",
    agentRuntimeLabel: "OpenCode CLI",
} as const;

function renderRelationshipFixture(mode: "missing" | "loading" | "alert"): void {
    document.body.innerHTML = `
        <main data-oaam-route="deployment" data-oaam-subject="project" data-oaam-state="ready"
            data-oaam-deployment-mode="create" data-oaam-project-id="${EXPECTED.projectId}"
            data-oaam-asset-id="${EXPECTED.assetId}">
            <div class="catalog-deployment-workspace" data-oaam-deployment-workspace-state="ready"
                data-oaam-deployment-count="0">
                <section class="workbench-panel deployment-target-discovery">
                    <fieldset class="deployment-target-providers">
                        <label><input type="checkbox" checked><span>OpenCode</span></label>
                    </fieldset>
                    <input type="radio" name="deployment-project-environment" value="win32" checked>
                    <button type="button" data-oaam-target-action="probe">Check</button>
                </section>
            </div>
        </main>`;
    const workspace = document.querySelector<HTMLElement>(".catalog-deployment-workspace");
    const probe = document.querySelector<HTMLButtonElement>('[data-oaam-target-action="probe"]');
    if (workspace === null || probe === null) throw new Error("terminal-evidence fixture is incomplete");
    probe.addEventListener("click", () => {
        if (mode === "missing") return;
        workspace.insertAdjacentHTML(
            "beforeend",
            `<section class="asset-usage-relationships" data-oaam-deployment-step="relationships"
                data-oaam-asset-usage-state="loading">
                <div class="asset-usage-row" data-oaam-asset-usage-analysis="checking"
                    data-oaam-asset-usage-capability="unavailable"
                    data-oaam-asset-usage-target-state="unknown" data-oaam-asset-usage-managed="none">
                    <div class="asset-usage-row-copy">
                        <div class="asset-usage-row-title"><strong>OpenCode CLI</strong>
                            <span class="asset-usage-status">Checking</span>
                        </div>
                        <p>Checking the current file.</p><small>AGENTS.md</small>
                    </div>
                </div>
            </section>`,
        );
        if (mode === "alert") {
            const alert = document.createElement("div");
            alert.setAttribute("role", "alert");
            alert.textContent = "OpenCode target inspection failed";
            workspace.append(alert);
        }
    });
}

function executeRelationshipScript(): Promise<unknown> {
    return Promise.resolve(
        runInNewContext(`(${RUN_PROJECT_ASSET_USAGE_CHECK_SCRIPT})(${JSON.stringify(EXPECTED)})`, {
            Date,
            document,
            HTMLButtonElement,
            HTMLInputElement,
            HTMLElement,
            Promise,
            setTimeout,
        }) as unknown,
    );
}

afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
});

describe("packaged Asset-usage terminal evidence", () => {
    it.each([
        ["missing", { relationshipPanelCount: 0, usageState: "missing", exactRuntimeRow: null }],
        [
            "loading",
            {
                relationshipPanelCount: 1,
                usageState: "loading",
                exactRuntimeRow: expect.objectContaining({ analysis: "checking" }),
            },
        ],
    ] as const)("retains the last observation when the relationship remains %s", async (mode, expected) => {
        vi.useFakeTimers();
        renderRelationshipFixture(mode);
        const pending = executeRelationshipScript();
        await vi.advanceTimersByTimeAsync(120_050);

        await expect(pending).resolves.toEqual(
            expect.objectContaining({
                status: "terminal",
                terminalKind: "deadline_exceeded",
                elapsedMilliseconds: expect.any(Number),
                pollCount: expect.any(Number),
                lastObservation: expect.objectContaining(expected),
            }),
        );
    });

    it("retains the alert and exact row for an attributed terminal error", async () => {
        renderRelationshipFixture("alert");

        await expect(executeRelationshipScript()).resolves.toEqual(
            expect.objectContaining({
                status: "terminal",
                terminalKind: "terminal_state",
                lastObservation: expect.objectContaining({
                    alerts: ["OpenCode target inspection failed"],
                    exactRuntimeRow: expect.objectContaining({
                        agentRuntimeLabel: "OpenCode CLI",
                        analysis: "checking",
                    }),
                }),
            }),
        );
    });
});
