/** Core-port conformance for every callable adapter-framework source path mechanism. */

import { describe, expect, it } from "vitest";
import type {
    AdapterAssetSourceCapability,
    AdapterProviderReadInput,
    AdapterProviderReadResult,
    AdapterReadTarget,
    OperationDiagnostic,
    ReadEntryHandle,
    SourceReadObligation,
    SourceRoot,
} from "../../packages/core/src/types";
import { createAdapterReadOperationForTest } from "../../packages/core/src/adapters/adapter-read-access";
import { withReadBatch } from "../../packages/core/tests/adapters/fixtures/adapter-read-filesystem";
import { validateProviderReadResult } from "../../packages/core/src/source-import/source-read-provider-result-validator";
import { traverseSourceRead } from "../../packages/adapter/framework/src/source-traversal";
import type { SourceContextBase } from "../../packages/adapter/framework/src/source-model";

const CAPABILITY_FINGERPRINT = `sha256:${"1".repeat(64)}` as const;
const AUTHORITY_FINGERPRINT = `sha256:${"2".repeat(64)}` as const;
const FILE_IDENTITY = { deviceId: "1", fileId: "10", entryKind: "file" as const };
const DIRECTORY_IDENTITY = {
    deviceId: "1",
    fileId: "20",
    entryKind: "directory" as const,
};

const root: SourceRoot = {
    sourceRootId: "root",
    rootRole: "source",
    sourceDomain: "family_shared",
    path: "/fixture/source",
    accessStatus: "available",
    locatorEvidence: [],
    diagnostics: [],
};

const obligation: SourceReadObligation = {
    sourceReadObligationId: "obligation",
    sourceRootId: root.sourceRootId,
    sourceCapabilityFingerprint: CAPABILITY_FINGERPRINT,
};

type Context = SourceContextBase<"fixture">;

const context: Context = {
    root,
    scope: "global",
    projectRootPath: "",
    layout: "fixture",
};

describe("adapter-framework traversal through the real Core read authority", () => {
    it.each([
        ["fixed_file", "file", "parsed", 0, 2],
        ["manifest_declared", "file", "parsed", 0, 2],
        ["directory_entry", "directory", "traversed", 2, 0],
        ["recursive_entry", "directory", "traversed", 2, 0],
    ] as const)("closes %s with the exact Core-issued root operation", async (mechanism, entryKind, dispositionKind, expectedLists, expectedReads) => {
        const capability = capabilityFor(mechanism);
        const calls = { list: 0, read: 0 };
        const operation = createAdapterReadOperationForTest(
            {
                platform: "linux",
                sourceRoots: [root],
                sourceReadObligations: [obligation],
                sourceCapabilities: [capability],
                managedTargetGuards: [],
                readAuthorityFingerprint: AUTHORITY_FINGERPRINT,
                transactionsRoot: "/transactions",
            },
            withReadBatch({
                readRegularFileNoFollow() {
                    calls.read += 1;
                    return {
                        bytes: new TextEncoder().encode("fixture"),
                        executable: false,
                        identity: FILE_IDENTITY,
                    };
                },
                inventoryDirectoryNoFollow() {
                    calls.list += 1;
                    return { identity: DIRECTORY_IDENTITY, entries: [] };
                },
            }),
            () => ({ release() {} }),
        );
        const input: AdapterProviderReadInput = {
            target: { sourceSelector: target().sourceSelector },
            sourceReadObligations: [obligation],
            managedTargetGuards: [],
            readAuthorityFingerprint: AUTHORITY_FINGERPRINT,
            readAccess: operation.readAccess,
        };

        const scan = await traverseSourceRead(input, obligation, capability, context, policy());
        const providerResult: AdapterProviderReadResult = {
            candidates: [],
            sourceParseReports: [
                {
                    sourceRootId: root.sourceRootId,
                    sourceReadObligationIds: [obligation.sourceReadObligationId],
                    status: "empty",
                    observedReadEntryIds: scan.observedReadEntryIds,
                    readEntryDispositions: scan.dispositions,
                    diagnostics: scan.diagnostics,
                },
            ],
            diagnostics: scan.diagnostics,
        };
        const ledger = operation.snapshot();
        const diagnostics = validateProviderReadResult(
            target(),
            {
                platform: "linux",
                roots: [root],
                obligations: [obligation],
                capabilities: [capability],
                readAuthorityFingerprint: AUTHORITY_FINGERPRINT,
            },
            [],
            ledger,
            providerResult,
        );

        expect(calls).toEqual({ list: expectedLists, read: expectedReads });
        expect(scan.files).toHaveLength(entryKind === "file" ? 1 : 0);
        expect(scan.directories).toHaveLength(entryKind === "directory" ? 1 : 0);
        expect(scan.dispositions).toEqual([expect.objectContaining({ disposition: dispositionKind })]);
        expect(diagnostics).toEqual([]);
        expect(operation.finalValidate()).toEqual({ valid: true, diagnostics: [] });
    });
});

function capabilityFor(sourcePathMechanism: AdapterAssetSourceCapability["sourcePathMechanism"]): AdapterAssetSourceCapability {
    return {
        sourceCapabilityFingerprint: CAPABILITY_FINGERPRINT,
        agentRuntimeId: "FIXTURE_CLI",
        entrySupportStatus: "supported",
        rootLocatorKind: "runtime_known_rule",
        rootRole: root.rootRole,
        sourceDomain: root.sourceDomain,
        assetKind: "Guidance",
        sourcePathMechanism,
        evidenceLevel: "agent_runtime_verified",
        readPolicy: "auto_read",
        diagnostics: [],
    };
}

function target(): AdapterReadTarget {
    return {
        adapterId: "FIXTURE",
        allowedKinds: ["Guidance"],
        sourceSelector: {
            selectorKind: "probe_roots",
            observation: {
                adapterId: "FIXTURE",
                platformContext: {
                    platform: "linux",
                    platformInstanceId: "local",
                    accessRootPath: "/",
                },
                observedAgentRuntimes: [
                    {
                        agentRuntimeId: "FIXTURE_CLI",
                        versionText: "fixture",
                        installationEvidence: [],
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

function policy() {
    return {
        shouldEnterDirectory: () => false,
        shouldReadFile: () => false,
        dispositionId: (handle: ReadEntryHandle) => `disposition:${handle.readEntryHandleId}`,
        rootEntryKindDiagnostic: () => diagnostic("fixture.root_kind_invalid"),
        mechanismNotCallableDiagnostic: () => diagnostic("fixture.mechanism_not_callable"),
    };
}

function diagnostic(code: string): OperationDiagnostic {
    return {
        severity: "error",
        code,
        message: code,
        path: root.path,
        traceId: "",
        operation: "read",
        causeKind: "invalid_schema",
        retryable: false,
        suggestedActions: [],
        rawSummary: "",
    };
}
