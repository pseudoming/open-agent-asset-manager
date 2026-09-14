import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { parseProtocolTerminalOutcome } from "@oaam/app-server-protocol";
import { describe, expect, it, vi } from "vitest";
import type { DesktopApplicationClientApi } from "../../packages/client/desktop/src/renderer/client";
import { CatalogDeploymentController } from "../../packages/client/desktop/src/renderer/features/catalog-deployment/catalog-deployment-controller";
import { runDesktopActualRender } from "./desktop-actual-render.mjs";
import { ACTUAL_RENDER_CASES } from "./desktop-actual-render-scenarios.mjs";
import { createDeploymentAssetSelectionFixture } from "./fixtures/deployment-asset-selection-fixture";
import { createProjectGuidanceApplyRehearsalHarnessFixture } from "./fixtures/desktop-actual-render/project-guidance-apply-rehearsal-fixture";
import { createStateDiagnosticsFixtureClient } from "./fixtures/desktop-actual-render/state-diagnostics-fixture";
import { createCompleteDirectoryPreviewFixtureClient } from "./fixtures/desktop-actual-render/complete-directory-preview-fixture";
import { assertOrdinarySurfaceLanguage, ORDINARY_SURFACE_LANGUAGE_LEXICON } from "./fixtures/desktop-actual-render-language.mjs";
import { sendNativeKeyAndWait } from "./fixtures/desktop-actual-render-native-keyboard.mjs";
import { projectGuidanceProductionRenderReceipt } from "./fixtures/desktop-actual-render-promotion-authorization.mjs";
import {
    proveDeploymentWheelReachability,
    waitForStableTransientSidebarGeometry,
    waitForTransientSidebarState,
} from "./fixtures/desktop-actual-render-workbench.mjs";

function successfulSpawns(rendererStdout: string) {
    let invocationCount = 0;
    return () => {
        invocationCount += 1;
        return {
            status: 0,
            stdout: invocationCount === 1 ? "" : rendererStdout,
            stderr: "",
        };
    };
}

describe("Desktop actual-render gate", () => {
    it.each([
        "Tab",
        "Escape",
    ])("waits for native %s arrival and its delayed DOM effect without resending the key", async (keyCode) => {
        let clock = 0;
        const events = new EventEmitter();
        const sent: Array<{ type: string; keyCode: string }> = [];
        const rendererProbe = vi.fn(() => Promise.resolve(clock >= 100));
        const webContents = Object.assign(events, {
            focus: vi.fn(),
            isFocused: () => true,
            sendInputEvent: (input: { type: string; keyCode: string }) => sent.push(input),
            executeJavaScript: rendererProbe,
        });
        await sendNativeKeyAndWait(webContents, keyCode, "expected DOM state", "delayed key", {
            now: () => clock,
            sleep: (milliseconds: number) => {
                clock += milliseconds;
                if (clock === 50) events.emit("before-input-event", {}, { type: "keyUp", key: keyCode });
                return Promise.resolve();
            },
            timeoutMs: 200,
        });
        expect(clock).toBe(100);
        expect(rendererProbe).toHaveBeenCalledTimes(3);
        expect(sent).toEqual([
            { type: "keyDown", keyCode },
            { type: "keyUp", keyCode },
        ]);
        expect(events.listenerCount("before-input-event")).toBe(0);
    });

    it.each([
        { observedKey: "Escape", stateReached: true, message: "keyUp=false" },
        { observedKey: "Tab", stateReached: false, message: "keyUp=true" },
    ])("rejects $message when input arrival and the expected DOM effect do not both occur", async (scenario) => {
        let clock = 0;
        const events = new EventEmitter();
        const sent: Array<{ type: string; keyCode: string }> = [];
        const rendererProbe = vi.fn(() => Promise.resolve(scenario.stateReached));
        const webContents = Object.assign(events, {
            focus: vi.fn(),
            isFocused: () => true,
            sendInputEvent: (input: { type: string; keyCode: string }) => {
                sent.push(input);
                events.emit("before-input-event", {}, { type: input.type, key: scenario.observedKey });
            },
            executeJavaScript: rendererProbe,
        });
        await expect(
            sendNativeKeyAndWait(webContents, "Tab", "expected DOM state", "missing effect", {
                now: () => clock,
                sleep: (milliseconds: number) => {
                    clock += milliseconds;
                    return Promise.resolve();
                },
                timeoutMs: 100,
            }),
        ).rejects.toThrow(scenario.message);
        expect(clock).toBe(100);
        expect(sent).toHaveLength(2);
        expect(events.listenerCount("before-input-event")).toBe(0);
        if (scenario.observedKey !== "Tab") expect(rendererProbe).not.toHaveBeenCalled();
    });

    it("does not send native input to an unfocused renderer and removes its observer on failure", async () => {
        let clock = 0;
        const events = new EventEmitter();
        const sendInputEvent = vi.fn();
        const webContents = Object.assign(events, {
            focus: vi.fn(),
            isFocused: () => false,
            sendInputEvent,
            executeJavaScript: vi.fn(),
        });
        await expect(
            sendNativeKeyAndWait(webContents, "Tab", "expected DOM state", "unfocused", {
                now: () => clock,
                sleep: (milliseconds: number) => {
                    clock += milliseconds;
                    return Promise.resolve();
                },
                timeoutMs: 100,
            }),
        ).rejects.toThrow("renderer did not receive focus");
        expect(sendInputEvent).not.toHaveBeenCalled();
        expect(events.listenerCount("before-input-event")).toBe(0);
    });

    it("uses the real file-preview contract for unmanaged removal and rejects the former directory-only file kind", async () => {
        vi.stubGlobal("document", { documentElement: { dataset: {} } });
        try {
            const client = createCompleteDirectoryPreviewFixtureClient(true);
            if (!client.previewDeployment) throw new Error("complete directory fixture is missing");
            const result = await client.previewDeployment({
                deploymentId: "44444444-4444-4444-8444-444444444444",
                selection: { schemaVersion: 1, renderInputFingerprint: "a".repeat(64), semanticOptions: [] },
            });
            expect(parseProtocolTerminalOutcome("deployment.render_preview", result)).toEqual(result);
            if (result.status === "failed") throw new Error("expected preview fixture");
            expect(result.value.files).toHaveLength(4);
            expect(result.value.directories).toHaveLength(5);
            const removal = result.value.files.find((file) => file.relativePath.endsWith("/scratch/local.txt"));
            expect(removal).toMatchObject({
                baselineState: "unmanaged",
                changeKind: "replace_unmanaged",
                desired: { state: "missing" },
            });
            expect(() =>
                parseProtocolTerminalOutcome("deployment.render_preview", {
                    ...result,
                    value: {
                        ...result.value,
                        files: result.value.files.map((file) =>
                            file === removal ? { ...file, changeKind: "remove_unmanaged" } : file,
                        ),
                    },
                }),
            ).toThrow();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("rehearses restore failure before fresh review and terminal success, not another action after restart", async () => {
        vi.stubGlobal("document", { documentElement: { dataset: {} } });
        try {
            const client = createStateDiagnosticsFixtureClient(true);
            if (!client.inspectStateRestore || !client.activateStateRestore) throw new Error("restore fixture is missing");
            const source = { sourceKind: "inventory_backup" as const, backupId: "88888888-8888-4888-8888-888888888888" };
            const first = await client.inspectStateRestore({ source });
            if (first.status === "failed") throw new Error("expected the first restore review");
            const failed = await client.activateStateRestore({
                restoreReviewToken: first.value.restoreReviewToken,
                userActionId: "first-reviewed-restore",
            });
            expect(parseProtocolTerminalOutcome("state_restore.activate", failed)).toEqual(failed);
            expect(failed.status).toBe("failed");
            expect(failed).not.toHaveProperty("value");
            const fresh = await client.inspectStateRestore({ source });
            if (fresh.status === "failed") throw new Error("expected a fresh restore review");
            expect(fresh.value.restoreReviewToken).not.toBe(first.value.restoreReviewToken);
            const restored = await client.activateStateRestore({
                restoreReviewToken: fresh.value.restoreReviewToken,
                userActionId: "fresh-reviewed-restore",
            });
            expect(parseProtocolTerminalOutcome("state_restore.activate", restored)).toEqual(restored);
            expect(restored).toMatchObject({ status: "complete", value: { requiresRestart: true } });
            expect(document.documentElement.dataset.oaamStateRestoreActivationCount).toBe("2");
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("builds the complete Project Guidance render receipt through Core, Claude Provider and Host owners", async () => {
        const receipt = await projectGuidanceProductionRenderReceipt();
        expect(receipt.required).toMatchObject({
            deploymentId: "44444444-4444-4444-8444-444444444444",
            blockedSemantics: [],
            promotionAuthorizationInspections: [
                {
                    promotionAuthorizationState: "required",
                    assetId: "22222222-2222-4222-8222-222222222222",
                    versionId: "33333333-3333-4333-8333-333333333333",
                },
            ],
        });
        expect(receipt.authorized).toMatchObject({
            promotionAuthorizationInspections: [
                {
                    promotionAuthorizationState: "authorized",
                    authorizationSource: "version_target_grant",
                    authorityRevision: 1,
                },
            ],
        });
        expect(receipt.semanticClosure.map(({ semanticKind }) => semanticKind)).toEqual([
            "asset.file_inventory",
            "guidance.base_context",
            "guidance.content",
        ]);
        expect(receipt.preview.files).toEqual([expect.objectContaining({ relativePath: "CLAUDE.md", changeKind: "create" })]);
        expect(receipt.native).toMatchObject({ relativePath: "CLAUDE.md", semanticRefFingerprints: expect.any(Array) });
    });

    it("requires the Project Guidance rehearsal target state to come from the platform-observation owner", () => {
        expect(() =>
            createProjectGuidanceApplyRehearsalHarnessFixture(
                new URLSearchParams("variant=happy"),
                "project_guidance_apply_rehearsal",
            ),
        ).toThrow("owner-observed absent target");
    });

    it.each([
        "surface_loading",
        "workbench",
    ])("keeps the Project Guidance rehearsal inert for unrelated %s scenarios", (scenario) => {
        const fixture = createProjectGuidanceApplyRehearsalHarnessFixture(new URLSearchParams(), scenario);

        expect(fixture.operations).toEqual([]);
        expect(fixture.client).toEqual({});
        expect(() => fixture.installScriptBridge()).not.toThrow();
        expect(
            (globalThis as typeof globalThis & { __oaamProjectGuidanceApplyRehearsal?: unknown })
                .__oaamProjectGuidanceApplyRehearsal,
        ).toBeUndefined();
    });

    it("requires exact Core and Host analyses only for the enabled Project Guidance rehearsal", () => {
        const requiredParameters = { variant: "happy", targetObservation: "absent" };

        expect(() =>
            createProjectGuidanceApplyRehearsalHarnessFixture(
                new URLSearchParams(requiredParameters),
                "project_guidance_apply_rehearsal",
            ),
        ).toThrow("requires one production render receipt");
        expect(() =>
            createProjectGuidanceApplyRehearsalHarnessFixture(
                new URLSearchParams({ ...requiredParameters, productionRenderReceipt: "{}" }),
                "project_guidance_apply_rehearsal",
            ),
        ).toThrow("required analysis is not the exact Core/Host projection");
    });

    it("lets the Project Guidance rehearsal subscription override the generic fallback and reach the real controller", async () => {
        const productionReceipt = await projectGuidanceProductionRenderReceipt();
        const rehearsal = createProjectGuidanceApplyRehearsalHarnessFixture(
            new URLSearchParams({
                variant: "deploy_stale",
                targetObservation: "absent",
                productionRenderReceipt: JSON.stringify(productionReceipt),
            }),
            "project_guidance_apply_rehearsal",
        );
        const fallback = vi.fn(() => () => undefined);
        const client = Object.freeze({ subscribeInvalidation: fallback, ...rehearsal.client }) as DesktopApplicationClientApi;
        const controller = new CatalogDeploymentController(client, { createUserActionId: () => "actual-render-stale" });
        vi.stubGlobal("document", { documentElement: { dataset: {} } });
        try {
            await controller.load();
            expect(controller.state).toMatchObject({ status: "ready", stale: false });
            await client.deploy({} as Parameters<DesktopApplicationClientApi["deploy"]>[0]);
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(fallback).not.toHaveBeenCalled();
            expect(controller.state).toMatchObject({ status: "ready", stale: true });
        } finally {
            controller.dispose();
            vi.unstubAllGlobals();
        }
    });

    it("keeps the exact routed Asset identity in the dense Deployment fixture", () => {
        const assets = createDeploymentAssetSelectionFixture({
            count: 15,
            projectId: "11111111-1111-4111-8111-111111111111",
            assetId: "22222222-2222-4222-8222-222222222222",
            versionId: "33333333-3333-4333-8333-333333333333",
            digest: "a".repeat(64),
        });

        expect(assets).toHaveLength(15);
        expect(assets[0]).toMatchObject({
            assetId: "22222222-2222-4222-8222-222222222222",
            currentVersionId: "33333333-3333-4333-8333-333333333333",
            projectId: "11111111-1111-4111-8111-111111111111",
        });
    });

    it("waits for a delayed real-input sidebar transition instead of resetting the pointer early", async () => {
        let clock = 0;
        let probeCount = 0;
        const webContents = {
            executeJavaScript: () => {
                probeCount += 1;
                return Promise.resolve({ phase: probeCount >= 4 ? "open" : "closed" });
            },
        };

        await expect(
            waitForTransientSidebarState(webContents, (probe: { phase: string }) => probe.phase === "open", {
                now: () => clock,
                sleep: (milliseconds: number) => {
                    clock += milliseconds;
                    return Promise.resolve();
                },
                timeoutMs: 500,
            }),
        ).resolves.toEqual({ phase: "open" });
        expect(probeCount).toBe(4);
    });

    it("waits for consecutive stable live sidebar geometry before sending real pointer input", async () => {
        let clock = 0;
        let probeCount = 0;
        const webContents = {
            executeJavaScript: () => {
                probeCount += 1;
                const x = probeCount < 4 ? probeCount * 10 : 40;
                return Promise.resolve({
                    phase: "open",
                    sidebarRect: { x, y: 0, width: 240, height: 600 },
                    firstCategoryRect: { x: x + 10, y: 100, width: 200, height: 32 },
                });
            },
        };

        await expect(
            waitForStableTransientSidebarGeometry(webContents, {
                now: () => clock,
                sleep: (milliseconds: number) => {
                    clock += milliseconds;
                    return Promise.resolve();
                },
                timeoutMs: 500,
            }),
        ).resolves.toMatchObject({ sidebarRect: { x: 40 }, firstCategoryRect: { x: 50 } });
        expect(probeCount).toBe(5);
    });

    it("waits beyond the retired fixed wheel retry window while preserving real input and bounded failure", async () => {
        let clock = 0;
        let wheelCount = 0;
        const inputEvents: Array<{ type: string }> = [];
        const webContents = {
            executeJavaScript: () =>
                Promise.resolve({
                    x: 100,
                    y: 80,
                    scrollTop: wheelCount >= 5 ? 320 : 0,
                    scrollHeight: 1200,
                    clientHeight: 600,
                    reached: wheelCount >= 5,
                }),
            focus: () => undefined,
            sendInputEvent: (event: { type: string }) => {
                inputEvents.push(event);
                if (event.type === "mouseWheel") wheelCount += 1;
            },
        };
        await expect(
            proveDeploymentWheelReachability(
                webContents,
                { id: "delayed-wheel", deviceScaleFactor: 1 },
                {},
                {
                    now: () => clock,
                    sleep: (milliseconds: number) => {
                        clock += milliseconds;
                        return Promise.resolve();
                    },
                },
            ),
        ).resolves.toBeUndefined();
        expect(wheelCount).toBe(5);
        expect(inputEvents.filter(({ type }) => type === "mouseWheel")).toHaveLength(5);

        const fixture = fs.readFileSync(
            path.join(process.cwd(), "tests/repository/fixtures/desktop-actual-render-project-assets.mjs"),
            "utf8",
        );
        expect(fixture).toContain("const clickWhenReady = async");
        expect(fixture).toContain("const assetItem = await clickWhenReady(");
        expect(fixture).not.toContain('click(assetItem, "Project Asset")');
    });

    it("accepts a target section that the wide layout already places in the viewport", async () => {
        const inputEvents: Array<{ type: string }> = [];
        const webContents = {
            executeJavaScript: () =>
                Promise.resolve({
                    x: 100,
                    y: 80,
                    scrollTop: 0,
                    scrollHeight: 1200,
                    clientHeight: 600,
                    reached: true,
                }),
            focus: () => undefined,
            sendInputEvent: (event: { type: string }) => inputEvents.push(event),
        };

        await expect(
            proveDeploymentWheelReachability(webContents, { id: "already-visible", deviceScaleFactor: 1 }, {}),
        ).resolves.toBeUndefined();
        expect(inputEvents).toEqual([]);
    });

    it("uses one ordinary-language lexicon for every actual-render fixture", () => {
        const fixtureRoot = path.join(process.cwd(), "tests/repository/fixtures");
        const fixtureSources = fs
            .readdirSync(fixtureRoot)
            .filter((name) => name.startsWith("desktop-actual-render-") && name.endsWith(".mjs"))
            .filter((name) => name !== "desktop-actual-render-language.mjs")
            .map((name) => ({ name, source: fs.readFileSync(path.join(fixtureRoot, name), "utf8") }));
        expect(
            fixtureSources
                .filter(({ source }) => source.includes("ordinaryLanguageRendererArguments"))
                .map(({ name }) => name)
                .sort(),
        ).toEqual([
            "desktop-actual-render-deployment-operations.mjs",
            "desktop-actual-render-deployment.mjs",
            "desktop-actual-render-empty-journey.mjs",
            "desktop-actual-render-library-views.mjs",
            "desktop-actual-render-loading.mjs",
            "desktop-actual-render-main.mjs",
            "desktop-actual-render-project-assets.mjs",
            "desktop-actual-render-source-import-feedback.mjs",
            "desktop-actual-render-state-diagnostics.mjs",
        ]);
        for (const { name, source } of fixtureSources) {
            expect(source, name).not.toContain("agent_runtime_private|family_shared");
            expect(source, name).not.toContain("runtime entr(?:y|ies)");
            expect(source, name).not.toContain("exposes internal architecture language");
        }

        const root = (text: string) => ({
            cloneNode: () => ({
                textContent: text,
                querySelectorAll: () => [],
            }),
        });
        for (const text of [
            "agent-runtime files",
            "Runtime files",
            "Agent-Runtime-Dateien",
            "ランタイム ファイル",
            "运行时文件",
            "OAAM-owned payload",
        ]) {
            expect(() =>
                assertOrdinarySurfaceLanguage(root(text), "fixture", "counterexample", ORDINARY_SURFACE_LANGUAGE_LEXICON),
            ).toThrow(/internal architecture language/u);
        }
        expect(() =>
            assertOrdinarySurfaceLanguage(
                root("Existing files in Project folders and tool configuration are not deleted."),
                "fixture",
                "safe copy",
                ORDINARY_SURFACE_LANGUAGE_LEXICON,
            ),
        ).not.toThrow();
    });

    it("uses one shared operation-layout driver and a bounded four-locale physical matrix", () => {
        const fixtureRoot = path.join(process.cwd(), "tests/repository/fixtures");
        const operationFixtureNames = [
            "desktop-actual-render-deployment-operations.mjs",
            "desktop-actual-render-project-assets.mjs",
            "desktop-actual-render-state-diagnostics.mjs",
        ];
        for (const fixtureName of operationFixtureNames) {
            const source = fs.readFileSync(path.join(fixtureRoot, fixtureName), "utf8");
            expect(source, fixtureName).toContain("operationRendererArguments");
            for (const retiredEnglishControl of ["Analyze render", "Compare exact Versions", "Review backup"]) {
                expect(source, fixtureName).not.toContain(`"${retiredEnglishControl}"`);
            }
        }

        const operationCases = ACTUAL_RENDER_CASES.filter((entry) => entry.scenario.endsWith("_operations"));
        expect(
            operationCases.map(({ id, locale, physicalClass, scenario }) => ({ id, locale, physicalClass, scenario })),
        ).toEqual([
            {
                id: "project-asset-operations-en-1080p",
                locale: "en",
                physicalClass: "1080p",
                scenario: "project_asset_operations",
            },
            {
                id: "project-asset-operations-de-minimum",
                locale: "de",
                physicalClass: "minimum",
                scenario: "project_asset_operations",
            },
            {
                id: "state-diagnostics-operations-en-1080p",
                locale: "en",
                physicalClass: "1080p",
                scenario: "state_diagnostics_operations",
            },
            {
                id: "state-diagnostics-operations-zh-4k",
                locale: "zh-CN",
                physicalClass: "4k",
                scenario: "state_diagnostics_operations",
            },
            {
                id: "deployment-operations-en-1080p",
                locale: "en",
                physicalClass: "1080p",
                scenario: "deployment_operations",
            },
            {
                id: "deployment-operations-ja-2k",
                locale: "ja",
                physicalClass: "2k",
                scenario: "deployment_operations",
            },
        ]);
        expect([...new Set(operationCases.map(({ locale }) => locale))].sort()).toEqual(["de", "en", "ja", "zh-CN"]);
        expect([...new Set(operationCases.map(({ physicalClass }) => physicalClass))].sort()).toEqual([
            "1080p",
            "2k",
            "4k",
            "minimum",
        ]);
    });

    it("renders dense Project Assets, Global Assets, contextual Import sources, and one empty state", () => {
        const reviewCases = ACTUAL_RENDER_CASES.filter((entry) => entry.scenario.endsWith("_review"));
        expect(
            reviewCases.map(({ id, locale, physicalClass, scenario, theme, palette, textSize }) => ({
                id,
                locale,
                physicalClass,
                scenario,
                theme,
                palette,
                textSize,
            })),
        ).toEqual([
            {
                id: "asset-library-project-review-1080p-default-warm",
                locale: "zh-CN",
                physicalClass: "1080p",
                scenario: "asset_library_project_review",
                theme: "light",
                palette: "warm",
                textSize: "default",
            },
            {
                id: "asset-library-global-review-1080p-default-warm",
                locale: "zh-CN",
                physicalClass: "1080p",
                scenario: "asset_library_global_review",
                theme: "light",
                palette: "warm",
                textSize: "default",
            },
            {
                id: "import-sources-review-1080p-default-warm",
                locale: "zh-CN",
                physicalClass: "1080p",
                scenario: "import_sources_review",
                theme: "light",
                palette: "warm",
                textSize: "default",
            },
            {
                id: "asset-library-empty-review-1080p-default-warm",
                locale: "zh-CN",
                physicalClass: "1080p",
                scenario: "asset_library_empty_review",
                theme: "light",
                palette: "warm",
                textSize: "default",
            },
            {
                id: "catalog-search-context-review-1080p-default-warm",
                locale: "zh-CN",
                physicalClass: "1080p",
                scenario: "catalog_search_context_review",
                theme: "light",
                palette: "warm",
                textSize: "default",
            },
            {
                id: "asset-library-project-review-2k",
                locale: "ja",
                physicalClass: "2k",
                scenario: "asset_library_project_review",
                theme: "dark",
                palette: "warm",
                textSize: "large",
            },
            {
                id: "asset-library-global-review-4k",
                locale: "en",
                physicalClass: "4k",
                scenario: "asset_library_global_review",
                theme: "light",
                palette: "neutral",
                textSize: "large",
            },
            {
                id: "import-sources-review-4k",
                locale: "en",
                physicalClass: "4k",
                scenario: "import_sources_review",
                theme: "light",
                palette: "neutral",
                textSize: "large",
            },
        ]);
        const dispatcher = fs.readFileSync(
            path.join(process.cwd(), "tests/repository/fixtures/desktop-actual-render-main.mjs"),
            "utf8",
        );
        for (const scenario of new Set(reviewCases.map(({ scenario }) => scenario))) {
            expect(dispatcher, `${scenario} has no production Electron inspector`).toContain(`entry.scenario === "${scenario}"`);
        }
    });

    it("keeps Deployment layout review coverage across compact, desktop, 2K, and 4K CSS viewports", () => {
        expect(
            ACTUAL_RENDER_CASES.filter((entry) => entry.scenario === "deployment" && entry.reviewScreenshot === true).map(
                (entry) => [entry.windowCssViewport.width, entry.windowCssViewport.height, entry.deviceScaleFactor],
            ),
        ).toEqual([
            [1920, 1080, 1],
            [2560, 1440, 1.5],
            [1920, 1080, 2],
            [3840, 2160, 1],
            [980, 720, 1],
            [1180, 760, 1],
            [1600, 900, 1],
        ]);
        expect(
            ACTUAL_RENDER_CASES.filter(
                (entry) => entry.scenario === "deployment" && entry.reviewScreenshot === true && entry.highContrast === true,
            ),
        ).toHaveLength(1);
    });

    it("captures one identical complete-directory review state across the four locale and physical classes", () => {
        expect(
            ACTUAL_RENDER_CASES.filter(
                (entry) => entry.scenario === "complete_directory_preview" && entry.reviewScreenshot === true,
            ).map((entry) => [entry.locale, entry.physicalClass, entry.windowCssViewport.width, entry.deviceScaleFactor]),
        ).toEqual([
            ["de", "minimum", 860, 1.25],
            ["en", "1080p", 1920, 1],
            ["ja", "2k", 2048, 1.25],
            ["zh-CN", "4k", 1920, 2],
        ]);
    });

    it("derives the verified case count from the Electron renderer marker", () => {
        const expectedCount = ACTUAL_RENDER_CASES.length;
        expect(
            runDesktopActualRender(process.cwd(), {
                capture: true,
                spawn: successfulSpawns(
                    `OAAM_ACTUAL_RENDER verified=${String(expectedCount)}\nOAAM_ACTUAL_RENDER surface_gaps=none\n` +
                        "OAAM_ACTUAL_RENDER dialog_gaps=none\nOAAM_ACTUAL_RENDER journey_state_gaps=none\n",
                ),
            }),
        ).toEqual({ caseCount: expectedCount, dialogGaps: [], journeyStateGaps: [], surfaceGaps: [] });
    });

    it("keeps Electron profile data in the owned actual-render root and removes that root after verification", () => {
        const profiles: string[] = [];
        const spawn = successfulSpawns(
            `OAAM_ACTUAL_RENDER verified=${String(ACTUAL_RENDER_CASES.length)}\nOAAM_ACTUAL_RENDER surface_gaps=none\n` +
                "OAAM_ACTUAL_RENDER dialog_gaps=none\nOAAM_ACTUAL_RENDER journey_state_gaps=none\n",
        );
        runDesktopActualRender(process.cwd(), {
            capture: true,
            spawn: (_command: string, args: string[], options: { env: Record<string, string> }) => {
                const profile = args.find((argument) => argument.startsWith("--user-data-dir="));
                if (profile !== undefined) {
                    const ownedRoot = path.dirname(options.env.OAAM_ACTUAL_RENDER_OUTPUT);
                    expect(profile).toBe(`--user-data-dir=${path.join(ownedRoot, "profile")}`);
                    expect(fs.existsSync(ownedRoot)).toBe(true);
                    profiles.push(ownedRoot);
                }
                return spawn();
            },
        });
        expect(profiles).toHaveLength(1);
        expect(fs.existsSync(profiles[0])).toBe(false);
    });

    it("rejects a successful process that omits the renderer proof marker", () => {
        expect(() =>
            runDesktopActualRender(process.cwd(), {
                capture: true,
                spawn: successfulSpawns("renderer exited without proof\n"),
            }),
        ).toThrow(/did not report a verified case count/u);
    });

    it("rejects a renderer matrix that silently loses a required case", () => {
        const expectedCount = ACTUAL_RENDER_CASES.length;
        const incompleteCount = expectedCount - 1;
        expect(() =>
            runDesktopActualRender(process.cwd(), {
                capture: true,
                spawn: successfulSpawns(
                    `OAAM_ACTUAL_RENDER verified=${String(incompleteCount)}\nOAAM_ACTUAL_RENDER surface_gaps=none\n` +
                        "OAAM_ACTUAL_RENDER dialog_gaps=none\nOAAM_ACTUAL_RENDER journey_state_gaps=none\n",
                ),
            }),
        ).toThrow(`verified ${String(incompleteCount)} cases; expected ${String(expectedCount)}`);
    });

    it("rejects a renderer matrix whose reviewed surface gaps drift", () => {
        expect(() =>
            runDesktopActualRender(process.cwd(), {
                capture: true,
                spawn: successfulSpawns(
                    `OAAM_ACTUAL_RENDER verified=${String(ACTUAL_RENDER_CASES.length)}\n` +
                        "OAAM_ACTUAL_RENDER surface_gaps=deployment,startup\n" +
                        "OAAM_ACTUAL_RENDER dialog_gaps=none\nOAAM_ACTUAL_RENDER journey_state_gaps=none\n",
                ),
            }),
        ).toThrow(/reported surface gaps/u);
    });

    it("rejects a renderer matrix whose reviewed dialog inventory is not exercised", () => {
        expect(() =>
            runDesktopActualRender(process.cwd(), {
                capture: true,
                spawn: successfulSpawns(
                    `OAAM_ACTUAL_RENDER verified=${String(ACTUAL_RENDER_CASES.length)}\n` +
                        "OAAM_ACTUAL_RENDER surface_gaps=none\n" +
                        "OAAM_ACTUAL_RENDER dialog_gaps=project_lifecycle\nOAAM_ACTUAL_RENDER journey_state_gaps=none\n",
                ),
            }),
        ).toThrow(/reported dialog gaps/u);
    });

    it("rejects a renderer matrix whose journey-state evidence drifts", () => {
        expect(() =>
            runDesktopActualRender(process.cwd(), {
                capture: true,
                spawn: successfulSpawns(
                    `OAAM_ACTUAL_RENDER verified=${String(ACTUAL_RENDER_CASES.length)}\n` +
                        "OAAM_ACTUAL_RENDER surface_gaps=none\n" +
                        "OAAM_ACTUAL_RENDER dialog_gaps=none\nOAAM_ACTUAL_RENDER journey_state_gaps=unified_search:closed\n",
                ),
            }),
        ).toThrow(/reported journey-state gaps/u);
    });
});
