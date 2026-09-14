import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import {
    PACKAGED_ASSET_USAGE_TERMINAL_OBSERVATION_RECEIPT,
    PackagedOnboardingScreenshotProof,
} from "../src/main/packaged-onboarding-screenshot-proof";
import {
    collectPackagedProviderDiscoveryReadability,
    PACKAGED_PROVIDER_DISCOVERY_TERMINAL_OBSERVATION_RECEIPT,
} from "../src/main/packaged-provider-discovery-review-proof";
import { PackagedProviderProjectSweepScreenshotProof } from "../src/main/packaged-provider-project-sweep-ui-smoke";

const roots: string[] = [];
const ENVIRONMENT = JSON.stringify(["wsl", "Ubuntu"]);
const SOURCE_PATH = "/home/example/.config/opencode";

afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("packaged onboarding terminal evidence", () => {
    it("persists the exact Asset-usage terminal observation before failed-profile cleanup", () => {
        const parent = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-packaged-onboarding-terminal-observation-"));
        roots.push(parent);
        const root = path.join(parent, "proof");
        const screenshots = new PackagedOnboardingScreenshotProof(root);
        const receipt = {
            schemaVersion: 1 as const,
            status: "terminal" as const,
            stage: "project_asset_usage_relationship" as const,
            terminalKind: "deadline_exceeded" as const,
            message: "relationship stayed loading",
            elapsedMilliseconds: 120_000,
            pollCount: 2_401,
            lastObservation: { usageState: "loading" },
        };

        screenshots.recordAssetUsageTerminalObservation(receipt);

        expect(JSON.parse(fs.readFileSync(path.join(root, PACKAGED_ASSET_USAGE_TERMINAL_OBSERVATION_RECEIPT), "utf8"))).toEqual(
            receipt,
        );
        expect(() => screenshots.recordAssetUsageTerminalObservation(receipt)).toThrow();
    });

    function discoveryStage() {
        return {
            status: "complete" as const,
            adapterIds: ["OPENCODE"],
            defaultEnvironment: ENVIRONMENT,
            selectedEnvironments: [ENVIRONMENT],
            probedEnvironments: [ENVIRONMENT],
            environmentResultStatuses: [[ENVIRONMENT, "partial"]] as const,
            selectedWslHomeSourcePath: "/home/example",
            contextReceipts: [
                {
                    environment: ENVIRONMENT,
                    adapterId: "OPENCODE",
                    status: "partial" as const,
                    installationStatus: "available" as const,
                    agentRuntimeIds: ["OPENCODE_CLI"],
                    versionTexts: ["1.18.15"],
                    diagnostics: [],
                },
            ],
            sourceCards: [
                {
                    environment: ENVIRONMENT,
                    path: SOURCE_PATH,
                    adapterIds: ["OPENCODE"],
                    claimKinds: ["agent_runtime_private"],
                    state: "included" as const,
                },
            ],
            projectProposals: [],
        };
    }

    function installDiscoveryFixture(entries: readonly { readonly path: string; readonly attributes?: string }[]): void {
        document.body.innerHTML = `<main class="discovery-workspace" data-oaam-journey-stage="sources"
            data-oaam-discovery-activity="idle"><li class="discovery-probe-issue"
            data-oaam-environment-identity='${ENVIRONMENT}' data-oaam-adapter-id="OPENCODE">
            <div class="discovery-probe-issue-owner"><strong>OpenCode · WSL</strong></div>
            <ul class="discovery-probe-issue-paths">${entries
                .map(
                    ({
                        path: itemPath,
                        attributes = "",
                    }) => `<li data-oaam-diagnostic-path="location"><code title="${itemPath}">${itemPath}</code>
                    <button data-oaam-interaction-entry="features.discovery.discovery_results.002"
                        data-oaam-diagnostic-path-copy="idle" ${attributes}></button></li>`,
                )
                .join("")}</ul></li><li class="source-review-card" data-oaam-source-environment='WSL — Ubuntu'
            data-oaam-source-environment-key='${ENVIRONMENT}'
            data-oaam-source-path="${SOURCE_PATH}"><div class="source-review-heading"></div></li></main>`;
    }

    const discoveryWebContents = {
        executeJavaScript: async (script: string) => runInNewContext(script, { document, HTMLButtonElement, HTMLElement }),
    };

    it("reads icon accessibility labels and distinguishes repeated actions by exact path subject", async () => {
        installDiscoveryFixture([
            { path: "/home/one", attributes: 'aria-label="Copy first path"' },
            { path: "/home/two", attributes: 'aria-label="Copy second path"' },
        ]);

        const receipt = await collectPackagedProviderDiscoveryReadability(
            discoveryWebContents,
            discoveryStage(),
            () => undefined,
        );

        expect(receipt.contextIssues[0]?.actions).toMatchObject([
            { identity: "diagnostic_path.copy", subject: "/home/one", label: "Copy first path" },
            { identity: "diagnostic_path.copy", subject: "/home/two", label: "Copy second path" },
        ]);
    });

    it.each([
        [
            "duplicate action and subject",
            [
                { path: "/home/same", attributes: 'aria-label="Copy"' },
                { path: "/home/same", attributes: 'aria-label="Copy"' },
            ],
        ],
        ["missing accessible label", [{ path: "/home/unlabelled" }]],
    ])("persists bounded raw discovery evidence before rejecting %s", async (_label, entries) => {
        installDiscoveryFixture(entries);
        const parent = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-provider-discovery-terminal-"));
        roots.push(parent);
        const root = path.join(parent, "proof");
        const screenshots = new PackagedProviderProjectSweepScreenshotProof(root);

        await expect(
            collectPackagedProviderDiscoveryReadability(discoveryWebContents, discoveryStage(), (receipt) =>
                screenshots.recordProviderDiscoveryTerminalObservation(receipt),
            ),
        ).rejects.toThrow(/ordinary presentation/u);
        const saved = JSON.parse(
            fs.readFileSync(path.join(root, PACKAGED_PROVIDER_DISCOVERY_TERMINAL_OBSERVATION_RECEIPT), "utf8"),
        );
        expect(saved).toMatchObject({ schemaVersion: 1, stage: "provider-discovery-source-review", rawReceipt: {} });
    });
});
