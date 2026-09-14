/** Phase 21 T3 single CoreService bootstrap and source/import orchestration tests. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeSourceCapabilityFingerprint } from "../../src/adapters/adapter-contract-validator";
import { createVersionDialectRegistry, readVersionAuthority } from "../../src/catalog/version-authority";
import { publishJournal } from "../../src/deployment/deployment-journal";
import { bytesToBase64, sha256Bytes } from "../../src/foundation/crypto-bytes";
import { computePhysicalKeys } from "../../src/foundation/physical-path-locks";
import { clearRegistry } from "../../src/orchestration/adapter-registry";
import { type CoreServiceTestConfiguration, createCoreServiceForTest } from "../../src/orchestration/core-service";
import { closeDb, getDb } from "../../src/persistence/db";
import { insertDeployment } from "../../src/persistence/state-db";
import type {
    AdapterId,
    AdapterProvider,
    AdapterProviderReadInput,
    AdapterProviderReadResult,
    AdapterReadTarget,
    ImportAcceptRequest,
    ImportPreviewSnapshotV1,
    PlatformContext,
    SourceRoot,
    UuidV4,
} from "../../src/types";
import { makeContractProvider } from "../adapters/fixtures/adapter-contract-fixtures";
import { makeNativeDialectContract, makeRestorationDialectContract } from "../source-import/fixtures/dialect-contracts";

const ADAPTER = "CORE_SERVICE_FAKE" as AdapterId;
const DEPLOYMENT_ID = "00000000-0000-4000-8000-000000000100" as UuidV4;
const TRANSACTION_ID = "00000000-0000-4000-8000-000000000101" as UuidV4;
const SHA_A = `sha256:${"a".repeat(64)}` as const;
const SHA_B = `sha256:${"b".repeat(64)}` as const;
const LINUX: PlatformContext = {
    platform: "linux",
    platformInstanceId: "local",
    accessRootPath: "/",
};

let sandbox = "";
let oaamRoot = "";
let sourceFile = "";
let databasePath = "";
let observedBytes = 0;
let providerReads = 0;

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-core-service-"));
    oaamRoot = path.join(sandbox, "oaam");
    sourceFile = path.join(sandbox, "GUIDANCE.md");
    databasePath = path.join(sandbox, "state.db");
    fs.writeFileSync(sourceFile, "# Source guidance\n");
    observedBytes = 0;
    providerReads = 0;
    clearRegistry();
    closeDb();
});

afterEach(() => {
    closeDb();
    clearRegistry();
    fs.rmSync(sandbox, { recursive: true, force: true });
});

function sourceRoot(): SourceRoot {
    return {
        sourceRootId: "root-1",
        rootRole: "source",
        sourceDomain: "agent_runtime_private",
        path: sourceFile,
        accessStatus: "available",
        locatorEvidence: [
            {
                locatorKind: "runtime_known_rule",
                locatorKey: "guidance",
                evidenceLevel: "agent_runtime_verified",
            },
        ],
        diagnostics: [],
    };
}

function readTarget(): AdapterReadTarget {
    const root = sourceRoot();
    return {
        adapterId: ADAPTER,
        allowedKinds: ["Guidance"],
        sourceSelector: {
            selectorKind: "probe_roots",
            observation: {
                adapterId: ADAPTER,
                platformContext: LINUX,
                observedAgentRuntimes: [
                    {
                        agentRuntimeId: `${ADAPTER}_CLI`,
                        versionText: "fixture",
                        installationEvidence: [
                            {
                                kind: "executable",
                                path: "/fixture/bin",
                                evidenceLevel: "agent_runtime_verified",
                                diagnostics: [],
                            },
                        ],
                        sourceRootIds: [root.sourceRootId],
                        agentRuntimeResourceIds: [],
                        observedProjectIds: [],
                        installationStatus: "available",
                        projectDiscoveryStatus: "not_found",
                        diagnostics: [],
                    },
                ],
                sourceRoots: [root],
                agentRuntimeResources: [],
                observedProjects: [],
                targetCandidates: [],
            },
            sourceRootIds: [root.sourceRootId],
        },
    };
}

function provider(
    beforeAccess?: () => void,
    candidateScope: "global" | "project" = "global",
    restorationBytes?: Uint8Array,
): AdapterProvider {
    const selected = makeContractProvider(ADAPTER);
    selected.dialectContracts.native.push(makeNativeDialectContract("Guidance", "core-service-guidance-v1"));
    if (restorationBytes !== undefined) {
        selected.dialectContracts.restoration.push(makeRestorationDialectContract("Guidance", "core-service-guidance-v1"));
    }
    const capability = selected.assetSourceCapabilities.find((row) => row.assetKind === "Guidance");
    if (capability === undefined) throw new Error("Guidance capability fixture missing");
    Object.assign(capability, {
        entrySupportStatus: "supported",
        rootLocatorKind: "runtime_known_rule",
        rootRole: "source",
        sourceDomain: "agent_runtime_private",
        sourcePathMechanism: "fixed_file",
        evidenceLevel: "agent_runtime_verified",
        readPolicy: "auto_read",
        diagnostics: [],
    });
    capability.sourceCapabilityFingerprint = computeSourceCapabilityFingerprint(selected, capability) as string;
    selected.read = async (input) => readProviderSource(input, beforeAccess, candidateScope, restorationBytes);
    return selected;
}

async function readProviderSource(
    input: AdapterProviderReadInput,
    beforeAccess?: () => void,
    candidateScope: "global" | "project" = "global",
    restorationBytes?: Uint8Array,
): Promise<AdapterProviderReadResult> {
    providerReads += 1;
    beforeAccess?.();
    const obligation = input.sourceReadObligations[0];
    if (obligation === undefined) throw new Error("read obligation fixture missing");
    const resolved = await input.readAccess.resolveRootEntry(obligation.sourceReadObligationId, obligation.sourceRootId);
    if (resolved.state !== "succeeded") {
        return {
            candidates: [],
            sourceParseReports: [
                {
                    sourceRootId: obligation.sourceRootId,
                    sourceReadObligationIds: [obligation.sourceReadObligationId],
                    status: "failed",
                    observedReadEntryIds: [],
                    readEntryDispositions: [],
                    diagnostics: [],
                },
            ],
            diagnostics: [],
        };
    }
    const read = await input.readAccess.readFile(resolved.value.readEntryHandleId);
    if (read.state !== "succeeded") throw new Error("source read fixture failed");
    observedBytes += read.value.bytes.byteLength;
    const candidateId = "core-service-guidance";
    return {
        candidates: [
            {
                candidateId,
                sourceRootIds: [obligation.sourceRootId],
                scope: candidateScope,
                projectRootPath: candidateScope === "project" ? path.join(sandbox, "workspace") : "",
                scopePath: "",
                displayName: "Imported Guidance",
                displayDescription: "",
                files: [
                    {
                        logicalPath: "GUIDANCE.md",
                        role: "entry",
                        contentKind: "text",
                        mediaType: "text/markdown",
                        text: Buffer.from(read.value.bytes).toString("utf-8"),
                        executable: false,
                        references: [],
                    },
                ],
                nativeRepresentation: {
                    representationSource: "canonical_files",
                    dialectId: "core-service-guidance-v1",
                },
                dialectRestorationTransition:
                    restorationBytes === undefined
                        ? { action: "inherit" }
                        : { action: "replace", bytes: new Uint8Array(restorationBytes) },
                status: "complete",
                assetCandidateStatus: "importable",
                promotionSafety: "requires_user_confirmation",
                sourceFileOrigins: [
                    {
                        logicalPath: "GUIDANCE.md",
                        observedReadEntryIds: [read.value.entry.observedReadEntryId],
                    },
                ],
                sourceContainerEntryIds: [],
                metadataSourceOrigins: [
                    {
                        metadataSubject: "display_name",
                        observedReadEntryId: read.value.entry.observedReadEntryId,
                    },
                ],
                sourceEvidence: [
                    {
                        evidenceOrigin: "observed_read",
                        observedReadEntryId: read.value.entry.observedReadEntryId,
                        kind: "document",
                        value: "GUIDANCE.md",
                        evidenceLevel: "agent_runtime_verified",
                    },
                ],
                diagnostics: [],
                kind: "Guidance",
                typeData: { schemaVersion: 1 },
            },
        ],
        sourceParseReports: [
            {
                sourceRootId: obligation.sourceRootId,
                sourceReadObligationIds: [obligation.sourceReadObligationId],
                status: "parsed",
                observedReadEntryIds: [read.value.entry.observedReadEntryId],
                readEntryDispositions: [
                    {
                        readEntryDispositionId: "core-service-disposition",
                        sourceReadObligationId: obligation.sourceReadObligationId,
                        readEntryHandleId: resolved.value.readEntryHandleId,
                        disposition: "parsed",
                        readAccessOutcomeId: read.readAccessOutcomeId,
                        observedReadEntryIds: [read.value.entry.observedReadEntryId],
                        candidateIds: [candidateId],
                    },
                ],
                diagnostics: [],
            },
        ],
        diagnostics: [],
    };
}

function identityFactory(): () => UuidV4 {
    let next = 1;
    return () => {
        const suffix = String(next).padStart(12, "0");
        next += 1;
        return `00000000-0000-4000-8000-${suffix}`;
    };
}

function service(selectedProvider = provider(), overrides: Partial<CoreServiceTestConfiguration> = {}) {
    const core = createCoreServiceForTest(
        {
            providers: [selectedProvider],
            platformContexts: [LINUX],
            oaamRoot,
            databasePath,
            now: () => 1_000,
            newUuid: identityFactory(),
            ...overrides,
        },
        {},
    );
    const current = core.getAdapterEnablement();
    if (current.status === "failed") throw new Error("adapter enablement fixture could not be read");
    if (!current.value.enabledAdapterIds.includes(selectedProvider.adapterId)) {
        const enabled = core.replaceAdapterEnablement({
            expectedRevision: current.value.revision,
            expectedSettingFingerprint: current.value.settingFingerprint,
            enabledAdapterIds: [selectedProvider.adapterId],
            userActionId: "core-service-fixture-enable",
        });
        if (enabled.status === "failed")
            throw new Error(`adapter enablement fixture failed: ${JSON.stringify(enabled.diagnostics)}`);
    }
    return core;
}

function acceptRequest(preview: ImportPreviewSnapshotV1): ImportAcceptRequest {
    const candidateId = preview.items[0]?.candidateId;
    if (candidateId === undefined) throw new Error("preview candidate fixture missing");
    return {
        previewSnapshot: preview,
        decision: {
            candidateId,
            action: "create_asset",
            freshness: { freshnessAction: "require_current_source" },
            promotion: { promotionAction: "import_only", userActionId: "accept-import" },
            callableBindings: [],
        },
    };
}

function seedDeployment(): void {
    insertDeployment(getDb(), {
        deploymentId: DEPLOYMENT_ID,
        consumerAgentRuntimeIds: '["CLAUDE_CODE_CLI"]',
        platform: "linux",
        platformInstanceId: LINUX.platformInstanceId,
        targetRootPath: sandbox,
        projectId: "",
        committedTransactionId: "",
        appliedInputsSnapshot: JSON.stringify({
            schemaVersion: 1,
            deploymentId: DEPLOYMENT_ID,
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            assets: [],
        }),
        appliedRenderSnapshotRef: '{"snapshotState":"never"}',
        observationState: "never",
        observationAttemptedAt: 0,
        lastCompleteObservationAt: 0,
        blockingEvidence:
            '{"schemaVersion":1,"reasonCode":"","operation":"","contextFingerprint":"","occurredAt":0,"diagnostics":[],"suggestedActions":[],"retryable":false}',
        deleted: 0,
        createdAt: 1,
        updatedAt: 1,
    });
}

function publishSourceReservation(): void {
    const oldBytes = new Uint8Array(Buffer.from("old"));
    const newBytes = new Uint8Array(Buffer.from("new"));
    publishJournal(path.join(oaamRoot, "transactions"), {
        schemaVersion: 1,
        transactionId: TRANSACTION_ID,
        deploymentId: DEPLOYMENT_ID,
        createdAt: 1,
        compilationFingerprint: SHA_A,
        reservedPhysicalKeys: computePhysicalKeys("linux", sandbox, ["", "GUIDANCE.md"]),
        entries: [
            {
                relativePath: "GUIDANCE.md",
                oldHash: sha256Bytes(oldBytes),
                oldBytesBase64: bytesToBase64(oldBytes),
                oldExecutable: false,
                oldProvenanceFingerprint: SHA_A,
                oldMaterializationFingerprint: SHA_A,
                newHash: sha256Bytes(newBytes),
                newBytesBase64: bytesToBase64(newBytes),
                newExecutable: false,
                newProvenanceFingerprint: SHA_B,
                newMaterializationFingerprint: SHA_B,
                isRemoval: false,
            },
        ],
    });
}

describe("CoreService T3 composition root", () => {
    it("atomically bootstraps the frozen provider set and exposes no durability internals", () => {
        const core = service();
        expect(core.listAdapterProviders().value).toEqual([expect.objectContaining({ adapterId: ADAPTER, enabled: true })]);
        expect(core.getAvailablePlatformContexts(["linux"]).value).toEqual([LINUX]);
        expect(core.getAvailablePlatformContexts(["linux", "linux"]).diagnostics[0]?.code).toBe("environment.platform_duplicate");
        expect(core.getAvailablePlatformContexts(["unsupported" as Platform]).diagnostics[0]?.code).toBe(
            "environment.platform_invalid",
        );
        for (const forbidden of [
            "registerAdapterProvider",
            "enableAdapter",
            "disableAdapter",
            "freezeRegistry",
            "markerStore",
            "receipt",
            "lease",
            "database",
            "targetPlan",
        ]) {
            expect(Object.keys(core)).not.toContain(forbidden);
        }
        expect(() => service()).toThrow(/bootstrap adapter registry failed/);
    });

    it("changes adapter enablement only through the revisioned settings authority", () => {
        const core = service();
        const enabled = core.getAdapterEnablement().value;
        const disabled = core.replaceAdapterEnablement({
            expectedRevision: enabled.revision,
            expectedSettingFingerprint: enabled.settingFingerprint,
            enabledAdapterIds: [],
            userActionId: "disable-adapter",
        });
        expect(disabled.status).toBe("complete");
        expect(core.listAdapterProviders().value[0]?.enabled).toBe(false);
        expect(
            core.replaceAdapterEnablement({
                expectedRevision: disabled.value.revision,
                expectedSettingFingerprint: disabled.value.settingFingerprint,
                enabledAdapterIds: [ADAPTER],
                userActionId: "enable-adapter",
            }).status,
        ).toBe("complete");
        expect(core.listAdapterProviders().value[0]?.enabled).toBe(true);
    });

    it("rejects invalid bootstrap configuration before publishing the process registry", () => {
        for (const invalidRoot of ["relative/root", "/", `${sandbox}/nested/../oaam`, `${oaamRoot}${path.sep}`]) {
            expect(() => service(provider(), { oaamRoot: invalidRoot })).toThrow(
                /oaamRoot must be a canonical non-root absolute path/,
            );
            expect(clearRegistry).not.toThrow();
        }
        const invalidContexts: PlatformContext[][] = [
            [LINUX, structuredClone(LINUX)],
            [{ ...LINUX, platformInstanceId: " " }],
            [{ ...LINUX, platformInstanceId: "instance\0with-separator" }],
            [{ ...LINUX, accessRootPath: "relative" }],
            [{ ...LINUX, accessRootPath: "\\root-relative" }],
            [{ ...LINUX, accessRootPath: "\\\\?\\C:\\Users\\person" }],
            [{ ...LINUX, accessRootPath: "\\\\wsl.localhost\\Ubuntu\\home\\..\\root" }],
        ];
        for (const platformContexts of invalidContexts) {
            expect(() => service(provider(), { platformContexts })).toThrow(/platformContexts must be unique and canonical/);
            clearRegistry();
        }
        expect(() =>
            service(provider(), {
                platformContexts: [
                    {
                        platform: "wsl",
                        platformInstanceId: "Ubuntu",
                        accessRootPath: "\\\\wsl.localhost\\Ubuntu\\home\\example",
                    },
                ],
            }),
        ).not.toThrow();
        expect(clearRegistry).not.toThrow();
    });

    it("replays the exact read target for current-source accept and publishes one AssetVersion", async () => {
        const core = service();
        const read = await core.readAssetsFromAdapter(readTarget());
        expect(read.status).toBe("complete");
        expect(read.value.readTarget).toEqual(readTarget());
        const preview = core.previewImport([read.value]);
        expect(preview.status).toBe("complete");
        const accepted = await core.acceptImport(acceptRequest(preview.value));
        expect(accepted.status).toBe("complete");
        expect(providerReads).toBe(2);
        expect(observedBytes).toBe(Buffer.byteLength("# Source guidance\n") * 2);
        expect(fs.readFileSync(sourceFile, "utf-8")).toBe("# Source guidance\n");
        expect(fs.existsSync(path.join(oaamRoot, "assets", accepted.value.assetId))).toBe(true);
        expect(core.listAssets().value).toEqual([
            expect.objectContaining({
                assetId: accepted.value.assetId,
                currentVersionId: accepted.value.versionId,
                kind: "Guidance",
            }),
        ]);
    });

    it("exposes batch import through the composed CoreService API", async () => {
        const core = service();
        const read = await core.readAssetsFromAdapter(readTarget());
        const preview = core.previewImport([read.value]).value;
        const candidateId = preview.items[0]?.candidateId;
        if (candidateId === undefined) throw new Error("batch preview candidate fixture missing");

        const accepted = await core.acceptImportBatch({
            previewSnapshot: preview,
            decisions: [
                {
                    candidateId,
                    action: "create_asset",
                    freshness: { freshnessAction: "require_current_source" },
                    promotion: { promotionAction: "import_only", userActionId: "accept-batch-import" },
                    callableBindings: [],
                },
            ],
        });

        expect(accepted.status).toBe("complete");
        expect(accepted.value.items).toEqual([
            expect.objectContaining({
                status: "complete",
                candidateId,
            }),
        ]);
        const completed = accepted.value.items[0];
        if (completed?.status !== "complete") throw new Error("batch import fixture did not complete");
        expect(core.listAssets().value).toEqual([
            expect.objectContaining({
                assetId: completed.version.assetId,
                currentVersionId: completed.version.versionId,
                kind: "Guidance",
            }),
        ]);
        expect(providerReads).toBe(2);
    });

    it("binds project-scoped import to the registered Project authority under its lock", async () => {
        const workspace = path.join(sandbox, "workspace");
        fs.mkdirSync(workspace);
        const core = service(provider(undefined, "project"));
        const project = core.registerProject({ rootPath: workspace });
        expect(project.status).toBe("complete");
        const read = await core.readAssetsFromAdapter(readTarget());
        const preview = core.previewImport([read.value]);
        const accepted = await core.acceptImport(acceptRequest(preview.value));
        expect(accepted.status).toBe("complete");
        expect(core.getAsset(accepted.value.assetId).value.value).toMatchObject({
            scope: "project",
            projectId: project.value.projectId,
        });
    });

    it("retains exact native and restoration payloads for a canonically unchanged user Version", async () => {
        const restoration = new Uint8Array(Buffer.from("restoration-payload"));
        const selectedProvider = provider(undefined, "global", restoration);
        const core = service(selectedProvider);
        const read = await core.readAssetsFromAdapter(readTarget());
        const accepted = await core.acceptImport(acceptRequest(core.previewImport([read.value]).value));
        if (accepted.status !== "complete") throw new Error("import fixture failed");
        const next = core.createVersion(accepted.value.assetId, {
            typeData: { schemaVersion: 1 },
            files: [
                {
                    logicalPath: "GUIDANCE.md",
                    role: "entry",
                    contentKind: "text",
                    mediaType: "text/markdown",
                    text: "# Source guidance\n",
                    executable: false,
                    references: [],
                },
            ],
            userActionEvidenceId: "preserve-native",
            changeKind: "edit",
            sourceVersionId: accepted.value.versionId,
        });
        expect(next.status).toBe("complete");
        const registry = createVersionDialectRegistry(
            selectedProvider.dialectContracts.native,
            selectedProvider.dialectContracts.restoration,
            selectedProvider.dialectContracts.portableEntries,
            selectedProvider.dialectContracts.portableSelectors,
        );
        const closure = readVersionAuthority(
            path.join(oaamRoot, "assets"),
            accepted.value.assetId,
            next.value.versionId,
            registry,
        );
        expect(closure?.nativePayloads).toHaveLength(1);
        expect(closure?.nativePayloads[0]?.files[0]?.bytes).toEqual(new Uint8Array(Buffer.from("# Source guidance\n")));
        expect(closure?.restorationPayloads).toEqual([{ dialectId: "core-service-guidance-v1", bytes: restoration }]);
    });

    it("rejects a reservation published after the initial snapshot before source bytes are read", async () => {
        const core = service(provider(publishSourceReservation));
        seedDeployment();
        const result = await core.readAssetsFromAdapter(readTarget());
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.code, JSON.stringify(result.diagnostics)).toBe("read.authority_changed");
        expect(providerReads).toBe(1);
        expect(observedBytes).toBe(0);
        expect(fs.readFileSync(sourceFile, "utf-8")).toBe("# Source guidance\n");
    });

    it("maps invalid roots and an unreadable authority inventory to typed read failures", async () => {
        const core = service();
        const invalid = readTarget();
        if (invalid.sourceSelector.selectorKind !== "probe_roots") throw new Error("probe fixture");
        invalid.sourceSelector.observation.sourceRoots[0]!.path = "relative/root";
        expect((await core.readAssetsFromAdapter(invalid)).diagnostics[0]?.code).toBe("read_authority.selected_root_invalid");

        fs.rmSync(path.join(oaamRoot, "transactions"), { recursive: true, force: true });
        fs.writeFileSync(path.join(oaamRoot, "transactions"), "not-a-directory");
        expect((await core.readAssetsFromAdapter(readTarget())).diagnostics[0]?.code).toBe("read.authority_unavailable");
    });

    it("maps corrupt deployment and reverse reservations to typed mutation blocks", () => {
        const core = service();
        const enablement = core.getAdapterEnablement().value;
        const settingsBefore = fs.readFileSync(path.join(oaamRoot, "settings.json"), "utf-8");
        const journalDirectory = path.join(oaamRoot, "transactions", TRANSACTION_ID);
        fs.mkdirSync(journalDirectory, { recursive: true });
        fs.writeFileSync(path.join(journalDirectory, "journal.json"), "{corrupt");
        const current = core.getRestrictedSourcePromotionFullAccess().value;
        const blockedSetting = core.setRestrictedSourcePromotionFullAccess({
            settingId: current.settingId,
            expectedRevision: current.revision,
            expectedSettingFingerprint: current.settingFingerprint,
            nextState: "enabled",
            userActionId: "full-access",
        });
        expect(blockedSetting.diagnostics[0]?.code).toBe("mutation_scope.corrupt_deployment_journal");
        expect(
            core.replaceAdapterEnablement({
                expectedRevision: enablement.revision,
                expectedSettingFingerprint: enablement.settingFingerprint,
                enabledAdapterIds: [],
                userActionId: "blocked-disable",
            }).diagnostics[0]?.code,
        ).toBe("mutation_scope.corrupt_deployment_journal");
        expect(fs.readFileSync(path.join(oaamRoot, "settings.json"), "utf-8")).toBe(settingsBefore);

        fs.rmSync(path.join(oaamRoot, "transactions"), { recursive: true, force: true });
        const reverseDirectory = path.join(oaamRoot, "transactions", "reverse-accept");
        fs.mkdirSync(reverseDirectory, { recursive: true });
        fs.writeFileSync(path.join(reverseDirectory, "not-an-authority"), "bad");
        expect(
            core.replaceAdapterEnablement({
                expectedRevision: enablement.revision,
                expectedSettingFingerprint: enablement.settingFingerprint,
                enabledAdapterIds: [],
                userActionId: "blocked-disable",
            }).diagnostics[0]?.code,
        ).toBe("mutation_scope.reverse_accept_active");
    });
});
