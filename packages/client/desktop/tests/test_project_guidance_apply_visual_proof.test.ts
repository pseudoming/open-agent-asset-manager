import { runInThisContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectGuidanceApplySubject, ProjectGuidanceSemanticSelection } from "../src/main/project-guidance-apply-ui-script";
import {
    captureProjectGuidanceVisualStage,
    type ProjectGuidanceVisualStage,
    type ProjectGuidanceVisualStageInput,
    ProjectGuidanceVisualTerminalError,
    projectGuidanceVisualStageScript,
} from "../src/main/project-guidance-apply-visual-proof";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const DEPLOYMENT_ID = "44444444-4444-4444-8444-444444444444";
const TARGET_KEY = JSON.stringify(["probe", "result", "target"]);
const DESIRED_SHA256 = "d".repeat(64);
const SEMANTIC_SELECTIONS: readonly ProjectGuidanceSemanticSelection[] = Object.freeze([
    { semanticKind: "asset.file_inventory", semanticRefFingerprint: "1".repeat(64), optionFingerprint: "a".repeat(64) },
    { semanticKind: "guidance.base_context", semanticRefFingerprint: "2".repeat(64), optionFingerprint: "b".repeat(64) },
    { semanticKind: "guidance.content", semanticRefFingerprint: "3".repeat(64), optionFingerprint: "c".repeat(64) },
]);

function subject(deadline = Date.now() + 1_000): ProjectGuidanceApplySubject {
    return {
        projectId: PROJECT_ID,
        rootPath: String.raw`\\wsl.localhost\Ubuntu\home\agent\project`,
        assetId: ASSET_ID,
        versionId: VERSION_ID,
        sourceSha256: "e".repeat(64),
        environment: { platform: "wsl", platformInstanceId: "Ubuntu" },
        environmentKey: "wsl\0Ubuntu",
        terminalDeadlineAtMillisecondsSinceEpoch: deadline,
    };
}

function input(stage: ProjectGuidanceVisualStage, deadline?: number): ProjectGuidanceVisualStageInput {
    const hasRenderSelection = stage === "preview" || stage === "applied";
    return {
        stage,
        subject: subject(deadline),
        targetKey: TARGET_KEY,
        deploymentId: stage === "relationship" ? "" : DEPLOYMENT_ID,
        semanticSelections: hasRenderSelection ? SEMANTIC_SELECTIONS : [],
        desiredSha256: hasRenderSelection ? DESIRED_SHA256 : "",
    };
}

function semanticMarkup(): string {
    const roles = SEMANTIC_SELECTIONS.map(
        (selection) => `<li data-oaam-passive-semantic-kind="${selection.semanticKind}">${selection.semanticKind}</li>`,
    ).join("");
    const contract = SEMANTIC_SELECTIONS.map(
        (selection) =>
            `<fieldset data-oaam-semantic-kind="${selection.semanticKind}"><article class="preview-detail" data-oaam-semantic-ref-fingerprint="${selection.semanticRefFingerprint}" data-oaam-render-option-fingerprint="${selection.optionFingerprint}" data-oaam-render-outcome="preserved" data-oaam-reverse-policy="can_reconcile" data-oaam-subject-version-id="${VERSION_ID}"><div data-oaam-render-option data-oaam-render-option-auto-selected="true"></div></article></fieldset>`,
    ).join("");
    return `<section data-oaam-render-passive-summary><ul>${roles}</ul><div hidden>${contract}</div></section>`;
}

function installStage(stage: ProjectGuidanceVisualStage): HTMLElement {
    const applied = stage === "applied";
    const authorization = stage === "authorization";
    const reviewMarkup = authorization
        ? '<section data-oaam-promotion-authorization="required"><button data-oaam-deployment-action="authorize-current-version">Allow</button></section>'
        : applied
          ? ""
          : `<div data-oaam-promotion-authorization="allowed"></div>${semanticMarkup()}<section class="inspection-summary"><article data-oaam-preview-path="CLAUDE.md" data-oaam-preview-desired-sha256="${DESIRED_SHA256}"><button data-oaam-preview-review-path="CLAUDE.md">View file</button></article><div data-oaam-preview-decision="ready_apply"><button data-oaam-deployment-action="deploy">Apply</button></div></section>`;
    document.body.innerHTML = `<main data-oaam-route="deployment" data-oaam-subject="project" data-oaam-state="ready" data-oaam-project-id="${PROJECT_ID}" data-oaam-asset-id="${ASSET_ID}">
        <div class="catalog-deployment-workspace" data-oaam-deployment-activity="idle" data-oaam-selected-deployment-stage="${applied ? "in_sync" : "none"}" data-oaam-deployment-stale="false" data-oaam-deployment-reconciliation="none">
            ${
                stage === "relationship"
                    ? `<section class="asset-usage-relationships"><article class="asset-usage-row" data-oaam-agent-runtime-id="CLAUDE_CODE_CLI" data-oaam-runtime-version="2.1.220" data-oaam-target-key='${TARGET_KEY}' data-oaam-asset-usage-analysis="complete" data-oaam-asset-usage-capability="direct" data-oaam-asset-usage-target-state="absent" data-oaam-asset-usage-managed="none"></article></section>`
                    : `<div ${applied ? 'class="asset-usage-relationships" data-oaam-asset-usage-state="ready"' : "data-oaam-create-target-review"}><div class="${applied ? "asset-usage-row" : "deployment-create-target-summary"}" data-oaam-deployment-id="${DEPLOYMENT_ID}" data-oaam-target-key='${TARGET_KEY}' data-oaam-agent-runtime-id="CLAUDE_CODE_CLI" data-oaam-runtime-version="2.1.220"><span data-oaam-application-state="${applied ? "applied" : "pending"}"></span>${applied ? '<span data-oaam-application-version-state="current"></span>' : ""}</div>${reviewMarkup}</div>`
            }
        </div>
    </main>`;
    if (applied) {
        const workspace = document.querySelector(".catalog-deployment-workspace");
        if (workspace === null) throw new Error("applied workspace is missing");
        const preparation = document.createElement("div");
        preparation.hidden = true;
        preparation.append(...workspace.childNodes);
        workspace.append(preparation);
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
        workspace.append(outcome);
    }
    const target = document.querySelector<HTMLElement>(
        stage === "relationship"
            ? ".asset-usage-row"
            : stage === "authorization"
              ? '[data-oaam-promotion-authorization="required"]'
              : stage === "preview"
                ? ".inspection-summary"
                : '[data-oaam-deployment-result="deploy"]',
    );
    if (target === null) throw new Error("visual stage fixture target is missing");
    let visible = false;
    Object.defineProperty(target, "scrollIntoView", {
        configurable: true,
        value: vi.fn(() => {
            visible = true;
        }),
    });
    Object.defineProperty(target, "getBoundingClientRect", {
        configurable: true,
        value: () =>
            ({
                left: 100,
                top: visible ? 120 : 900,
                right: 700,
                bottom: visible ? 320 : 1_100,
                width: 600,
                height: 200,
            }) as DOMRect,
    });
    return target;
}

async function execute(source: string): Promise<unknown> {
    return runInThisContext(source) as Promise<unknown>;
}

beforeEach(() => {
    document.body.innerHTML = "";
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        setTimeout(() => callback(performance.now()), 0);
        return 1;
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe("Project Guidance tracked visual proof", () => {
    it.each([
        "relationship",
        "authorization",
        "preview",
        "applied",
    ] as const)("scrolls and prepares one exact %s viewport capture", async (stage) => {
        const target = installStage(stage);
        const capture = vi.fn(async () => undefined);
        const receipt = await captureProjectGuidanceVisualStage({ executeJavaScript: execute }, input(stage), capture);
        expect(receipt).toMatchObject({
            status: "complete",
            visualStage: stage,
            route: "deployment",
            subject: "project",
            projectId: PROJECT_ID,
            assetId: ASSET_ID,
            targetKey: TARGET_KEY,
            stablePaintFrames: 2,
            targetRect: { top: 120, bottom: 320 },
        });
        expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "start", inline: "nearest" });
        expect(capture).toHaveBeenCalledOnce();
        expect(capture).toHaveBeenCalledWith(receipt);
    });

    it.each([
        ["missing", () => document.querySelector(".asset-usage-row")?.remove()],
        [
            "duplicate",
            () => {
                const row = document.querySelector(".asset-usage-row");
                if (row !== null) row.parentElement?.append(row.cloneNode(true));
            },
        ],
        [
            "wrong identity",
            () => document.querySelector<HTMLElement>(".asset-usage-row")?.setAttribute("data-oaam-target-key", "wrong"),
        ],
    ] as const)("fails closed before capture when the relationship target is %s", async (_label, mutate) => {
        installStage("relationship");
        mutate();
        const capture = vi.fn(async () => undefined);
        await expect(
            captureProjectGuidanceVisualStage({ executeJavaScript: execute }, input("relationship"), capture),
        ).rejects.toBeInstanceOf(ProjectGuidanceVisualTerminalError);
        expect(capture).not.toHaveBeenCalled();
    });

    it.each([
        ["missing", () => document.querySelector('[data-oaam-promotion-authorization="required"]')?.remove()],
        [
            "duplicate",
            () => {
                const notice = document.querySelector('[data-oaam-promotion-authorization="required"]');
                if (notice !== null) notice.parentElement?.append(notice.cloneNode(true));
            },
        ],
        [
            "disabled action",
            () =>
                document
                    .querySelector<HTMLButtonElement>('[data-oaam-deployment-action="authorize-current-version"]')
                    ?.setAttribute("disabled", ""),
        ],
        [
            "wrong deployment identity",
            () =>
                document
                    .querySelector<HTMLElement>(".deployment-create-target-summary")
                    ?.setAttribute("data-oaam-deployment-id", ASSET_ID),
        ],
    ] as const)("fails closed before capture when the authorization target is %s", async (_label, mutate) => {
        installStage("authorization");
        mutate();
        const capture = vi.fn(async () => undefined);
        await expect(
            captureProjectGuidanceVisualStage({ executeJavaScript: execute }, input("authorization"), capture),
        ).rejects.toBeInstanceOf(ProjectGuidanceVisualTerminalError);
        expect(capture).not.toHaveBeenCalled();
    });

    it("rejects a stale permission notice after the applied state is complete", async () => {
        installStage("applied");
        document
            .querySelector(".catalog-deployment-workspace")
            ?.insertAdjacentHTML("beforeend", '<div data-oaam-promotion-authorization="allowed"></div>');
        const capture = vi.fn(async () => undefined);
        await expect(
            captureProjectGuidanceVisualStage({ executeJavaScript: execute }, input("applied"), capture),
        ).rejects.toBeInstanceOf(ProjectGuidanceVisualTerminalError);
        expect(capture).not.toHaveBeenCalled();
    });

    it("rejects an applied result bound to a different Version even when the retained relationship matches", async () => {
        const outcome = installStage("applied");
        outcome.dataset.oaamResultVersionIds = JSON.stringify(["77777777-7777-4777-8777-777777777777"]);
        const capture = vi.fn(async () => undefined);
        await expect(
            captureProjectGuidanceVisualStage({ executeJavaScript: execute }, input("applied"), capture),
        ).rejects.toMatchObject({
            receipt: { lastObservation: { detail: "the visual applied outcome identity changed" } },
        });
        expect(capture).not.toHaveBeenCalled();
    });

    it("returns bounded paint-timeout evidence and never captures an offscreen target", async () => {
        installStage("preview");
        vi.stubGlobal("requestAnimationFrame", () => 1);
        const capture = vi.fn(async () => undefined);
        const promise = captureProjectGuidanceVisualStage(
            { executeJavaScript: execute },
            input("preview", Date.now() + 30),
            capture,
        );
        await expect(promise).rejects.toMatchObject({
            receipt: {
                status: "terminal",
                stage: "visual_preview",
                lastObservation: { phase: "paint", detail: "timed out waiting for a stable in-viewport visual target" },
            },
        });
        expect(capture).not.toHaveBeenCalled();
    });

    it("keeps the Renderer stage source machine-only and free of debugger or CDP control", () => {
        const source = projectGuidanceVisualStageScript(input("applied"));
        expect(source).toContain("scrollIntoView");
        expect(source).toContain("getBoundingClientRect");
        expect(source).not.toMatch(/\bdebugger\b|webSocketDebuggerUrl|DevTools|\.click\(/u);
    });
});
