import crypto from "node:crypto";
import { runInThisContext } from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { desktopEnvironmentKey } from "../src/desktop-environment-key";
import type { PackagedAssetUsageAuthoritySnapshot } from "../src/main/packaged-asset-usage-authority-proof";
import {
    PROJECT_GUIDANCE_REQUIRED_SEMANTIC_KINDS,
    type ProjectGuidanceApplyInstalledReceipt,
    type ProjectGuidanceApplySubject,
    type ProjectGuidanceSemanticSelection,
    projectGuidanceApplyScript,
    projectGuidanceAuthorizeScript,
    projectGuidancePreviewScript,
    projectGuidanceRelationshipScript,
    proveWindowsPackagedProjectAssetImport,
    proveWindowsPackagedProjectAssetImportSubject,
    readPackagedProjectAssetImportSubject,
    validatePackagedProjectGuidanceApplyInstalledReceipt,
} from "../src/main/packaged-project-asset-import-ui-smoke";

const mocks = vi.hoisted(() => ({
    lstatSync: vi.fn(),
    readFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({ default: mocks }));

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const DEPLOYMENT_ID = "44444444-4444-4444-8444-444444444444";
const ROOT = String.raw`\\wsl.localhost\Ubuntu\home\agent\project`;
const SOURCE = Buffer.from("# Exact Project Guidance\n\nOAAM-CLAUDE-MARKER\n", "utf8");
const SOURCE_SHA256 = crypto.createHash("sha256").update(SOURCE).digest("hex");
const TARGET_KEY = JSON.stringify(["probe-token", "result-row", "target-row"]);
const SEMANTIC_SELECTIONS: readonly ProjectGuidanceSemanticSelection[] = Object.freeze(
    PROJECT_GUIDANCE_REQUIRED_SEMANTIC_KINDS.map((semanticKind, index) =>
        Object.freeze({
            semanticKind,
            semanticRefFingerprint: String(index + 1).repeat(64),
            optionFingerprint: String.fromCharCode(97 + index).repeat(64),
        }),
    ),
);
const ENVIRONMENT = Object.freeze({ platform: "wsl" as const, platformInstanceId: "Ubuntu" });
const ENVIRONMENT_KEY = desktopEnvironmentKey(ENVIRONMENT);
const LEGACY_JSON_ENVIRONMENT_KEY = JSON.stringify(["wsl", "Ubuntu"]);
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(16)]);

function subject(deadline = Date.now() + 2_000): ProjectGuidanceApplySubject {
    return {
        projectId: PROJECT_ID,
        rootPath: ROOT,
        assetId: ASSET_ID,
        versionId: VERSION_ID,
        sourceSha256: SOURCE_SHA256,
        environment: ENVIRONMENT,
        environmentKey: ENVIRONMENT_KEY,
        terminalDeadlineAtMillisecondsSinceEpoch: deadline,
    };
}

function authoritySnapshot(): PackagedAssetUsageAuthoritySnapshot {
    return {
        businessAuthorityEntryCount: 1,
        businessAuthorityTreeFingerprint: "a".repeat(64),
        businessAuthorityManifest: [{ relativePath: "oaam.sqlite", kind: "file", size: 8, sha256: "b".repeat(64) }],
        observabilityEntryCount: 0,
        observabilityTreeFingerprint: crypto.createHash("sha256").digest("hex"),
        observabilityManifest: [],
        desktopPreferencesFingerprint: "c".repeat(64),
        desktopPreferences: {
            schemaVersion: 4,
            onboardingCompleted: true,
            lastSelectedProjectId: PROJECT_ID,
            assetLayout: "list",
        },
        coordinationPaths: ["oaam.sqlite-shm"],
    };
}

async function execute(script: string): Promise<Record<string, unknown>> {
    return (await (runInThisContext(script) as Promise<unknown>)) as Record<string, unknown>;
}

function providerChoice(id: string, checked: boolean, disabled = false): string {
    return `<label data-oaam-provider-id="${id}"><input type="checkbox" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""}></label>`;
}

interface JourneyFixtureOptions {
    readonly duplicateRelationship?: boolean;
    readonly disabledClaude?: boolean;
    readonly environmentChoices?: readonly EnvironmentChoiceFixture[];
    readonly duplicateProbe?: boolean;
    readonly probeEnableDelay?: number | "never";
    readonly probeBusyDelay?: number;
    readonly probeFailureDelay?: number;
    readonly identityMutation?: "route" | "project" | "environment";
    readonly previewActionDelay?: number | "never";
    readonly applyCompletionDelay?: number | "never";
    readonly automaticSingletonSelections?: boolean;
    readonly semanticMutation?: "missing" | "extra" | "duplicate" | "disabled" | "wrong_subject" | "duplicate_fingerprint";
    readonly previewFileMutation?: "wrong_path" | "multiple";
}

function mutateSemanticFixture(workspace: HTMLElement, mutation: JourneyFixtureOptions["semanticMutation"]): void {
    const fieldsets = [...workspace.querySelectorAll<HTMLFieldSetElement>("fieldset[data-oaam-semantic-kind]")];
    const first = fieldsets[0];
    if (mutation === "missing") fieldsets.at(-1)?.remove();
    if ((mutation === "extra" || mutation === "duplicate") && first !== undefined) {
        const clone = first.cloneNode(true) as HTMLFieldSetElement;
        clone.dataset.oaamSemanticKind = mutation === "extra" ? "rule.content" : first.dataset.oaamSemanticKind;
        const option = clone.querySelector<HTMLElement>("[data-oaam-render-option-fingerprint]");
        const choice = clone.querySelector<HTMLInputElement>('input[type="radio"]');
        if (option !== null) option.dataset.oaamRenderOptionFingerprint = "f".repeat(64);
        if (choice !== null) {
            choice.name = `catalog-render-${"9".repeat(64)}`;
            choice.value = "f".repeat(64);
        }
        workspace.append(clone);
    }
    if (mutation === "disabled") first?.querySelector<HTMLInputElement>('input[type="radio"]')?.setAttribute("disabled", "");
    if (mutation === "wrong_subject" && first !== undefined) {
        const option = first.querySelector<HTMLElement>("[data-oaam-render-option-fingerprint]");
        if (option !== null) option.dataset.oaamSubjectVersionId = DEPLOYMENT_ID;
    }
    if (mutation === "duplicate_fingerprint") {
        const firstFingerprint = fieldsets[0]?.querySelector<HTMLElement>("[data-oaam-render-option-fingerprint]")?.dataset
            .oaamRenderOptionFingerprint;
        const option = fieldsets[1]?.querySelector<HTMLElement>("[data-oaam-render-option-fingerprint]");
        const choice = fieldsets[1]?.querySelector<HTMLInputElement>('input[type="radio"]');
        if (firstFingerprint !== undefined && option !== null && choice !== null) {
            option.dataset.oaamRenderOptionFingerprint = firstFingerprint;
            choice.value = firstFingerprint;
        }
    }
}

function installCreateReview(options: JourneyFixtureOptions) {
    document.body.innerHTML = `<main data-oaam-route="deployment" data-oaam-state="ready" data-oaam-subject="project" data-oaam-deployment-mode="create" data-oaam-project-id="${PROJECT_ID}" data-oaam-asset-id="${ASSET_ID}">
        <div class="catalog-deployment-workspace" data-oaam-deployment-workspace-state="ready" data-oaam-deployment-analysis="ready" data-oaam-deployment-activity="idle" data-oaam-deployment-message="none" data-oaam-deployment-preview="none" data-oaam-deployment-count="1" data-oaam-selected-deployment-stage="in_sync" data-oaam-deployment-stale="false" data-oaam-deployment-reconciliation="none">
            <div data-oaam-create-target-review><div class="deployment-create-target-summary" data-oaam-deployment-id="${DEPLOYMENT_ID}" data-oaam-target-key='${TARGET_KEY}' data-oaam-agent-runtime-id="CLAUDE_CODE_CLI" data-oaam-runtime-version="2.1.220"><span data-oaam-application-state="pending">Pending</span></div>
            <div data-oaam-promotion-authorization="required"><button data-oaam-deployment-action="authorize-current-version">Allow</button></div>
            <div data-oaam-build-compatibility="newer-compatible">Compatible newer build</div></div>
        </div></main>`;
    document
        .querySelector<HTMLButtonElement>('[data-oaam-deployment-action="authorize-current-version"]')
        ?.addEventListener("click", () => {
            const workspace = document.querySelector<HTMLElement>(".catalog-deployment-workspace");
            if (workspace !== null) {
                workspace.dataset.oaamDeploymentActivity = "authorize:starting";
                workspace.dataset.oaamDeploymentAnalysis = "loading";
            }
            setTimeout(() => {
                document.querySelector('[data-oaam-promotion-authorization="required"]')?.remove();
                document.querySelector('[data-oaam-deployment-action="authorize-current-version"]')?.remove();
                const currentWorkspace = document.querySelector<HTMLElement>(".catalog-deployment-workspace");
                if (currentWorkspace === null) return;
                currentWorkspace.dataset.oaamDeploymentAnalysis = "ready";
                currentWorkspace.dataset.oaamDeploymentActivity = "idle";
                currentWorkspace
                    .querySelector("[data-oaam-create-target-review]")
                    ?.insertAdjacentHTML("beforeend", '<div data-oaam-promotion-authorization="allowed"></div>');
                if (options.automaticSingletonSelections) {
                    currentWorkspace.insertAdjacentHTML(
                        "beforeend",
                        `<section data-oaam-render-passive-summary><ul>${SEMANTIC_SELECTIONS.map((selection) => `<li data-oaam-passive-semantic-kind="${selection.semanticKind}">${selection.semanticKind}</li>`).join("")}</ul><div data-fixture-passive-contract hidden></div></section>`,
                    );
                }
                const semanticOwner = currentWorkspace.querySelector("[data-fixture-passive-contract]") ?? currentWorkspace;
                for (const selection of SEMANTIC_SELECTIONS) {
                    const selectionControl = options.automaticSingletonSelections
                        ? '<div data-oaam-render-option data-oaam-render-option-auto-selected="true"></div>'
                        : `<label data-oaam-render-option><input type="radio" name="catalog-render-${selection.semanticRefFingerprint}" value="${selection.optionFingerprint}"></label>`;
                    semanticOwner.insertAdjacentHTML(
                        "beforeend",
                        `<fieldset data-oaam-semantic-kind="${selection.semanticKind}"><article class="preview-detail" data-oaam-semantic-ref-fingerprint="${selection.semanticRefFingerprint}" data-oaam-render-option-fingerprint="${selection.optionFingerprint}" data-oaam-render-outcome="preserved" data-oaam-reverse-policy="can_reconcile" data-oaam-subject-version-id="${VERSION_ID}">${selectionControl}</article></fieldset>`,
                    );
                }
                mutateSemanticFixture(currentWorkspace, options.semanticMutation);
                const choices = [
                    ...currentWorkspace.querySelectorAll<HTMLInputElement>('[data-oaam-render-option] input[type="radio"]'),
                ];
                const revealPreview = (): void => {
                    if (!choices.every((choice) => choice.checked)) return;
                    const delay = options.previewActionDelay ?? 5;
                    if (delay === "never") return;
                    setTimeout(() => {
                        if (currentWorkspace.querySelector('[data-oaam-deployment-action="preview"]') !== null) return;
                        currentWorkspace.insertAdjacentHTML(
                            "beforeend",
                            '<button data-oaam-deployment-action="preview">Preview</button>',
                        );
                        const preview = currentWorkspace.querySelector<HTMLButtonElement>(
                            '[data-oaam-deployment-action="preview"]',
                        );
                        preview?.addEventListener("click", () => {
                            currentWorkspace.dataset.oaamDeploymentActivity = "preview:starting";
                            currentWorkspace.dataset.oaamDeploymentPreview = "loading";
                            setTimeout(() => {
                                currentWorkspace.dataset.oaamDeploymentActivity = "idle";
                                currentWorkspace.dataset.oaamDeploymentPreview = "ready:ready_apply";
                                const previewFiles =
                                    options.previewFileMutation === "wrong_path"
                                        ? `<article data-oaam-preview-path="sibling.md" data-oaam-preview-change-kind="create" data-oaam-preview-current-state="missing" data-oaam-preview-desired-state="present" data-oaam-preview-desired-byte-size="${SOURCE.byteLength}" data-oaam-preview-desired-sha256="${SOURCE_SHA256}"></article>`
                                        : `<article data-oaam-preview-path="CLAUDE.md" data-oaam-preview-change-kind="create" data-oaam-preview-current-state="missing" data-oaam-preview-desired-state="present" data-oaam-preview-desired-byte-size="${SOURCE.byteLength}" data-oaam-preview-desired-sha256="${SOURCE_SHA256}"><button data-oaam-preview-review-path="CLAUDE.md">View file</button></article>${
                                              options.previewFileMutation === "multiple"
                                                  ? `<article data-oaam-preview-path="sibling.md" data-oaam-preview-change-kind="create" data-oaam-preview-current-state="missing" data-oaam-preview-desired-state="present" data-oaam-preview-desired-byte-size="${SOURCE.byteLength}" data-oaam-preview-desired-sha256="${SOURCE_SHA256}"></article>`
                                                  : ""
                                          }`;
                                currentWorkspace.insertAdjacentHTML(
                                    "beforeend",
                                    `<div class="inspection-summary">${previewFiles}<div data-oaam-preview-decision="ready_apply"><button data-oaam-deployment-action="deploy">Apply to Claude Code</button></div></div>`,
                                );
                                currentWorkspace
                                    .querySelector<HTMLButtonElement>('[data-oaam-deployment-action="deploy"]')
                                    ?.addEventListener("click", () => {
                                        currentWorkspace.dataset.oaamDeploymentActivity = "deploy:starting";
                                        const applyCompletionDelay = options.applyCompletionDelay ?? 5;
                                        if (applyCompletionDelay === "never") return;
                                        setTimeout(() => {
                                            currentWorkspace.dataset.oaamDeploymentActivity = "idle";
                                            currentWorkspace.dataset.oaamDeploymentMessage = "catalog.operation.finished";
                                            currentWorkspace.dataset.oaamSelectedDeploymentStage = "in_sync";
                                            currentWorkspace
                                                .querySelector('[data-oaam-promotion-authorization="allowed"]')
                                                ?.remove();
                                            const summary = currentWorkspace.querySelector<HTMLElement>(
                                                ".deployment-create-target-summary",
                                            );
                                            const application =
                                                summary?.querySelector<HTMLElement>("[data-oaam-application-state]");
                                            if (application !== null && application !== undefined) {
                                                application.dataset.oaamApplicationState = "applied";
                                                application.textContent = "Applied";
                                            }
                                            summary?.insertAdjacentHTML(
                                                "beforeend",
                                                '<p data-oaam-application-version-state="current">Matches the current Version.</p>',
                                            );
                                            if (summary !== null) {
                                                summary.className = "asset-usage-row";
                                                const relationships = document.createElement("section");
                                                relationships.className = "asset-usage-relationships";
                                                relationships.dataset.oaamAssetUsageState = "ready";
                                                currentWorkspace.append(relationships);
                                                relationships.append(summary);
                                                currentWorkspace.querySelector("[data-oaam-create-target-review]")?.remove();
                                            }
                                            const preparation = document.createElement("div");
                                            preparation.hidden = true;
                                            preparation.append(...currentWorkspace.childNodes);
                                            const outcome = document.createElement("section");
                                            Object.assign(outcome.dataset, {
                                                oaamDeploymentResult: "deploy",
                                                oaamResultDeploymentId: DEPLOYMENT_ID,
                                                oaamResultTargetKey: TARGET_KEY,
                                                oaamResultRuntimeIds: JSON.stringify(["CLAUDE_CODE_CLI"]),
                                                oaamResultRuntimeVersions: JSON.stringify(["2.1.220"]),
                                                oaamResultVersionIds: JSON.stringify([VERSION_ID]),
                                                oaamResultFilePaths: JSON.stringify(["CLAUDE.md"]),
                                            });
                                            currentWorkspace.append(preparation, outcome);
                                            document.body.dataset.oaamDeployTerminalCount = "1";
                                        }, applyCompletionDelay);
                                    });
                            }, 5);
                        });
                    }, delay);
                };
                if (choices.length === 0) revealPreview();
                else for (const choice of choices) choice.addEventListener("click", revealPreview);
            }, 5);
        });
}

function installRelationship(options: JourneyFixtureOptions) {
    const route = document.querySelector<HTMLElement>('main[data-oaam-route="deployment"]');
    if (route === null) throw new Error("deployment route fixture missing");
    const workspace = route.querySelector<HTMLElement>(".catalog-deployment-workspace");
    if (workspace === null) throw new Error("deployment workspace fixture missing");
    const row = () =>
        `<li class="asset-usage-row" data-oaam-asset-usage-analysis="complete" data-oaam-asset-usage-capability="direct" data-oaam-asset-usage-target-state="absent" data-oaam-asset-usage-managed="none" data-oaam-target-key='${TARGET_KEY}' data-oaam-agent-runtime-id="CLAUDE_CODE_CLI" data-oaam-runtime-version="2.1.220"><span class="asset-usage-status">Not added yet</span><button data-oaam-action="create_deployment_review_intent">Review</button></li>`;
    workspace.dataset.oaamDeploymentActivity = "idle";
    route.querySelector<HTMLButtonElement>('[data-oaam-target-action="probe"]')?.removeAttribute("disabled");
    workspace.insertAdjacentHTML(
        "beforeend",
        `<section class="asset-usage-relationships" data-oaam-asset-usage-state="ready">${row()}${options.duplicateRelationship ? row() : ""}</section>`,
    );
    workspace
        .querySelector<HTMLButtonElement>('[data-oaam-action="create_deployment_review_intent"]')
        ?.addEventListener("click", () => {
            workspace.dataset.oaamDeploymentActivity = "create_deployment:starting";
            setTimeout(() => installCreateReview(options), 5);
        });
}

interface EnvironmentChoiceFixture {
    readonly value?: string;
    readonly checked?: boolean;
    readonly disabled?: boolean;
}

function installJourney(input: JourneyFixtureOptions = {}) {
    const options = { automaticSingletonSelections: true, ...input };
    document.body.innerHTML = `<main data-oaam-route="library" data-oaam-subject="projects" data-oaam-state="ready" data-oaam-project-id="${PROJECT_ID}">
        <button class="asset-tree-project" data-oaam-project-id="${PROJECT_ID}"></button>
        <article class="asset-library-item" data-oaam-asset-id="${ASSET_ID}" data-status="complete" data-oaam-revision="1"><button data-oaam-semantic-action="library.open_asset_deployment">Use</button></article>
    </main>`;
    document
        .querySelector<HTMLButtonElement>('[data-oaam-semantic-action="library.open_asset_deployment"]')
        ?.addEventListener("click", () => {
            document.body.innerHTML = `<main data-oaam-route="deployment" data-oaam-state="ready" data-oaam-subject="project" data-oaam-deployment-mode="create" data-oaam-project-id="${PROJECT_ID}" data-oaam-asset-id="${ASSET_ID}">
                <div class="catalog-deployment-workspace" data-oaam-deployment-workspace-state="ready" data-oaam-deployment-analysis="none" data-oaam-deployment-activity="idle" data-oaam-deployment-message="none" data-oaam-deployment-preview="none" data-oaam-deployment-count="0" data-oaam-selected-deployment-stage="none" data-oaam-deployment-stale="false" data-oaam-deployment-reconciliation="none">
                <div class="deployment-target-discovery">
                    ${providerChoice("CLAUDECODE", false)}${providerChoice("OPENCODE", true)}${providerChoice("ZCODE", false, true)}
                    <span data-fixture-environment-choices></span>
                    <button data-oaam-target-action="probe" disabled>Find</button>
                    ${options.duplicateProbe ? '<button data-oaam-target-action="probe" disabled>Find duplicate</button>' : ""}
                </div></div>
            </main>`;
            const environmentChoices = options.environmentChoices ?? [
                { value: ENVIRONMENT_KEY },
                { value: desktopEnvironmentKey({ platform: "win32", platformInstanceId: "" }), checked: true },
            ];
            const environmentRoot = document.querySelector<HTMLElement>("[data-fixture-environment-choices]");
            for (const choice of environmentChoices) {
                const input = document.createElement("input");
                input.type = "radio";
                input.name = "deployment-project-environment";
                if (choice.value !== undefined) input.value = choice.value;
                input.checked = choice.checked ?? false;
                input.disabled = choice.disabled ?? false;
                environmentRoot?.append(input);
            }
            const claude = document.querySelector<HTMLInputElement>('[data-oaam-provider-id="CLAUDECODE"] input');
            if (claude !== null && options.disabledClaude) claude.disabled = true;
            const probe = document.querySelector<HTMLButtonElement>('[data-oaam-target-action="probe"]');
            const probeEnableDelay = options.probeEnableDelay ?? 5;
            if (probeEnableDelay !== "never") setTimeout(() => probe?.removeAttribute("disabled"), probeEnableDelay);
            if (options.probeFailureDelay !== undefined) {
                setTimeout(() => {
                    document
                        .querySelector(".deployment-target-discovery")
                        ?.insertAdjacentHTML("beforeend", '<div role="alert">Project location failed</div>');
                }, options.probeFailureDelay);
            }
            if (options.identityMutation !== undefined) {
                setTimeout(() => {
                    const route = document.querySelector<HTMLElement>('main[data-oaam-route="deployment"]');
                    if (options.identityMutation === "route") route?.setAttribute("data-oaam-route", "settings");
                    if (options.identityMutation === "project") route?.setAttribute("data-oaam-project-id", VERSION_ID);
                    if (options.identityMutation === "environment") {
                        const environment = route?.querySelector<HTMLInputElement>(
                            'input[name="deployment-project-environment"]:checked',
                        );
                        if (environment !== null && environment !== undefined) environment.value = "changed";
                    }
                }, 10);
            }
            probe?.addEventListener("click", () => {
                document.body.dataset.oaamProbeClickCount = String(Number(document.body.dataset.oaamProbeClickCount ?? "0") + 1);
                const beginProbe = (): void => {
                    probe.setAttribute("disabled", "");
                    const workspace = document.querySelector<HTMLElement>(".catalog-deployment-workspace");
                    if (workspace !== null) workspace.dataset.oaamDeploymentActivity = "probe:starting";
                    setTimeout(() => installRelationship(options), 5);
                };
                const busyDelay = options.probeBusyDelay ?? 0;
                if (busyDelay === 0) beginProbe();
                else setTimeout(beginProbe, busyDelay);
            });
        });
}

function installedReceipt(): ProjectGuidanceApplyInstalledReceipt {
    return {
        schemaVersion: 1,
        subject: {
            projectId: PROJECT_ID,
            assetId: ASSET_ID,
            versionId: VERSION_ID,
            targetKey: TARGET_KEY,
            sourceSha256: SOURCE_SHA256,
        },
        ui: {
            runtimeId: "CLAUDE_CODE_CLI",
            runtimeVersion: "2.1.220",
            capability: "direct",
            targetState: "absent",
            managedStateBefore: "none",
            authorizationRequired: true,
            authorizationAllowed: true,
            compatibility: "newer-compatible",
            semanticSelections: SEMANTIC_SELECTIONS,
            previewPath: "CLAUDE.md",
            previewCurrentState: "missing",
            previewDesiredState: "present",
            previewDesiredSha256: SOURCE_SHA256,
            reversePolicy: "can_reconcile",
            applicationState: "applied",
            versionState: "current",
        },
        operations: {
            "deployment.create": { accepted: 1, terminalComplete: 1 },
            "promotion_grant.create": { accepted: 1, terminalComplete: 1 },
            "deployment.deploy": { accepted: 1, terminalComplete: 1 },
            "watched_scan_intent.replace": { accepted: 0, terminalComplete: 0 },
        },
        authority: {
            projectUnchanged: true,
            assetUnchanged: true,
            versionUnchanged: true,
            preferencesUnchanged: true,
            settingsUnchanged: true,
            localSourcesUnchanged: true,
            oneActiveGrant: true,
            oneAppliedDeployment: true,
            appliedSemanticSelections: SEMANTIC_SELECTIONS,
            noResidualTransaction: true,
        },
        runtime: {
            beforePaths: ["AGENTS.md"],
            afterPaths: ["AGENTS.md", "CLAUDE.md"],
            sourceSha256: SOURCE_SHA256,
            claudeSha256: SOURCE_SHA256,
            siblingsUnchanged: true,
        },
        consumer: {
            agentRuntimeId: "CLAUDE_CODE_CLI",
            runtimeVersion: "2.1.220",
            targetKey: TARGET_KEY,
            loopbackOnly: true,
            markerMatchCount: 1,
            cloudInvocationCount: 0,
            modelExecutionCount: 0,
            loginCount: 0,
            sessionPersistenceCount: 0,
        },
        cleanup: { processResidueCount: 0, fixtureResidueCount: 0 },
    };
}

beforeEach(() => {
    document.body.innerHTML = "";
    delete document.body.dataset.oaamProbeClickCount;
    delete document.body.dataset.oaamDeployTerminalCount;
    vi.restoreAllMocks();
    vi.resetAllMocks();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: vi.fn(),
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
        left: 100,
        top: 100,
        right: 500,
        bottom: 220,
        width: 400,
        height: 120,
    } as DOMRect);
    mocks.lstatSync.mockReturnValue({ isSymbolicLink: () => false, isFile: () => true, size: SOURCE.byteLength });
    mocks.readFileSync.mockImplementation((filePath: unknown) =>
        String(filePath).endsWith(".json")
            ? JSON.stringify({
                  schemaVersion: 3,
                  projectId: PROJECT_ID,
                  rootPath: ROOT,
                  assetId: ASSET_ID,
                  versionId: VERSION_ID,
                  sourceSha256: SOURCE_SHA256,
                  terminalDeadlineAtMillisecondsSinceEpoch: Date.now() + 60_000,
              })
            : SOURCE,
    );
});

describe("packaged Project Guidance apply proof", () => {
    it("reads an exact schema-3 current Project/Asset/Version subject", () => {
        expect(readPackagedProjectAssetImportSubject("/profile")).toMatchObject({
            projectId: PROJECT_ID,
            assetId: ASSET_ID,
            versionId: VERSION_ID,
            sourceSha256: SOURCE_SHA256,
            environment: ENVIRONMENT,
            environmentKey: ENVIRONMENT_KEY,
        });
        mocks.lstatSync.mockReturnValueOnce({ isSymbolicLink: () => true });
        expect(() => readPackagedProjectAssetImportSubject("/profile")).toThrow(
            "invalid packaged Project Guidance apply subject",
        );
    });

    it("executes delayed real DOM transitions through relationship, permission, preview and applied state", async () => {
        installJourney({ automaticSingletonSelections: true });
        const capturePage = vi.fn(async () => ({ toPNG: () => PNG }));
        const result = await proveWindowsPackagedProjectAssetImport(
            { executeJavaScript: execute, capturePage },
            undefined,
            "/proof",
            "/profile",
            authoritySnapshot,
        );
        expect(result).toMatchObject({
            status: "complete",
            relationship: { targetKey: TARGET_KEY, runtimeVersion: "2.1.220", targetState: "absent" },
            createReview: { deploymentId: DEPLOYMENT_ID, authorization: "required" },
            authorization: { authorization: "allowed", semanticSelections: SEMANTIC_SELECTIONS },
            preview: {
                relativePath: "CLAUDE.md",
                desiredSha256: SOURCE_SHA256,
                reversePolicy: "can_reconcile",
                semanticSelections: SEMANTIC_SELECTIONS,
            },
            applied: { applicationState: "applied", versionState: "current", semanticSelections: SEMANTIC_SELECTIONS },
            visual: {
                authorization: { authorizationState: "required", visualStage: "authorization" },
            },
        });
        expect(capturePage).toHaveBeenCalledTimes(4);
    });

    it("waits for a delayed Project location before clicking the unique tool search once", async () => {
        vi.useFakeTimers();
        try {
            installJourney({ probeEnableDelay: 50 });
            let settled = false;
            const result = execute(projectGuidanceRelationshipScript(subject(Date.now() + 500))).then((value) => {
                settled = true;
                return value;
            });
            await vi.advanceTimersByTimeAsync(25);
            expect(settled).toBe(false);
            expect(document.body.dataset.oaamProbeClickCount).toBeUndefined();
            await vi.advanceTimersByTimeAsync(100);
            await expect(result).resolves.toMatchObject({ status: "complete", runtimeVersion: "2.1.220" });
            expect(document.body.dataset.oaamProbeClickCount).toBe("1");
        } finally {
            vi.useRealTimers();
        }
    });

    it("returns a bounded Project-location terminal with its final probe observation", async () => {
        vi.useFakeTimers();
        try {
            installJourney({ probeEnableDelay: "never" });
            const result = execute(projectGuidanceRelationshipScript(subject(Date.now() + 75)));
            await vi.advanceTimersByTimeAsync(100);
            await expect(result).resolves.toMatchObject({
                status: "terminal",
                stage: "relationship",
                lastObservation: {
                    phase: "project_tool_search_ready",
                    projectLocationState: "pending",
                    probeCount: 1,
                    probeEnabledCount: 0,
                    sawProbeBusy: false,
                    relationshipState: "missing",
                    pollCount: expect.any(Number),
                },
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it("waits through registered-Project authorization before target probing becomes busy", async () => {
        vi.useFakeTimers();
        try {
            installJourney({ probeBusyDelay: 50 });
            let settled = false;
            const result = execute(projectGuidanceRelationshipScript(subject(Date.now() + 500))).then((value) => {
                settled = true;
                return value;
            });
            await vi.advanceTimersByTimeAsync(25);
            expect(document.body.dataset.oaamProbeClickCount).toBe("1");
            expect(settled).toBe(false);
            await vi.advanceTimersByTimeAsync(100);
            await expect(result).resolves.toMatchObject({ status: "complete", targetState: "absent" });
        } finally {
            vi.useRealTimers();
        }
    });

    it.each([
        [
            "explicit Project-location failure",
            { probeEnableDelay: "never" as const, probeFailureDelay: 10 },
            "the Project tool search failed",
        ],
        ["duplicate tool search", { duplicateProbe: true }, "the exact Project tool search action is ambiguous"],
        [
            "wrong route",
            { probeEnableDelay: "never" as const, identityMutation: "route" as const },
            "the exact Asset apply route identity changed",
        ],
        [
            "wrong Project",
            { probeEnableDelay: "never" as const, identityMutation: "project" as const },
            "the exact Asset apply route identity changed",
        ],
        [
            "wrong environment",
            { probeEnableDelay: "never" as const, identityMutation: "environment" as const },
            "the selected Project environment identity changed",
        ],
    ])("fails closed on %s while waiting for the Project tool search", async (_label, options, detail) => {
        vi.useFakeTimers();
        try {
            installJourney(options);
            const result = execute(projectGuidanceRelationshipScript(subject(Date.now() + 100)));
            await vi.advanceTimersByTimeAsync(125);
            await expect(result).resolves.toMatchObject({
                status: "terminal",
                stage: "relationship",
                lastObservation: { phase: "project_tool_search_ready", detail },
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it("freshly discovers a delayed preview action after the selected option rerenders", async () => {
        vi.useFakeTimers();
        try {
            installCreateReview({ previewActionDelay: 50 });
            document.querySelector<HTMLButtonElement>('[data-oaam-deployment-action="authorize-current-version"]')?.click();
            await vi.advanceTimersByTimeAsync(10);
            let settled = false;
            const result = execute(
                projectGuidancePreviewScript(subject(Date.now() + 500), TARGET_KEY, DEPLOYMENT_ID, SEMANTIC_SELECTIONS),
            ).then((value) => {
                settled = true;
                return value;
            });
            await vi.advanceTimersByTimeAsync(25);
            expect(settled).toBe(false);
            await vi.advanceTimersByTimeAsync(100);
            await expect(result).resolves.toMatchObject({
                status: "complete",
                relativePath: "CLAUDE.md",
                desiredState: "present",
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it("does not settle while an accepted deploy is still pending behind an old in-sync stage", async () => {
        vi.useFakeTimers();
        try {
            installCreateReview({ applyCompletionDelay: 100 });
            const authorizationPromise = execute(
                projectGuidanceAuthorizeScript(subject(Date.now() + 1_000), TARGET_KEY, DEPLOYMENT_ID),
            );
            await vi.advanceTimersByTimeAsync(100);
            const authorization = await authorizationPromise;
            expect(authorization).toMatchObject({ status: "complete", semanticSelections: SEMANTIC_SELECTIONS });
            const previewPromise = execute(
                projectGuidancePreviewScript(subject(Date.now() + 1_000), TARGET_KEY, DEPLOYMENT_ID, SEMANTIC_SELECTIONS),
            );
            await vi.advanceTimersByTimeAsync(100);
            const preview = await previewPromise;
            expect(preview).toMatchObject({ status: "complete", desiredSha256: SOURCE_SHA256 });

            let settled = false;
            const applied = execute(
                projectGuidanceApplyScript(
                    subject(Date.now() + 1_000),
                    TARGET_KEY,
                    DEPLOYMENT_ID,
                    SOURCE_SHA256,
                    SEMANTIC_SELECTIONS,
                ),
            ).then((value) => {
                settled = true;
                return value;
            });
            await vi.advanceTimersByTimeAsync(50);
            expect(document.querySelector<HTMLElement>(".catalog-deployment-workspace")?.dataset).toMatchObject({
                oaamDeploymentActivity: "deploy:starting",
                oaamSelectedDeploymentStage: "in_sync",
            });
            expect(document.querySelector<HTMLElement>("[data-oaam-application-state]")?.dataset).toMatchObject({
                oaamApplicationState: "pending",
            });
            expect(document.body.dataset.oaamDeployTerminalCount).toBeUndefined();
            expect(settled).toBe(false);

            await vi.advanceTimersByTimeAsync(150);
            await expect(applied).resolves.toMatchObject({
                status: "complete",
                applicationState: "applied",
                versionState: "current",
            });
            expect(document.body.dataset.oaamDeployTerminalCount).toBe("1");
        } finally {
            vi.useRealTimers();
        }
    });

    it("returns a bounded terminal when the selected option never produces a preview action", async () => {
        vi.useFakeTimers();
        try {
            installCreateReview({ previewActionDelay: "never" });
            document.querySelector<HTMLButtonElement>('[data-oaam-deployment-action="authorize-current-version"]')?.click();
            await vi.advanceTimersByTimeAsync(10);
            const result = execute(
                projectGuidancePreviewScript(subject(Date.now() + 150), TARGET_KEY, DEPLOYMENT_ID, SEMANTIC_SELECTIONS),
            );
            await vi.advanceTimersByTimeAsync(175);
            await expect(result).resolves.toMatchObject({
                status: "terminal",
                stage: "preview",
                lastObservation: { phase: "preview_action_ready", previewActionCount: 0 },
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it.each([
        ["missing semantic", "missing", "the complete Guidance semantic group count changed"],
        ["extra unknown semantic", "extra", "the complete Guidance semantic group count changed"],
        ["duplicate semantic", "duplicate", "the complete Guidance semantic group count changed"],
        ["disabled choice", "disabled", "a Guidance render choice is unavailable or has changed identity"],
        ["wrong Asset Version", "wrong_subject", "a Guidance semantic group belongs to the wrong Asset Version or tool"],
        ["duplicate option fingerprint", "duplicate_fingerprint", "a Guidance render choice identity is missing or duplicated"],
    ] as const)("returns a structured terminal for a real DOM %s", async (_label, semanticMutation, detail) => {
        installCreateReview({ semanticMutation });
        await expect(
            execute(projectGuidanceAuthorizeScript(subject(Date.now() + 500), TARGET_KEY, DEPLOYMENT_ID)),
        ).resolves.toMatchObject({
            status: "terminal",
            stage: "authorize",
            lastObservation: { phase: "permission_saved_and_review_ready", detail },
        });
    });

    it("rejects a render-option fingerprint that drifts between authorization and preview", async () => {
        installCreateReview({});
        const authorization = await execute(projectGuidanceAuthorizeScript(subject(Date.now() + 500), TARGET_KEY, DEPLOYMENT_ID));
        expect(authorization).toMatchObject({ status: "complete", semanticSelections: SEMANTIC_SELECTIONS });
        const option = document.querySelector<HTMLElement>(`[data-oaam-render-option-fingerprint="${"a".repeat(64)}"]`);
        const choice = option?.querySelector<HTMLInputElement>('input[type="radio"]');
        if (option === null || choice === null || choice === undefined) throw new Error("semantic fixture option missing");
        option.dataset.oaamRenderOptionFingerprint = "e".repeat(64);
        choice.value = "e".repeat(64);
        await expect(
            execute(projectGuidancePreviewScript(subject(Date.now() + 500), TARGET_KEY, DEPLOYMENT_ID, SEMANTIC_SELECTIONS)),
        ).resolves.toMatchObject({
            status: "terminal",
            stage: "preview",
            lastObservation: {
                phase: "exact_render_choices_selected",
                detail: "the Guidance render choice fingerprints changed after permission",
            },
        });
    });

    it.each([
        "wrong_path",
        "multiple",
    ] as const)("rejects a %s native preview after all three production choices", async (previewFileMutation) => {
        installCreateReview({ previewFileMutation });
        const authorization = await execute(projectGuidanceAuthorizeScript(subject(Date.now() + 500), TARGET_KEY, DEPLOYMENT_ID));
        expect(authorization.status).toBe("complete");
        await expect(
            execute(projectGuidancePreviewScript(subject(Date.now() + 1_000), TARGET_KEY, DEPLOYMENT_ID, SEMANTIC_SELECTIONS)),
        ).resolves.toMatchObject({
            status: "terminal",
            stage: "preview",
            lastObservation: {
                phase: "exact_claude_file_preview",
                detail: "the complete Guidance preview is not one exact CLAUDE.md",
            },
        });
    });

    it.each([
        ["duplicate exact target", { duplicateRelationship: true }],
        ["disabled Claude provider", { disabledClaude: true }],
    ] as const)("returns a structured terminal without a window error for a %s", async (_label, options) => {
        installJourney(options);
        await expect(
            proveWindowsPackagedProjectAssetImportSubject(
                { executeJavaScript: execute, capturePage: vi.fn() },
                undefined,
                "/proof",
                subject(Date.now() + 2_000),
                authoritySnapshot,
            ),
        ).rejects.toThrow("packaged Project Guidance apply stopped at relationship");
        expect(mocks.writeFileSync).toHaveBeenCalledWith(
            expect.stringContaining("terminal-observation.json"),
            expect.stringContaining('"status": "terminal"'),
            { flag: "wx" },
        );
    });

    it("waits for delayed exact Project data and fails closed when it never becomes unique", async () => {
        installJourney();
        const library = document.querySelector<HTMLElement>('main[data-oaam-route="library"]');
        const asset = library?.querySelector<HTMLElement>(".asset-library-item");
        asset?.remove();
        setTimeout(() => {
            if (library !== null && asset !== null) library.append(asset);
        }, 20);
        await expect(execute(projectGuidanceRelationshipScript(subject(Date.now() + 500)))).resolves.toMatchObject({
            status: "complete",
        });

        installJourney();
        document.querySelector(".asset-library-item")?.remove();
        await expect(execute(projectGuidanceRelationshipScript(subject(Date.now() + 60)))).resolves.toMatchObject({
            status: "terminal",
            lastObservation: { phase: "exact_asset_revision" },
        });
    });

    it.each([
        ["legacy JSON tuple", [{ value: LEGACY_JSON_ENVIRONMENT_KEY }]],
        ["wrong WSL distribution", [{ value: desktopEnvironmentKey({ platform: "wsl", platformInstanceId: "Other" }) }]],
        ["duplicate exact key", [{ value: ENVIRONMENT_KEY }, { value: ENVIRONMENT_KEY }]],
        ["disabled exact key", [{ value: ENVIRONMENT_KEY, disabled: true }]],
        ["missing machine key", [{}]],
    ] as const)("rejects a %s environment control through the real DOM script", async (_label, environmentChoices) => {
        installJourney({ environmentChoices });
        await expect(execute(projectGuidanceRelationshipScript(subject(Date.now() + 500)))).resolves.toMatchObject({
            status: "terminal",
            stage: "relationship",
            lastObservation: {
                phase: "exact_provider_selection",
                detail: "the exact WSL environment is unavailable",
            },
        });
    });

    it.each([
        [0, { managedState: "applied" }, "invalid exact Claude relationship receipt"],
        [4, { semanticSelections: [] }, "invalid complete Guidance semantic selection receipt"],
        [5, { relativePath: "sibling.md" }, "invalid exact CLAUDE.md preview receipt"],
        [7, { detail: "" }, "invalid applied Claude Code state receipt"],
    ] as const)("rejects malformed stage %i before trusting later evidence", async (invalidIndex, patch, message) => {
        installJourney();
        let index = 0;
        const executeJavaScript = vi.fn(async (source: string) => {
            const receipt = await execute(source);
            return index++ === invalidIndex ? { ...receipt, ...patch } : receipt;
        });
        await expect(
            proveWindowsPackagedProjectAssetImportSubject(
                { executeJavaScript, capturePage: vi.fn(async () => ({ toPNG: () => PNG })) },
                undefined,
                "/proof",
                subject(Date.now() + 2_000),
                authoritySnapshot,
            ),
        ).rejects.toThrow(message);
    });

    it("persists exact authority evidence before rejecting a preference boundary escape", async () => {
        installJourney();
        const before = authoritySnapshot();
        const after = {
            ...before,
            desktopPreferencesFingerprint: "d".repeat(64),
            desktopPreferences: { ...before.desktopPreferences, assetLayout: "cards" as const },
        };
        const snapshots = [before, before, after, after];
        await expect(
            proveWindowsPackagedProjectAssetImportSubject(
                { executeJavaScript: execute, capturePage: vi.fn(async () => ({ toPNG: () => PNG })) },
                undefined,
                "/proof",
                subject(Date.now() + 2_000),
                () => snapshots.shift() ?? after,
            ),
        ).rejects.toThrow("escaped its preference or observability boundary");
        expect(mocks.writeFileSync).toHaveBeenCalledWith(
            expect.stringContaining("authority-change.json"),
            expect.stringContaining('"preferencesChanged":true'),
            { flag: "wx" },
        );
    });

    it("accepts one exact zero-launch installed receipt", () => {
        expect(validatePackagedProjectGuidanceApplyInstalledReceipt(installedReceipt())).toEqual([]);
    });

    it("rejects a sibling-runtime identity substitution before trusting the installed result", () => {
        const value = installedReceipt();
        const changed: ProjectGuidanceApplyInstalledReceipt = {
            ...value,
            consumer: { ...value.consumer, runtimeVersion: "2.1.219", targetKey: "sibling-target" },
        };
        expect(validatePackagedProjectGuidanceApplyInstalledReceipt(changed)).toContain(
            "installed Claude CLI consumer did not load the exact local CLAUDE.md marker",
        );
    });

    it("rejects an applied snapshot that omits one selected Guidance semantic", () => {
        const value = installedReceipt();
        const changed: ProjectGuidanceApplyInstalledReceipt = {
            ...value,
            authority: { ...value.authority, appliedSemanticSelections: SEMANTIC_SELECTIONS.slice(1) },
        };
        expect(validatePackagedProjectGuidanceApplyInstalledReceipt(changed)).toContain(
            "installed OAAM authority result escaped the exact grant and applied Deployment boundary",
        );
    });

    it("rejects a false consumer marker, runtime-tree drift and an extra mutation", () => {
        const value = installedReceipt();
        const changed: ProjectGuidanceApplyInstalledReceipt = {
            ...value,
            schemaVersion: 2 as 1,
            subject: { ...value.subject, projectId: "bad", sourceSha256: "bad", targetKey: "" },
            ui: { ...value.ui, runtimeVersion: "unknown" },
            operations: { "project.register": { accepted: 1, terminalComplete: 1 } },
            authority: { ...value.authority, settingsUnchanged: false },
            runtime: { ...value.runtime, afterPaths: ["AGENTS.md", "CLAUDE.md", "sibling.md"] },
            consumer: { ...value.consumer, markerMatchCount: 0 },
            cleanup: { ...value.cleanup, processResidueCount: 1 },
        };
        expect(validatePackagedProjectGuidanceApplyInstalledReceipt(changed)).toEqual(
            expect.arrayContaining([
                "installed receipt schema is not 1",
                "installed receipt subject identity is invalid",
                "installed receipt source or target identity is invalid",
                "installed UI result is not the exact Claude Guidance apply result",
                "installed operation count escaped the target stage: project.register",
                "installed target-stage mutation operation is missing",
                "installed OAAM authority result escaped the exact grant and applied Deployment boundary",
                "installed runtime tree is not the exact CLAUDE.md-only change",
                "installed Claude CLI consumer did not load the exact local CLAUDE.md marker",
                "installed target stage left owned residue",
            ]),
        );
    });
});
