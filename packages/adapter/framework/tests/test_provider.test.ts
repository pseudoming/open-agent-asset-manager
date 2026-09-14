import { describe, expect, it } from "vitest";
import type { AdapterProvider, OperationDiagnostic } from "@oaam/core";
import {
    defineAdapterProvider,
    isAdapterFrameworkProvider,
    isAdapterFrameworkReadHandler,
    isAdapterFrameworkTargetHandler,
    sourceReader,
    sourceUnavailable,
    type AdapterFrameworkProviderDefinition,
    type SourceContextBase,
    type SourceScanResultBase,
} from "../src";

type TestContext = SourceContextBase<"test">;
type TestScan = SourceScanResultBase;

function diagnostic(): OperationDiagnostic {
    return {
        severity: "error",
        code: "test.unused",
        message: "unused",
        path: "",
        traceId: "",
        operation: "read",
        causeKind: "invalid_schema",
        retryable: false,
        suggestedActions: ["skip"],
        rawSummary: "",
    };
}

function definition(): AdapterFrameworkProviderDefinition<TestContext, TestScan> {
    const reader = sourceReader(() => ({ candidates: [], diagnostics: [], ignoredSource: false }));
    return {
        adapterId: "TEST",
        displayName: "Test Provider",
        version: "1.0.0",
        agentRuntimes: [],
        targetContextSchemas: [],
        assetSourceCapabilities: [
            {
                sourceCapabilityFingerprint: `sha256:${"0".repeat(64)}`,
                agentRuntimeId: "TEST_CLI",
                entrySupportStatus: "supported",
                rootLocatorKind: "known_path",
                rootRole: "source",
                sourceDomain: "family_shared",
                assetKind: "Guidance",
                sourcePathMechanism: "known_path",
                evidenceLevel: "runtime_verified",
                readPolicy: "auto_read",
                diagnostics: [],
            },
        ],
        assetTargetCapabilities: [],
        materializerCapabilities: [],
        renderContractDeclarations: [],
        dialectContracts: {
            native: [],
            restoration: [],
            portableEntries: [],
            portableSelectors: [],
        },
        sourceRead: {
            registry: {
                Guidance: reader,
                Rule: sourceUnavailable("deferred", "test.rule", "Rule deferred"),
                Workflow: reader,
                Skill: reader,
                Subagent: reader,
                Memory: sourceUnavailable("unsupported", "test.memory", "Memory unsupported"),
            },
            resolveContext: () => null,
            scan: async () => {
                throw new Error("empty read must not scan");
            },
            diagnostics: {
                unknownAuthority: diagnostic,
                capabilityNotCallable: diagnostic,
                readerUnavailable: diagnostic,
                contextUnresolved: diagnostic,
                rootWithoutObligation: diagnostic,
            },
        },
        async probe() {
            return { status: "empty", observation: null, diagnostics: [] };
        },
        targetRender: { consumers: [], materializers: [] },
    };
}

describe("adapter-framework final Provider construction", () => {
    it("creates the fixed read handler, freezes static authority, and authenticates exact identities only", async () => {
        const provider = defineAdapterProvider(definition());

        expect(isAdapterFrameworkProvider(provider)).toBe(true);
        expect(isAdapterFrameworkReadHandler(provider.read)).toBe(true);
        expect(isAdapterFrameworkTargetHandler(provider.analyzeRender)).toBe(true);
        expect(isAdapterFrameworkTargetHandler(provider.materializeRender)).toBe(true);
        expect(isAdapterFrameworkTargetHandler(provider.inspectRenderedTarget)).toBe(true);
        expect(Object.isFrozen(provider)).toBe(true);
        expect(Object.isFrozen(provider.agentRuntimes)).toBe(true);
        expect(Object.isFrozen(provider.assetSourceCapabilities[0])).toBe(true);
        expect(Object.isFrozen(provider.dialectContracts)).toBe(true);
        expect(Object.isFrozen(provider.dialectContracts.native)).toBe(true);

        const read = await provider.read({
            target: {
                sourceSelector: {
                    selectorKind: "probe_roots",
                    sourceRootIds: ["root"],
                    observation: {
                        sourceRoots: [
                            {
                                sourceRootId: "root",
                                rootRole: "source",
                                sourceDomain: "family_shared",
                                path: "/root",
                            },
                        ],
                    },
                },
            },
            sourceReadObligations: [
                {
                    sourceReadObligationId: "obligation",
                    sourceRootId: "root",
                    sourceCapabilityFingerprint: `sha256:${"0".repeat(64)}`,
                },
            ],
        } as never);
        expect(read).toMatchObject({
            candidates: [],
            sourceParseReports: [
                {
                    sourceRootId: "root",
                    status: "malformed_source",
                    sourceReadObligationIds: ["obligation"],
                },
            ],
            diagnostics: [{ code: "test.unused" }],
        });
        await expect(
            provider.read({
                target: {
                    sourceSelector: {
                        selectorKind: "probe_roots",
                        sourceRootIds: [],
                        observation: { sourceRoots: [] },
                    },
                },
                sourceReadObligations: [],
            } as never),
        ).resolves.toEqual({
            candidates: [],
            sourceParseReports: [],
            diagnostics: [],
        });

        const copy = { ...provider };
        const wrapper = { ...provider, read: (input: Parameters<AdapterProvider["read"]>[0]) => provider.read(input) };
        expect(isAdapterFrameworkProvider(copy)).toBe(false);
        expect(isAdapterFrameworkProvider(wrapper)).toBe(false);
        expect(isAdapterFrameworkReadHandler(copy.read)).toBe(true);
        expect(isAdapterFrameworkReadHandler(wrapper.read)).toBe(false);
        expect(isAdapterFrameworkProvider(null)).toBe(false);
        expect(isAdapterFrameworkReadHandler("read")).toBe(false);

        defineAdapterProvider(definition());
        expect(isAdapterFrameworkProvider(copy)).toBe(false);
    });

    it("rejects a caller-owned read handler and an incomplete registry", () => {
        expect(() =>
            defineAdapterProvider({
                ...definition(),
                read: async () => ({ candidates: [], sourceParseReports: [], diagnostics: [] }),
            } as never),
        ).toThrow("adapter framework owns the final Provider read handler");

        const incomplete = definition();
        delete (incomplete.sourceRead.registry as Record<string, unknown>).Memory;
        expect(() => defineAdapterProvider(incomplete)).toThrow("asset reader registry must answer every AssetKind exactly once");
    });
});
