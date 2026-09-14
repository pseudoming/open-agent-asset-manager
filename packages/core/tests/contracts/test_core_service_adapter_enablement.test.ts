import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAdapterEnablementAuthority } from "../../src/catalog/settings-authority";
import { virginAdapterEnablementAuthority } from "../../src/catalog/adapter-enablement-setting";
import { tryAcquireAuthorityLocks } from "../../src/foundation/authority-locks";
import { clearRegistry } from "../../src/orchestration/adapter-registry";
import { createCoreServiceForTest } from "../../src/orchestration/core-service";
import { adapterEnablementServiceInternalsForTest } from "../../src/orchestration/adapter-enablement-service";
import { closeDb, getDb } from "../../src/persistence/db";
import type { AdapterId, AdapterProvider, PlatformContext } from "../../src/types";
import { makeContractProvider } from "../adapters/fixtures/adapter-contract-fixtures";

const A = "ENABLEMENT_A" as AdapterId;
const B = "ENABLEMENT_B" as AdapterId;
const REMOVED = "ENABLEMENT_REMOVED" as AdapterId;
const LINUX: PlatformContext = {
    platform: "linux",
    platformInstanceId: "local",
    accessRootPath: "/",
};

describe("CoreService adapter enablement authority", () => {
    let parent = "";
    let oaamRoot = "";
    let databasePath = "";
    let now = 100;

    beforeEach(() => {
        parent = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-core-enablement-"));
        oaamRoot = path.join(parent, ".oaam");
        databasePath = path.join(parent, "state.db");
        now = 100;
        clearRegistry();
        closeDb();
    });

    afterEach(() => {
        closeDb();
        clearRegistry();
        fs.rmSync(parent, { recursive: true, force: true });
    });

    function core(providers: AdapterProvider[] = [makeContractProvider(A), makeContractProvider(B)]) {
        return createCoreServiceForTest(
            {
                providers,
                platformContexts: [LINUX],
                oaamRoot,
                databasePath,
                now: () => (now += 1),
            },
            {},
        );
    }

    function establishStateDatabase(): void {
        getDb(databasePath);
        closeDb();
    }

    it("starts every registered Provider disabled and exposes no old public mutation path", async () => {
        const provider = makeContractProvider(A);
        let probeCalls = 0;
        const originalProbe = provider.probe;
        provider.probe = async (context) => {
            probeCalls += 1;
            return originalProbe(context);
        };
        const service = core([provider]);
        expect(service.getAdapterEnablement()).toEqual({
            status: "complete",
            value: virginAdapterEnablementAuthority(),
            diagnostics: [],
        });
        expect(service.listAdapterProviders().value).toEqual([expect.objectContaining({ adapterId: A, enabled: false })]);
        expect(fs.existsSync(path.join(oaamRoot, "settings.json"))).toBe(false);
        expect(
            (
                await service.probeAdapters({
                    adapterIds: [A],
                    contexts: [LINUX],
                    target: { authorizationScope: "global" },
                })
            ).diagnostics[0]?.code,
        ).toBe("adapter_disabled");
        expect(probeCalls).toBe(0);
        for (const oldMethod of ["registerAdapterProvider", "enableAdapter", "disableAdapter", "freezeRegistry"]) {
            expect(Object.hasOwn(service, oldMethod)).toBe(false);
        }
    });

    it("durably replaces a canonical ID set, applies it live, and rejects stale or unknown requests", () => {
        const service = core();
        const virgin = service.getAdapterEnablement().value;
        const enabled = service.replaceAdapterEnablement({
            expectedRevision: virgin.revision,
            expectedSettingFingerprint: virgin.settingFingerprint,
            enabledAdapterIds: [B, A],
            userActionId: "enable-two",
        });
        expect(enabled.status).toBe("complete");
        expect(enabled.value.enabledAdapterIds).toEqual([A, B]);
        expect(service.listAdapterProviders().value.every((provider) => provider.enabled)).toBe(true);
        const settingsAfterEnable = fs.readFileSync(path.join(oaamRoot, "settings.json"), "utf-8");

        expect(
            service.replaceAdapterEnablement({
                expectedRevision: virgin.revision,
                expectedSettingFingerprint: virgin.settingFingerprint,
                enabledAdapterIds: [],
                userActionId: "stale",
            }).diagnostics[0]?.code,
        ).toBe("settings.adapter_enablement_invalid");
        expect(
            service.replaceAdapterEnablement({
                expectedRevision: enabled.value.revision,
                expectedSettingFingerprint: enabled.value.settingFingerprint,
                enabledAdapterIds: [REMOVED],
                userActionId: "unknown",
            }).diagnostics[0]?.code,
        ).toBe("settings.adapter_enablement_unknown");
        expect(fs.readFileSync(path.join(oaamRoot, "settings.json"), "utf-8")).toBe(settingsAfterEnable);

        const disabled = service.replaceAdapterEnablement({
            expectedRevision: enabled.value.revision,
            expectedSettingFingerprint: enabled.value.settingFingerprint,
            enabledAdapterIds: [],
            userActionId: "disable-all",
        });
        expect(disabled.status).toBe("complete");
        expect(service.listAdapterProviders().value.every((provider) => !provider.enabled)).toBe(true);
    });

    it("preserves an unavailable persisted ID while enabling only the registered intersection", () => {
        establishStateDatabase();
        const virgin = virginAdapterEnablementAuthority();
        setAdapterEnablementAuthority({
            oaamRoot,
            expectedRevision: virgin.revision,
            expectedSettingFingerprint: virgin.settingFingerprint,
            enabledAdapterIds: [A, REMOVED],
            userActionEvidenceId: "prior-install",
            changedAt: 10,
        });
        const service = core([makeContractProvider(A)]);
        expect(service.listAdapterProviders().value[0]).toMatchObject({ adapterId: A, enabled: true });
        const current = service.getAdapterEnablement();
        expect(current.status).toBe("partial");
        expect(current.value.enabledAdapterIds).toEqual([A, REMOVED]);
        expect(current.diagnostics[0]?.code).toBe("settings.adapter_enablement_unregistered_preserved");
    });

    it("keeps bootstrap usable but all-disabled when the durable setting is corrupt", async () => {
        establishStateDatabase();
        fs.mkdirSync(oaamRoot, { recursive: true });
        fs.writeFileSync(
            path.join(oaamRoot, "settings.json"),
            JSON.stringify({
                formatVersion: 1,
                settings: {
                    "core.adapter_enablement_v1": {
                        configVersion: 1,
                        settingId: "adapter_enablement_v1",
                        revision: 1,
                        enabledAdapterIds: [A],
                        userActionEvidenceId: "tampered",
                        updatedAt: 1,
                        settingFingerprint: `sha256:${"f".repeat(64)}`,
                    },
                },
            }),
        );
        const service = core([makeContractProvider(A)]);
        expect(service.listAdapterProviders().value[0]?.enabled).toBe(false);
        expect(service.getAdapterEnablement().diagnostics[0]?.code).toBe("settings.adapter_enablement_invalid");
        expect(
            (
                await service.probeAdapters({
                    adapterIds: [A],
                    contexts: [LINUX],
                    target: { authorizationScope: "global" },
                })
            ).diagnostics[0]?.code,
        ).toBe("adapter_disabled");
    });

    it("fails closed while the settings authority is busy and recovers after release", () => {
        establishStateDatabase();
        const authorityLocksRoot = path.join(oaamRoot, "transactions", "authority-locks");
        fs.mkdirSync(path.join(oaamRoot, "transactions"), { recursive: true });
        const release = tryAcquireAuthorityLocks(authorityLocksRoot, "settings", ["settings"]);
        if (release === null) throw new Error("fixture settings lock unavailable");
        const service = core([makeContractProvider(A)]);
        expect(service.listAdapterProviders().value[0]?.enabled).toBe(false);
        expect(service.getAdapterEnablement().diagnostics[0]?.code).toBe("settings.adapter_enablement_locked");
        release();
        expect(service.getAdapterEnablement().status).toBe("complete");
    });

    it("maps impossible projection failures and non-Error throws through deterministic test-only seams", () => {
        const failure = {
            status: "failed" as const,
            value: undefined,
            diagnostics: [
                {
                    severity: "error" as const,
                    code: "projection.fixture",
                    message: "fixture projection failed",
                    path: "",
                    traceId: "",
                    operation: "settings" as const,
                    causeKind: "internal_error" as const,
                    retryable: false,
                    suggestedActions: [],
                    rawSummary: "fixture projection failed",
                },
            ],
        };
        expect(() => adapterEnablementServiceInternalsForTest.requireProjection(failure)).toThrow(/fixture projection failed/);
        expect(() =>
            adapterEnablementServiceInternalsForTest.requireProjection({
                status: "failed",
                value: undefined,
                diagnostics: [],
            }),
        ).toThrow(/projection failed/);
        expect(adapterEnablementServiceInternalsForTest.failed("plain failure").diagnostics[0]).toMatchObject({
            code: "settings.adapter_enablement_invalid",
            causeKind: "internal_error",
        });
        expect(adapterEnablementServiceInternalsForTest.failed(new Error("authority fields")).diagnostics[0]?.causeKind).toBe(
            "invalid_schema",
        );
    });
});
