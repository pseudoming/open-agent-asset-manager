/** Ordinary Core read and import consumers retain State authority while the selected service owns physical reads. */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearRegistry } from "../../src/orchestration/adapter-registry";
import { createCoreService, type CoreServiceProcessOwner } from "../../src/orchestration/core-service";
import {
    bindSelectedWslSourceExecution,
    type SelectedWslSourceExecution,
} from "../../src/orchestration/selected-wsl-source-execution";
import type { ImportAcceptRequest, ImportPreviewSnapshotV1, PlatformContext } from "../../src/types";
import { sourceWireFixture } from "../source-import/fixtures/restricted-source-wire-fixtures";
import { provider, sandbox, sourceFile, target, validRead } from "../source-import/fixtures/source-contract-test-fixtures";
import { makeNativeDialectContract } from "../source-import/fixtures/dialect-contracts";

let core: CoreServiceProcessOwner | undefined;
let peer: ReturnType<typeof sourceWireFixture> | undefined;
afterEach(async () => {
    await peer?.channel.close();
    peer = undefined;
    core?.shutdownProcessState();
    core = undefined;
    clearRegistry();
    vi.restoreAllMocks();
});

function start(options: { contexts?: PlatformContext[]; execution?: SelectedWslSourceExecution } = {}) {
    clearRegistry();
    const h = sourceWireFixture();
    peer = h;
    const localRead = vi.fn(validRead());
    const selected = provider(localRead);
    selected.dialectContracts.native.push(makeNativeDialectContract("Guidance", "mock-guidance-v1"));
    const execution = { read: vi.fn(options.execution?.read ?? ((request) => h.channel.read(request))) };
    core = createCoreService({
        providers: [selected],
        oaamRoot: path.join(sandbox, "oaam"),
        databasePath: path.join(sandbox, "state.db"),
        platformContexts: options.contexts ?? [h.configuration.platformContext],
        selectedWslSourceExecution: execution,
    });
    const settings = core.getAdapterEnablement().value;
    if (!settings.enabledAdapterIds.some((id) => id === selected.adapterId)) {
        const enabled = core.replaceAdapterEnablement({
            expectedRevision: settings.revision,
            expectedSettingFingerprint: settings.settingFingerprint,
            enabledAdapterIds: [selected.adapterId],
            userActionId: "enable-source-fixture",
        });
        if (enabled.status !== "complete") throw new Error(JSON.stringify(enabled.diagnostics));
    }
    return { core, h, localRead, execution };
}

function accept(preview: ImportPreviewSnapshotV1): ImportAcceptRequest {
    const candidateId = preview.items[0]?.candidateId;
    if (candidateId === undefined) throw new Error("expected importable source candidate");
    return {
        previewSnapshot: preview,
        decision: {
            candidateId,
            action: "create_asset",
            freshness: { freshnessAction: "require_current_source" },
            promotion: { promotionAction: "import_only", userActionId: "accept-source" },
            callableBindings: [],
        },
    };
}

describe("CoreService selected WSL source composition", () => {
    it("rejects a missing selected-WSL port before local read or authority preparation", () => {
        const { h, localRead } = start();
        const revalidate = vi.fn(h.readRequest.revalidateAuthority);
        const read = bindSelectedWslSourceExecution([h.configuration.platformContext], undefined);
        expect(() => read(h.readRequest.target, h.readRequest.authority, revalidate)).toThrow(
            "selected WSL source execution is unavailable",
        );
        expect(localRead).not.toHaveBeenCalled();
        expect(revalidate).not.toHaveBeenCalled();
        expect(h.requests).toEqual([]);
    });
    it("validates a selected user root through original read preparation before service dispatch", async () => {
        const { h, execution, localRead } = start();
        const original = h.readRequest.target.sourceSelector;
        if (original.selectorKind !== "probe_roots") throw new Error("expected probe selector");
        const target = {
            ...h.readRequest.target,
            allowedKinds: [],
            sourceSelector: {
                selectorKind: "user_selected_root" as const,
                platformContext: h.configuration.platformContext,
                binding: { sourceRoot: original.observation.sourceRoots[0]!, assetScope: "global" as const, projectRootPath: "" },
            },
        };
        const read = await bindSelectedWslSourceExecution([h.configuration.platformContext], execution)(
            target,
            h.readRequest.authority,
            h.readRequest.revalidateAuthority,
        );
        expect(read.status).toBe("failed");
        expect(read.diagnostics.length).toBeGreaterThan(0);
        expect(execution.read).not.toHaveBeenCalled();
        expect(localRead).not.toHaveBeenCalled();
        expect(h.requests).toEqual([]);
    });

    it("reads, previews and refreshes through the same selected backend before publishing one original AssetVersion", async () => {
        const { core, h, localRead, execution } = start();
        const read = await core.readAssetsFromAdapter(h.readRequest.target);
        expect(read.status, JSON.stringify(read.diagnostics)).toBe("complete");
        const preview = core.previewImport([read.value]);
        expect(preview.status, JSON.stringify(preview.diagnostics)).toBe("complete");
        const accepted = await core.acceptImport(accept(preview.value));
        expect(accepted.status, JSON.stringify(accepted.diagnostics)).toBe("complete");
        expect(execution.read).toHaveBeenCalledTimes(2);
        expect(h.providerCalls()).toBe(2);
        expect(localRead).not.toHaveBeenCalled();
        expect(execution.read.mock.calls[0]![0].authority.transactionsRoot).toBe(path.join(sandbox, "oaam", "transactions"));
        expect(fs.readFileSync(sourceFile, "utf8")).toBe("# Guidance\n");
        expect(core.listAssets().value).toEqual([
            expect.objectContaining({ assetId: accepted.value.assetId, currentVersionId: accepted.value.versionId }),
        ]);
    });

    it("rejects a real source edit between preview and import without publishing an AssetVersion", async () => {
        const { core, h, localRead } = start();
        const read = await core.readAssetsFromAdapter(h.readRequest.target);
        expect(read.status).toBe("complete");
        const preview = core.previewImport([read.value]);
        expect(preview.status).toBe("complete");
        fs.writeFileSync(sourceFile, "# Changed after preview\n");
        const accepted = await core.acceptImport(accept(preview.value));
        expect(accepted.status).toBe("failed");
        expect(accepted.diagnostics.map((item) => item.code)).toContain("import.source_changed");
        expect(core.listAssets().value).toEqual([]);
        expect(h.providerCalls()).toBe(2);
        expect(localRead).not.toHaveBeenCalled();
    });

    it("keeps an exact native read on its original Provider path", async () => {
        const { core, h, localRead, execution } = start({
            contexts: [{ platform: "linux", platformInstanceId: "local", accessRootPath: "/" }],
        });
        expect((await core.readAssetsFromAdapter(target())).status).toBe("complete");
        expect(localRead).toHaveBeenCalledOnce();
        expect(execution.read).not.toHaveBeenCalled();
        expect(h.requests).toEqual([]);
    });

    it("rejects an unselected WSL Environment before admitting a service operation", async () => {
        const { core, h, execution } = start({
            contexts: [{ platform: "linux", platformInstanceId: "local", accessRootPath: "/" }],
        });
        const read = await core.readAssetsFromAdapter(h.readRequest.target);
        expect(read.status).toBe("failed");
        expect(read.diagnostics[0]?.message).toContain("outside this App Server");
        expect(execution.read).not.toHaveBeenCalled();
        expect(h.requests).toEqual([]);
    });

    it("honors current adapter disablement before the selected read dispatch", async () => {
        const { core, h, execution } = start();
        const settings = core.getAdapterEnablement().value;
        expect(
            core.replaceAdapterEnablement({
                expectedRevision: settings.revision,
                expectedSettingFingerprint: settings.settingFingerprint,
                enabledAdapterIds: [],
                userActionId: "disable-source-fixture",
            }).status,
        ).toBe("complete");
        const read = await core.readAssetsFromAdapter(h.readRequest.target);
        expect(read.status).toBe("failed");
        expect(read.diagnostics[0]?.code).toBe("adapter_disabled");
        expect(execution.read).not.toHaveBeenCalled();
        expect(h.requests).toEqual([]);
    });
});
