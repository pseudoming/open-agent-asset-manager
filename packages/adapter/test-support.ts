/** Runtime-neutral test mechanics shared by the built-in adapter suites. */

import type {
    AdapterAssetSourceCapability,
    AdapterId,
    AdapterProbeContext,
    AdapterProvider,
    AdapterProviderReadInput,
    AdapterReadAccess,
    AdapterReadResult,
    AdapterReadTarget,
    AgentRuntimeId,
    ImportAcceptRequest,
    Platform,
    PlatformContext,
    PortableSelectorDialectFieldV1,
    PortableSelectorDialectUseV1,
    ProbeObservation,
    ReadAccessOutcomeStatus,
    ReadAccessResult,
    ReadEntryHandle,
    Sha256Digest,
    SourceRoot,
    UuidV4,
} from "@oaam/core";
import { acquireProjectAuthorityLocks } from "../core/src/catalog/project-authority";
import { createVersionDialectRegistry } from "../core/src/catalog/version-dialect-registry";
import { createImportService, type ImportService } from "../core/src/orchestration/import-service";
import { executeAdapterReadWithAuthority } from "../core/src/source-import/source-read-execution";
import { prepareRead } from "../core/src/source-import/source-read-preparation";

export type AdapterFixtureValue = string | Uint8Array | { readonly text: string; readonly executable: boolean };

export function fixtureFrontmatter(frontmatter: string, body: string): string {
    return `---\n${frontmatter}\n---\n${body}\n`;
}

export function fixturePlatformContext(platform: Platform = "linux"): PlatformContext {
    return { platform, platformInstanceId: "fixture", accessRootPath: "/" };
}

export function fixtureGlobalProbeContext(platform: Platform = "linux"): AdapterProbeContext {
    return { authorizationScope: "global", platformContext: fixturePlatformContext(platform) };
}

export function fixtureProjectProbeContext(projectRootPath: string, platform: Platform = "linux"): AdapterProbeContext {
    return {
        authorizationScope: "project",
        platformContext: fixturePlatformContext(platform),
        projectRootPath,
    };
}

export function fixtureDirectoryProbeContext(directoryRootPath: string, platform: Platform = "linux"): AdapterProbeContext {
    return {
        authorizationScope: "directory",
        platformContext: fixturePlatformContext(platform),
        directoryRootPath,
    };
}

export function fixtureSourceRoot(input: {
    readonly sourceRootId: string;
    readonly path: string;
    readonly rootRole: SourceRoot["rootRole"];
    readonly sourceDomain: SourceRoot["sourceDomain"];
    readonly locatorKind: SourceRoot["locatorEvidence"][number]["locatorKind"];
    readonly locatorKey: string;
    readonly evidenceLevel: SourceRoot["locatorEvidence"][number]["evidenceLevel"];
}): SourceRoot {
    return {
        sourceRootId: input.sourceRootId,
        rootRole: input.rootRole,
        sourceDomain: input.sourceDomain,
        path: input.path,
        accessStatus: "available",
        locatorEvidence: [
            {
                locatorKind: input.locatorKind,
                locatorKey: input.locatorKey,
                evidenceLevel: input.evidenceLevel,
            },
        ],
        diagnostics: [],
    };
}

export function fixtureProbeObservation(input: {
    readonly adapterId: AdapterId;
    readonly agentRuntimeId: AgentRuntimeId;
    readonly versionText: string;
    readonly sourceRoots: readonly SourceRoot[];
    readonly installationEvidence: ProbeObservation["observedAgentRuntimes"][number]["installationEvidence"];
    readonly installationStatus: ProbeObservation["observedAgentRuntimes"][number]["installationStatus"];
    readonly projectDiscoveryStatus: ProbeObservation["observedAgentRuntimes"][number]["projectDiscoveryStatus"];
    readonly platformContext?: PlatformContext;
}): ProbeObservation {
    return {
        adapterId: input.adapterId,
        platformContext: input.platformContext ?? fixturePlatformContext(),
        observedAgentRuntimes: [
            {
                agentRuntimeId: input.agentRuntimeId,
                versionText: input.versionText,
                installationEvidence: [...input.installationEvidence],
                sourceRootIds: input.sourceRoots.map((root) => root.sourceRootId),
                agentRuntimeResourceIds: [],
                observedProjectIds: [],
                installationStatus: input.installationStatus,
                projectDiscoveryStatus: input.projectDiscoveryStatus,
                diagnostics: [],
            },
        ],
        sourceRoots: [...input.sourceRoots],
        agentRuntimeResources: [],
        observedProjects: [],
        targetCandidates: [],
    };
}

export function bindFixtureProbeObservation(input: {
    readonly adapterId: AdapterId;
    readonly agentRuntimeId: AgentRuntimeId;
    readonly versionText: string;
    readonly installationEvidence: ProbeObservation["observedAgentRuntimes"][number]["installationEvidence"];
    readonly installationStatus: ProbeObservation["observedAgentRuntimes"][number]["installationStatus"];
    readonly projectDiscoveryStatus: ProbeObservation["observedAgentRuntimes"][number]["projectDiscoveryStatus"];
}): (root: SourceRoot) => ProbeObservation {
    return (root) => fixtureProbeObservation({ ...input, sourceRoots: [root] });
}

export function fixtureProbeRootTarget(input: {
    readonly adapterId: AdapterId;
    readonly agentRuntimeId: AgentRuntimeId;
    readonly versionText: string;
    readonly sourceRoots: readonly SourceRoot[];
    readonly allowedKinds: AdapterReadTarget["allowedKinds"];
    readonly installationEvidence: ProbeObservation["observedAgentRuntimes"][number]["installationEvidence"];
    readonly installationStatus: ProbeObservation["observedAgentRuntimes"][number]["installationStatus"];
    readonly projectDiscoveryStatus: ProbeObservation["observedAgentRuntimes"][number]["projectDiscoveryStatus"];
}): AdapterReadTarget {
    return {
        adapterId: input.adapterId,
        allowedKinds: input.allowedKinds,
        sourceSelector: {
            selectorKind: "probe_roots",
            observation: fixtureProbeObservation(input),
            sourceRootIds: input.sourceRoots.map((root) => root.sourceRootId),
        },
    };
}

export function bindFixtureProbeRootTarget(input: {
    readonly adapterId: AdapterId;
    readonly agentRuntimeId: AgentRuntimeId;
    readonly versionText: string;
    readonly installationEvidence: ProbeObservation["observedAgentRuntimes"][number]["installationEvidence"];
    readonly installationStatus: ProbeObservation["observedAgentRuntimes"][number]["installationStatus"];
    readonly projectDiscoveryStatus: ProbeObservation["observedAgentRuntimes"][number]["projectDiscoveryStatus"];
}): (sourceRoots: SourceRoot[], allowedKinds: AdapterReadTarget["allowedKinds"]) => AdapterReadTarget {
    return (sourceRoots, allowedKinds) => fixtureProbeRootTarget({ ...input, sourceRoots, allowedKinds });
}

export function fixtureProviderReadInput(input: {
    readonly root: SourceRoot;
    readonly capabilities: readonly AdapterAssetSourceCapability[];
    readonly fixture: Readonly<Record<string, AdapterFixtureValue>>;
    readonly digest: Sha256Digest;
    readonly observation: ProbeObservation;
    readonly resolveEntries: boolean;
    readonly obligationId: (capability: AdapterAssetSourceCapability, index: number) => string;
}): AdapterProviderReadInput {
    return {
        target: {
            sourceSelector: {
                selectorKind: "probe_roots",
                observation: input.observation,
                sourceRootIds: [input.root.sourceRootId],
            },
        },
        sourceReadObligations: input.capabilities.map((capability, index) => ({
            sourceReadObligationId: input.obligationId(capability, index),
            sourceRootId: input.root.sourceRootId,
            sourceCapabilityFingerprint: capability.sourceCapabilityFingerprint,
        })),
        managedTargetGuards: [],
        readAuthorityFingerprint: input.digest,
        readAccess: fixtureReadAccess({
            root: input.root,
            fixture: input.fixture,
            digest: input.digest,
            resolveEntries: input.resolveEntries,
        }),
    };
}

export function bindFixtureProviderReadInput(input: {
    readonly digest: Sha256Digest;
    readonly observation: (root: SourceRoot) => ProbeObservation;
    readonly resolveEntries: boolean;
    readonly obligationId: (capability: AdapterAssetSourceCapability, index: number) => string;
}): (
    root: SourceRoot,
    capabilities: AdapterAssetSourceCapability[],
    fixture: Record<string, AdapterFixtureValue>,
) => AdapterProviderReadInput {
    return (root, capabilities, fixture) =>
        fixtureProviderReadInput({
            ...input,
            root,
            capabilities,
            fixture,
            observation: input.observation(root),
        });
}

export function bindUserSelectedReadInput(
    createBase: (
        root: SourceRoot,
        capabilities: AdapterAssetSourceCapability[],
        fixture: Record<string, AdapterFixtureValue>,
    ) => AdapterProviderReadInput,
): (
    root: SourceRoot,
    capability: AdapterAssetSourceCapability,
    assetScope: "global" | "project",
    projectRootPath: string,
    fixture: Record<string, AdapterFixtureValue>,
) => AdapterProviderReadInput {
    return (root, capability, assetScope, projectRootPath, fixture) => {
        const input = createBase(root, [capability], fixture);
        return {
            ...input,
            target: {
                sourceSelector: {
                    selectorKind: "user_selected_root",
                    platformContext: fixturePlatformContext(),
                    binding: { sourceRoot: root, assetScope, projectRootPath },
                },
            },
        };
    };
}

export function fixtureReadAccess(input: {
    readonly root: SourceRoot;
    readonly fixture: Readonly<Record<string, AdapterFixtureValue>>;
    readonly digest: Sha256Digest;
    readonly resolveEntries: boolean;
}): AdapterReadAccess {
    const files = new Map(
        Object.entries(input.fixture).map(([relativePath, value]) => [
            relativePath,
            typeof value === "string"
                ? { bytes: Buffer.from(value), executable: false }
                : value instanceof Uint8Array
                  ? { bytes: value, executable: false }
                  : { bytes: Buffer.from(value.text), executable: value.executable },
        ]),
    );
    const directories = new Set<string>([""]);
    for (const relativePath of files.keys()) {
        const segments = relativePath.split("/");
        segments.pop();
        while (segments.length > 0) {
            directories.add(segments.join("/"));
            segments.pop();
        }
    }

    let outcomeSequence = 0;
    let handleSequence = 0;
    const handles = new Map<string, { readonly handle: ReadEntryHandle; consumed: boolean }>();
    const outcome = () => `outcome-${++outcomeSequence}`;
    const handle = (obligationId: string, relativePath: string, entryKind: "file" | "directory"): ReadEntryHandle => {
        const issued: ReadEntryHandle = {
            readEntryHandleId: `fixture-handle-${++handleSequence}`,
            sourceReadObligationId: obligationId,
            sourceRootId: input.root.sourceRootId,
            relativePath,
            entryKind,
        };
        handles.set(issued.readEntryHandleId, { handle: issued, consumed: false });
        return issued;
    };
    const activeHandle = (
        handleId: string,
        entryKind: ReadEntryHandle["entryKind"],
    ): { readonly handle: ReadEntryHandle; consumed: boolean } | undefined => {
        const record = handles.get(handleId);
        return record !== undefined && !record.consumed && record.handle.entryKind === entryKind ? record : undefined;
    };
    const observedId = (item: ReadEntryHandle) => `observed:${item.readEntryHandleId}`;

    return {
        async resolveRootEntry(obligationId, sourceRootId) {
            if (sourceRootId !== input.root.sourceRootId) {
                return readAccessFailed(outcome(), "not_found");
            }
            return readAccessSucceeded(outcome(), handle(obligationId, "", "directory"));
        },
        async resolveEntry(obligationId, sourceRootId, relativePath) {
            if (!input.resolveEntries || sourceRootId !== input.root.sourceRootId) {
                return readAccessFailed(outcome(), "not_found");
            }
            if (directories.has(relativePath)) {
                return readAccessSucceeded(outcome(), handle(obligationId, relativePath, "directory"));
            }
            if (files.has(relativePath)) {
                return readAccessSucceeded(outcome(), handle(obligationId, relativePath, "file"));
            }
            return readAccessFailed(outcome(), "not_found");
        },
        async listDirectory(handleId) {
            const record = activeHandle(handleId, "directory");
            if (record === undefined) return readAccessFailed(outcome(), "io_error");
            const current = record.handle;
            const prefix = current.relativePath === "" ? "" : `${current.relativePath}/`;
            const childPaths = new Set<string>();
            for (const candidate of [...directories, ...files.keys()]) {
                if (!candidate.startsWith(prefix) || candidate === current.relativePath) continue;
                const remainder = candidate.slice(prefix.length);
                if (remainder === "" || remainder.includes("/")) continue;
                childPaths.add(candidate);
            }
            const children = [...childPaths]
                .sort()
                .map((relativePath) =>
                    handle(current.sourceReadObligationId, relativePath, directories.has(relativePath) ? "directory" : "file"),
                );
            record.consumed = true;
            return readAccessSucceeded(outcome(), {
                directory: {
                    observedReadEntryId: observedId(current),
                    sourceRootId: input.root.sourceRootId,
                    relativePath: current.relativePath,
                    entryKind: "directory" as const,
                    physicalIdentityFingerprint: input.digest,
                    directoryInventoryFingerprint: input.digest,
                },
                children,
            });
        },
        async readFile(handleId) {
            const record = activeHandle(handleId, "file");
            if (record === undefined) return readAccessFailed(outcome(), "io_error");
            const current = record.handle;
            const value = files.get(current.relativePath);
            if (value === undefined) return readAccessFailed(outcome(), "not_found");
            record.consumed = true;
            return readAccessSucceeded(outcome(), {
                entry: {
                    observedReadEntryId: observedId(current),
                    sourceRootId: input.root.sourceRootId,
                    relativePath: current.relativePath,
                    entryKind: "file" as const,
                    contentHash: input.digest,
                    executable: value.executable,
                    physicalIdentityFingerprint: input.digest,
                },
                bytes: new Uint8Array(value.bytes),
            });
        },
        async verifyExternalAttestation() {
            return { state: "failed", failureStatus: "unsupported_verifier", diagnostics: [] };
        },
    };
}

export function unexpectedReadAccess(onCall: () => void): AdapterReadAccess {
    const fail = (): never => {
        onCall();
        throw new Error("report-only capability invoked read access");
    };
    return {
        async resolveRootEntry() {
            return fail();
        },
        async resolveEntry() {
            return fail();
        },
        async listDirectory() {
            return fail();
        },
        async readFile() {
            return fail();
        },
        async verifyExternalAttestation() {
            return fail();
        },
    };
}

export function failingReadAccess(failureStatus: Exclude<ReadAccessOutcomeStatus, "succeeded"> = "not_found"): AdapterReadAccess {
    return {
        async resolveRootEntry() {
            return readAccessFailed("failed-root", failureStatus);
        },
        async resolveEntry() {
            return readAccessFailed("failed-entry", failureStatus);
        },
        async listDirectory() {
            return readAccessFailed("failed-list", failureStatus);
        },
        async readFile() {
            return readAccessFailed("failed-read", failureStatus);
        },
        async verifyExternalAttestation() {
            return { state: "failed", failureStatus: "unsupported_verifier", diagnostics: [] };
        },
    };
}

export function nonDirectoryRootReadAccess(root: SourceRoot): AdapterReadAccess {
    return {
        async resolveRootEntry(obligationId) {
            return readAccessSucceeded("root-file", {
                readEntryHandleId: `${obligationId}:file:<root>`,
                sourceReadObligationId: obligationId,
                sourceRootId: root.sourceRootId,
                relativePath: "",
                entryKind: "file" as const,
            });
        },
        async resolveEntry() {
            return readAccessFailed("failed-entry", "not_found");
        },
        async listDirectory() {
            return readAccessFailed("failed-list", "not_found");
        },
        async readFile() {
            return readAccessFailed("failed-read", "not_found");
        },
        async verifyExternalAttestation() {
            return { state: "failed", failureStatus: "unsupported_verifier", diagnostics: [] };
        },
    };
}

export function readAccessSucceeded<T>(readAccessOutcomeId: string, value: T): ReadAccessResult<T> {
    return { state: "succeeded", readAccessOutcomeId, value };
}

export function readAccessFailed(
    readAccessOutcomeId: string,
    failureStatus: Exclude<ReadAccessOutcomeStatus, "succeeded">,
): ReadAccessResult<never> {
    return { state: "failed", readAccessOutcomeId, failureStatus, diagnostics: [] };
}

export function requireAdapterCapability(
    provider: AdapterProvider,
    predicate: (row: AdapterAssetSourceCapability) => boolean,
    message: string,
): AdapterAssetSourceCapability {
    const capability = provider.assetSourceCapabilities.find(predicate);
    if (capability === undefined) throw new Error(message);
    return capability;
}

export function bindRequiredAdapterCapability(
    provider: AdapterProvider,
    message: string,
): (predicate: (row: AdapterAssetSourceCapability) => boolean) => AdapterAssetSourceCapability {
    return (predicate) => requireAdapterCapability(provider, predicate, message);
}

export function bindWorkflowEntryAgentValidator(provider: AdapterProvider) {
    return (agent: object, versionStatus: "complete" | "incomplete" = "complete"): boolean => {
        const contract = provider.dialectContracts.portableEntries.find(
            (candidate) => candidate.definition.field === "workflow_instruction",
        );
        if (contract === undefined) {
            throw new Error(`missing ${provider.adapterId} Workflow entry contract`);
        }
        return contract.validateCanonicalEntry({
            use: {
                kind: "Workflow",
                field: "workflow_instruction",
                dialectId: contract.definition.dialectId,
                logicalPath: "WORKFLOW.md",
            },
            versionStatus,
            canonical: {
                kind: "Workflow",
                typeData: {
                    implementation: {
                        kind: "instructions",
                        instructionDialectId: contract.definition.dialectId,
                        execution: { agent },
                    },
                },
            },
            canonicalFiles:
                versionStatus === "complete"
                    ? [
                          {
                              contentKind: "text",
                              text: "Review.\n",
                              file: { logicalPath: "WORKFLOW.md", role: "entry" },
                          },
                      ]
                    : [],
        } as never);
    };
}

export function bindPortableSelectorValidator(provider: AdapterProvider) {
    return (field: PortableSelectorDialectFieldV1, value: PortableSelectorDialectUseV1["value"]): boolean => {
        const contract = provider.dialectContracts.portableSelectors.find((candidate) => candidate.definition.field === field);
        if (contract === undefined) {
            throw new Error(`missing ${provider.adapterId} portable selector: ${field}`);
        }
        return contract.validateSelector({
            kind: contract.definition.kind,
            field,
            dialectId: contract.definition.dialectId,
            value,
        });
    };
}

export function bindDialectRegistry(provider: AdapterProvider) {
    return () =>
        createVersionDialectRegistry(
            provider.dialectContracts.native,
            provider.dialectContracts.restoration,
            provider.dialectContracts.portableEntries,
            provider.dialectContracts.portableSelectors,
        );
}

export function deterministicUuidFactory(): () => UuidV4 {
    let next = 1;
    return () => {
        const suffix = String(next).padStart(12, "0");
        next += 1;
        return `00000000-0000-4000-8000-${suffix}`;
    };
}

export async function authoritativeFixtureRead(input: {
    readonly provider: AdapterProvider;
    readonly target: AdapterReadTarget;
    readonly transactionsRoot: string;
}): Promise<AdapterReadResult> {
    const result = await executeAdapterReadWithAuthority(input.provider, input.target, {
        managedTargetGuards: [],
        reservationIdentityFingerprints: [],
        transactionsRoot: input.transactionsRoot,
    });
    if (result.status !== "complete") {
        throw new Error(JSON.stringify(result.diagnostics, null, 2));
    }
    return result.value;
}

export function bindAuthoritativeFixtureRead(input: {
    readonly provider: AdapterProvider;
    readonly target: (sourceRoots: SourceRoot[], allowedKinds: AdapterReadTarget["allowedKinds"]) => AdapterReadTarget;
    readonly transactionsRoot: () => string;
}): (root: SourceRoot, allowedKinds: AdapterReadTarget["allowedKinds"]) => Promise<AdapterReadResult> {
    return (root, allowedKinds) =>
        authoritativeFixtureRead({
            provider: input.provider,
            target: input.target([root], allowedKinds),
            transactionsRoot: input.transactionsRoot(),
        });
}

export function bindFixtureReadAuthority(transactionsRoot: () => string) {
    return () => ({
        managedTargetGuards: [],
        reservationIdentityFingerprints: [],
        transactionsRoot: transactionsRoot(),
    });
}

export function fixtureImportService(input: {
    readonly provider: AdapterProvider;
    readonly assetsRoot: string;
    readonly oaamRoot: string;
    readonly authorityLocksRoot: string;
    readonly projectRootPath: string;
    readonly projectId: UuidV4;
    readonly readAgain: () => Promise<AdapterReadResult>;
}): ImportService {
    return createImportService({
        assetsRoot: input.assetsRoot,
        oaamRoot: input.oaamRoot,
        authorityLocksRoot: input.authorityLocksRoot,
        dialectRegistry: bindDialectRegistry(input.provider)(),
        resolveSourceCapabilityAgentRuntimeId: (adapterId, fingerprint) =>
            adapterId === input.provider.adapterId
                ? (input.provider.assetSourceCapabilities.find(
                      (capability) => capability.sourceCapabilityFingerprint === fingerprint,
                  )?.agentRuntimeId ?? null)
                : null,
        resolveProjectId: (projectRootPath) => (projectRootPath === input.projectRootPath ? input.projectId : null),
        acquireProjectAuthority: (projectId) => acquireProjectAuthorityLocks(input.authorityLocksRoot, [projectId]),
        refreshReadResult: async () => ({
            status: "complete",
            value: await input.readAgain(),
            diagnostics: [],
        }),
        // This fixture binds one Provider and an empty managed-source context; CoreService
        // tests separately exercise registry enablement and live DB/journal reservations.
        validateReadAuthority: (previous) => {
            const prepared = prepareRead(input.provider, previous.readTarget, {
                managedTargetGuards: [],
                reservationIdentityFingerprints: [],
                transactionsRoot: `${input.oaamRoot}/transactions`,
            });
            return !("diagnostics" in prepared) && prepared.readAuthorityFingerprint === previous.readAuthorityFingerprint;
        },
        // Provider conformance owns native/canonical import fidelity, not Core's SQLite
        // projection. CoreService composition tests exercise the real reindex callback.
        reindexImportedAsset: () => ({
            status: "complete",
            value: {
                scannedAssets: 0,
                indexedAssets: 0,
                skippedAssets: 0,
                diagnostics: [],
            },
            diagnostics: [],
        }),
        assertMutationScope: () => undefined,
        now: () => 1_000,
        newUuid: deterministicUuidFactory(),
    });
}

export function bindFixtureImportService(input: {
    readonly provider: AdapterProvider;
    readonly assetsRoot: () => string;
    readonly oaamRoot: () => string;
    readonly authorityLocksRoot: () => string;
    readonly projectRootPath: () => string;
    readonly projectId: UuidV4;
}): (readAgain: () => Promise<AdapterReadResult>, assetsRootOverride?: string) => ImportService {
    return (readAgain, assetsRootOverride) =>
        fixtureImportService({
            provider: input.provider,
            assetsRoot: assetsRootOverride ?? input.assetsRoot(),
            oaamRoot: input.oaamRoot(),
            authorityLocksRoot: input.authorityLocksRoot(),
            projectRootPath: input.projectRootPath(),
            projectId: input.projectId,
            readAgain,
        });
}

export async function acceptFixtureCandidate(input: {
    readonly service: ImportService;
    readonly read: AdapterReadResult;
    readonly candidateId: string;
    readonly userActionId: string;
}) {
    const preview = input.service.previewImport([input.read]);
    const item = preview.value.items.find((candidate) => candidate.candidateId === input.candidateId);
    if (item === undefined || item.action !== "create_asset") {
        throw new Error(
            `candidate is not importable: ${input.candidateId}: ${JSON.stringify({ item, diagnostics: preview.diagnostics })}`,
        );
    }
    const request: ImportAcceptRequest = {
        previewSnapshot: preview.value,
        decision: {
            candidateId: input.candidateId,
            action: "create_asset",
            freshness: { freshnessAction: "require_current_source" },
            promotion: { promotionAction: "import_only", userActionId: input.userActionId },
            callableBindings: [],
        },
    };
    return input.service.acceptImport(request);
}

export function bindAcceptFixtureCandidate(userActionId: string) {
    return (service: ImportService, read: AdapterReadResult, candidateId: string) =>
        acceptFixtureCandidate({ service, read, candidateId, userActionId });
}
