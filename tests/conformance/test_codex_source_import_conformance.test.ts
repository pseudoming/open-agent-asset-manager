/** Codex trusted-project Guidance source and import conformance through production contracts. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createProtocolRequest } from "@oaam/app-server-protocol";
import type { HostOutboundMessage, ProductionHost } from "@oaam/app-server-host";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codexProvider } from "../../packages/adapter/providers/codex/src/codex-provider";
import { probeCodex } from "../../packages/adapter/providers/codex/src/codex-probe";
import {
    launchProductionHost,
    listProductionProviderIdsForTest,
} from "../../packages/app-server/bootstrap/src/production-bootstrap";
import type { ImportAcceptRequest, PlatformContext, ProbeObservation } from "../../packages/core/src/types";
import { clearRegistry } from "../../packages/core/src/orchestration/adapter-registry";
import { createCoreService } from "../../packages/core/src/orchestration/core-service";
import { closeDb } from "../../packages/core/src/persistence/db";
import { hostOutcomeValue, waitForHostResponse, waitForHostTerminal } from "./production-host-operation-fixtures";

const GUIDANCE_TEXT = "# Codex project guidance\n\nKeep the source boundary exact.\n";

describe("Codex source import conformance", () => {
    let sandbox = "";
    let home = "";
    let projectRoot = "";
    let oaamRoot = "";
    let platformContext: PlatformContext;
    let productionHost: ProductionHost | null = null;
    let savedEnvironment: Record<"HOME" | "CODEX_HOME" | "PATH", string | undefined>;

    beforeEach(() => {
        savedEnvironment = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME, PATH: process.env.PATH };
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-codex-source-import-"));
        home = path.join(sandbox, "home");
        projectRoot = path.join(sandbox, "project");
        oaamRoot = path.join(sandbox, "oaam");
        platformContext = { platform: "linux", platformInstanceId: "fixture", accessRootPath: sandbox };
        fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
        fs.mkdirSync(projectRoot);
        fs.writeFileSync(path.join(projectRoot, "AGENTS.md"), GUIDANCE_TEXT);
        fs.writeFileSync(path.join(home, ".codex", "config.toml"), `[projects."${projectRoot}"]\ntrust_level = "trusted"\n`);
        clearRegistry();
        closeDb();
    });

    afterEach(async () => {
        await productionHost?.shutdown();
        productionHost = null;
        restoreEnvironment(savedEnvironment);
        closeDb();
        clearRegistry();
        fs.rmSync(sandbox, { recursive: true, force: true });
    });

    it("keeps Codex in production composition and imports one trusted-project Guidance Version", async () => {
        const bin = path.join(sandbox, "bin");
        const executable = path.join(bin, "codex");
        fs.mkdirSync(bin);
        fs.writeFileSync(executable, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), { mode: 0o755 });

        expect(listProductionProviderIdsForTest()).toEqual(["CLAUDECODE", "ANTIGRAVITY", "OPENCODE", "CODEX", "ZCODE", "CURSOR"]);
        const probed = await probeCodex({ authorizationScope: "global", platformContext }, { PATH: bin }, home, "linux");
        const projectSource = probed.observation.sourceRoots.find((root) => root.path === projectRoot);
        expect(projectSource).toMatchObject({
            accessStatus: "available",
            rootRole: "project_actual",
            sourceDomain: "project_root",
            locatorEvidence: expect.arrayContaining([expect.objectContaining({ locatorKind: "project_registry_entry" })]),
        });
        if (projectSource === undefined) throw new Error("Codex trusted project source root was not observed");

        const core = createCoreService({
            providers: [codexProvider],
            platformContexts: [platformContext],
            oaamRoot,
            databasePath: path.join(sandbox, "state.db"),
        });
        enableCodex(core);
        const project = core.registerProject({ rootPath: projectRoot, displayName: "Codex source fixture" });
        expect(project.status, JSON.stringify(project.diagnostics)).toBe("complete");

        const observation: ProbeObservation = {
            adapterId: codexProvider.adapterId,
            platformContext,
            ...probed.observation,
        };
        const read = await core.readAssetsFromAdapter({
            adapterId: codexProvider.adapterId,
            allowedKinds: ["Guidance"],
            sourceSelector: {
                selectorKind: "probe_roots",
                observation,
                sourceRootIds: [projectSource.sourceRootId],
            },
        });
        expect(read.status, JSON.stringify(read.diagnostics)).toBe("complete");
        expect(read.value.candidates).toHaveLength(2);
        expect(new Set(read.value.candidates.map((candidate) => candidate.candidateId)).size).toBe(2);
        expect(
            read.value.candidates.every(
                (candidate) =>
                    candidate.kind === "Guidance" &&
                    candidate.displayName === "AGENTS.md" &&
                    candidate.assetCandidateStatus === "importable" &&
                    candidate.nativeRepresentation.dialectId === "codex-guidance-markdown-v1",
            ),
        ).toBe(true);

        const preview = core.previewImport([read.value]);
        expect(preview.status, JSON.stringify(preview.diagnostics)).toBe("complete");
        expect(preview.value.items).toHaveLength(1);
        const candidateId = preview.value.items[0]?.candidateId;
        if (candidateId === undefined) throw new Error("Codex import preview has no candidate");
        const decision: ImportAcceptRequest["decision"] = {
            candidateId,
            action: "create_asset",
            freshness: { freshnessAction: "require_current_source" },
            promotion: {
                promotionAction: "grant_current_version_current_target",
                target: { targetKind: "project", projectId: project.value.projectId },
                userActionId: "import-codex-guidance",
            },
            callableBindings: [],
        };
        const accepted = await core.acceptImport({ previewSnapshot: preview.value, decision });
        expect(accepted.status, JSON.stringify(accepted.diagnostics)).toBe("complete");
        const version = core.getVersion({ assetId: accepted.value.assetId, versionId: accepted.value.versionId });
        expect(version.status, JSON.stringify(version.diagnostics)).toBe("complete");
        expect(core.listAssets({ kind: "Guidance" }).value).toEqual([
            expect.objectContaining({ assetId: accepted.value.assetId, displayName: "AGENTS.md" }),
        ]);
        expect(version.value.value).toMatchObject({
            manifest: {
                kind: "Guidance",
                nativeRepresentations: [expect.objectContaining({ dialectId: "codex-guidance-markdown-v1" })],
            },
            files: [
                expect.objectContaining({
                    file: expect.objectContaining({ logicalPath: "GUIDANCE.md", contentKind: "text" }),
                    contentKind: "text",
                    text: GUIDANCE_TEXT,
                }),
            ],
        });

        const current = core.getAdapterEnablement();
        const disabled = core.replaceAdapterEnablement({
            expectedRevision: current.value.revision,
            expectedSettingFingerprint: current.value.settingFingerprint,
            enabledAdapterIds: [],
            userActionId: "disable-codex-after-import",
        });
        expect(disabled.status).toBe("complete");
        expect(core.getVersion({ assetId: accepted.value.assetId, versionId: accepted.value.versionId }).status).toBe("complete");
    });

    it("runs the production Host through Codex probe, read, preview, accept, and catalog visibility", async () => {
        const bin = path.join(sandbox, "bin");
        fs.mkdirSync(bin);
        fs.writeFileSync(path.join(bin, "codex"), Buffer.from([0x7f, 0x45, 0x4c, 0x46]), { mode: 0o755 });
        process.env.HOME = home;
        process.env.CODEX_HOME = path.join(home, ".codex");
        process.env.PATH = bin;

        productionHost = launchProductionHost({
            oaamRoot: path.join(sandbox, "production-oaam"),
            databasePath: path.join(sandbox, "production-state.db"),
            platformContexts: [platformContext],
        });
        const messages: HostOutboundMessage[] = [];
        const connection = productionHost.openConnection({
            send: (message) => messages.push(message),
            close() {},
        });
        connection.receive({
            id: "initialize",
            method: "initialize",
            params: { protocolVersion: 1, clientKind: "headless", clientVersion: "0.1.0" },
        });
        await waitForHostResponse(messages, "initialize");

        connection.receive(createProtocolRequest("enablement", "adapter_enablement.get", {}));
        const enablement = hostOutcomeValue<{
            revision: number;
            settingFingerprint: string;
        }>(await waitForHostResponse(messages, "enablement"));
        connection.receive(
            createProtocolRequest("enable-codex", "adapter_enablement.replace", {
                expectedRevision: enablement.revision,
                expectedSettingFingerprint: enablement.settingFingerprint,
                enabledAdapterIds: ["CODEX"],
                userActionId: "enable-codex-production-conformance",
            }),
        );
        expect(hostOutcomeValue(await waitForHostResponse(messages, "enable-codex"))).toMatchObject({
            enabledAdapterIds: ["CODEX"],
        });

        const projectToken = connection.registerLocalPathSelection("project_root", projectRoot);
        connection.receive(
            createProtocolRequest("register-project", "project.register", {
                localPathSelectionToken: projectToken,
                displayName: "Codex production source fixture",
            }),
        );
        expect(hostOutcomeValue(await waitForHostResponse(messages, "register-project"))).toMatchObject({
            rootPath: projectRoot,
        });

        connection.receive(
            createProtocolRequest("probe", "adapter.probe", {
                adapterIds: ["CODEX"],
                environments: [{ platform: "linux", platformInstanceId: "fixture" }],
                authorization: { scope: "global" },
            }),
        );
        const probeOutcome = await waitForHostTerminal(messages, "adapter.probe");
        expect(probeOutcome.status).toBe("partial");
        const probe = hostOutcomeValue<{
            probeToken: string;
            results: Array<{
                rowId: string;
                adapterId: string;
                sources: Array<{ rowId: string; displayPath: string; locatorIdentities: unknown[] }>;
            }>;
        }>(probeOutcome, ["partial"]);
        const probeRow = probe.results.find((row) => row.adapterId === "CODEX");
        const projectSource = probeRow?.sources.find((source) => source.displayPath === projectRoot);
        expect(projectSource?.locatorIdentities).toEqual(
            expect.arrayContaining([expect.objectContaining({ locatorKind: "project_registry_entry" })]),
        );
        if (probeRow === undefined || projectSource === undefined) throw new Error("production Codex project source missing");

        connection.receive(
            createProtocolRequest("read", "adapter.read", {
                probeToken: probe.probeToken,
                selections: [
                    {
                        probeResultRowId: probeRow.rowId,
                        sourceRootRowIds: [projectSource.rowId],
                        allowedKinds: ["Guidance"],
                    },
                ],
            }),
        );
        const read = hostOutcomeValue<{ readToken: string; candidateCount: number }>(
            await waitForHostTerminal(messages, "adapter.read"),
        );
        expect(read.candidateCount).toBe(2);

        connection.receive(createProtocolRequest("preview", "import.preview", { readToken: read.readToken }));
        const preview = hostOutcomeValue<{
            previewToken: string;
            snapshotFingerprint: string;
            candidates: Array<{ candidateId: string; displayName: string }>;
        }>(await waitForHostTerminal(messages, "import.preview"));
        expect(preview.candidates).toEqual([expect.objectContaining({ displayName: "AGENTS.md" })]);
        const candidateId = preview.candidates[0]?.candidateId;
        if (candidateId === undefined) throw new Error("production Codex preview has no candidate");

        connection.receive(
            createProtocolRequest("accept", "import.accept_batch", {
                previewToken: preview.previewToken,
                expectedSnapshotFingerprint: preview.snapshotFingerprint,
                decisions: [
                    {
                        candidateId,
                        action: "create_asset",
                        freshness: { freshnessAction: "require_current_source" },
                        promotion: { promotionAction: "import_only", userActionId: "accept-codex-production-source" },
                        callableBindings: [],
                    },
                ],
            }),
        );
        expect(hostOutcomeValue(await waitForHostTerminal(messages, "import.accept_batch"))).toMatchObject({
            items: [{ status: "complete", candidateId }],
        });

        connection.receive(createProtocolRequest("catalog", "asset.list", { kind: "Guidance" }));
        expect(hostOutcomeValue(await waitForHostResponse(messages, "catalog"))).toMatchObject({
            assets: [expect.objectContaining({ displayName: "AGENTS.md", kind: "Guidance" })],
        });
    });
});

function enableCodex(core: ReturnType<typeof createCoreService>): void {
    const current = core.getAdapterEnablement();
    const result = core.replaceAdapterEnablement({
        expectedRevision: current.value.revision,
        expectedSettingFingerprint: current.value.settingFingerprint,
        enabledAdapterIds: [codexProvider.adapterId],
        userActionId: "enable-codex-source-fixture",
    });
    if (result.status !== "complete") throw new Error(`failed to enable Codex: ${JSON.stringify(result.diagnostics)}`);
}

function restoreEnvironment(saved: Record<"HOME" | "CODEX_HOME" | "PATH", string | undefined>): void {
    for (const key of ["HOME", "CODEX_HOME", "PATH"] as const) {
        const value = saved[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}
