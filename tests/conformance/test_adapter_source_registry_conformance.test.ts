/** Cross-family source-reader registry extension gate. */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
    isAdapterFrameworkProvider,
    isAdapterFrameworkReadHandler,
    isAdapterFrameworkTargetHandler,
} from "@oaam/adapter-framework";
import type { AdapterAssetTargetCapability, AssetKind } from "@oaam/core";
import { inspectAdapterExtensionContract } from "./adapter-extension-contract";
import { ASSET_KINDS, BUILTIN_ADAPTER_CONFORMANCE_CASES } from "./adapter-conformance-fixtures";

const ROOT_DIR = path.resolve(__dirname, "../..");

type ReaderDisposition = Readonly<{
    disposition: "reader";
    buildCandidates: (...args: never[]) => unknown;
}>;

type NonReaderDisposition = Readonly<{
    disposition: "unsupported" | "deferred";
    diagnosticCode: string;
    message: string;
}>;

describe("adapter source-reader registry extension contract", () => {
    it("passes the reusable public extension contract for every built-in family", () => {
        for (const { provider, sourceReaderRegistry } of BUILTIN_ADAPTER_CONFORMANCE_CASES) {
            expect(inspectAdapterExtensionContract({ provider, sourceReaderRegistry }), provider.adapterId).toEqual([]);
        }
    });

    it("accepts distinct supported target variants but rejects duplicate identities and unavailable mixtures", () => {
        const claude = BUILTIN_ADAPTER_CONFORMANCE_CASES.find(({ packageDirectory }) => packageDirectory === "claudecode");
        if (claude === undefined) throw new Error("Claude conformance fixture is missing");
        const workflowRows = claude.provider.assetTargetCapabilities.filter(
            (row) => row.agentRuntimeId === "CLAUDE_CODE_CLI" && row.assetKind === "Workflow",
        );
        expect(
            workflowRows
                .map((row) =>
                    "renderStrategy" in row ? `${row.renderStrategy}:${row.outputContractId}` : row.entrySupportStatus,
                )
                .sort(),
        ).toEqual(
            [
                "native_graph:CLAUDECODE_NATIVE_PROJECT_WORKFLOW_COMMAND_V1_CANONICAL_V1",
                "native_graph:CLAUDECODE_NATIVE_GLOBAL_JAVASCRIPT_WORKFLOW_GRAPH_V1",
                "native_graph:CLAUDECODE_NATIVE_GLOBAL_WORKFLOW_COMMAND_GRAPH_V1_CANONICAL_V1",
                "native_graph:CLAUDECODE_NATIVE_PROJECT_JAVASCRIPT_WORKFLOW_GRAPH_V1",
            ].sort(),
        );
        expect(inspectAdapterExtensionContract(claude)).toEqual([]);

        const duplicated = {
            ...claude.provider,
            assetTargetCapabilities: [...claude.provider.assetTargetCapabilities, structuredClone(workflowRows[0])],
        };
        expect(
            inspectAdapterExtensionContract({ provider: duplicated, sourceReaderRegistry: claude.sourceReaderRegistry }),
        ).toContain("CLAUDE_CODE_CLI/Workflow: target variant is duplicated");

        const unavailable: AdapterAssetTargetCapability = {
            agentRuntimeId: "CLAUDE_CODE_APP",
            assetKind: "Workflow",
            entrySupportStatus: "deferred",
            diagnostics: [
                {
                    severity: "error",
                    code: "synthetic_target_deferred",
                    message: "synthetic target deferred",
                    path: "",
                    traceId: "",
                    operation: "render",
                    causeKind: "unsupported",
                    retryable: false,
                    suggestedActions: [],
                    rawSummary: "",
                },
            ],
        };
        const mixed = {
            ...claude.provider,
            assetTargetCapabilities: [...claude.provider.assetTargetCapabilities, unavailable],
        };
        expect(inspectAdapterExtensionContract({ provider: mixed, sourceReaderRegistry: claude.sourceReaderRegistry })).toContain(
            "CLAUDE_CODE_APP/Workflow: unavailable target cell is not exclusive",
        );
    });

    it("keeps every family source module declarative and the fixed coordinator inside adapter-framework", () => {
        for (const { packageDirectory, provider } of BUILTIN_ADAPTER_CONFORMANCE_CASES) {
            const sourceReadPath = path.join(
                ROOT_DIR,
                "packages/adapter",
                "providers",
                packageDirectory,
                "src",
                `${packageDirectory}-source-read.ts`,
            );
            const source = fs.readFileSync(sourceReadPath, "utf8");
            expect(source, packageDirectory).toContain("_SOURCE_READ =");
            expect(source, packageDirectory).toContain("AdapterFrameworkSourceReadDefinition");
            expect(source, packageDirectory).not.toContain("coordinateSourceRead(");
            for (const copiedAuthority of [
                "REPORT_STATUS_PRIORITY",
                "sourceRootsFromTarget",
                "normalizeParseReport",
                "mergeReport",
                "new Map<string, ProviderSourceParseReport>",
            ]) {
                expect(source, `${packageDirectory}/${copiedAuthority}`).not.toContain(copiedAuthority);
            }

            const providerPath = path.join(
                ROOT_DIR,
                "packages/adapter",
                "providers",
                packageDirectory,
                "src",
                `${packageDirectory}-provider.ts`,
            );
            const providerSource = fs.readFileSync(providerPath, "utf8");
            expect(providerSource, packageDirectory).toContain("defineAdapterProvider({");
            const extractedTarget =
                packageDirectory === "opencode"
                    ? {
                          invocation: "...createOpencodeTargetDefinition(PROVIDER_VERSION, 2)",
                          retainedVersions: ["0.9.0", "0.10.0"],
                      }
                    : packageDirectory === "codex"
                      ? { invocation: "...createCodexTargetDefinition(PROVIDER_VERSION)", retainedVersions: ["0.17.0", "0.18.0"] }
                      : packageDirectory === "cursor"
                        ? { invocation: '...createCursorTargetDefinition("0.2.0")', retainedVersions: ["0.1.0"] }
                        : undefined;
            const targetSource = extractedTarget
                ? fs.readFileSync(path.join(path.dirname(providerPath), `${packageDirectory}-target-definition.ts`), "utf8")
                : providerSource;
            if (extractedTarget) {
                expect(providerSource).toContain(`from "./${packageDirectory}-target-definition"`);
                expect(providerSource).toContain(extractedTarget.invocation);
                expect(targetSource).toContain("AdapterFrameworkTargetDefinition");
                expect(targetSource).toContain("createTargetCoordinator(");
                expect(targetSource).not.toMatch(/async\s+(?:analyzeRender|materializeRender|inspectRenderedTarget)\s*\(/u);
                const retained = provider.retainedInspectionBindings;
                expect(retained?.map((binding) => binding.rendererVersion)).toEqual(extractedTarget.retainedVersions);
                expect(targetSource).toContain("const { inspectRenderedTarget } = createTargetCoordinator({");
            }
            expect(targetSource, packageDirectory).toContain("targetRender:");
            expect(providerSource, packageDirectory).not.toMatch(/async\s+read\s*\(/u);
            expect(providerSource, packageDirectory).not.toMatch(
                /async\s+(?:analyzeRender|materializeRender|inspectRenderedTarget)\s*\(/u,
            );
            expect(isAdapterFrameworkProvider(provider), packageDirectory).toBe(true);
            expect(isAdapterFrameworkReadHandler(provider.read), packageDirectory).toBe(true);
            expect(isAdapterFrameworkTargetHandler(provider.analyzeRender), packageDirectory).toBe(true);
            expect(isAdapterFrameworkTargetHandler(provider.materializeRender), packageDirectory).toBe(true);
            expect(isAdapterFrameworkTargetHandler(provider.inspectRenderedTarget), packageDirectory).toBe(true);
            expect(Object.isFrozen(provider), packageDirectory).toBe(true);
        }
    });

    it("routes every family scanner through the fixed bounded traversal authority", () => {
        for (const { packageDirectory, sourceReaderRegistry } of BUILTIN_ADAPTER_CONFORMANCE_CASES) {
            if (!hasCallableReader(sourceReaderRegistry)) continue;
            const scanPath = path.join(
                ROOT_DIR,
                "packages/adapter",
                "providers",
                packageDirectory,
                "src",
                `${packageDirectory}-source-read-scan.ts`,
            );
            const source = fs.readFileSync(scanPath, "utf8");
            expect(source, packageDirectory).toContain("traverseSourceRead(");
            for (const copiedMechanic of [
                "MAX_DISCOVERED_ENTRIES",
                "dispositionByHandle",
                "input.readAccess.listDirectory",
                "input.readAccess.readFile",
            ]) {
                expect(source, `${packageDirectory}/${copiedMechanic}`).not.toContain(copiedMechanic);
            }
        }
    });

    it("does not invent a scanner obligation for an exhaustive all-report-only registry", () => {
        const reportOnlyRegistry = Object.fromEntries(
            ASSET_KINDS.map((kind) => [
                kind,
                Object.freeze({
                    disposition: "deferred" as const,
                    diagnosticCode: `fixture.${kind.toLowerCase()}_deferred`,
                    message: `${kind} remains report-only`,
                }),
            ]),
        ) as Readonly<Record<AssetKind, NonReaderDisposition>>;
        const oneReaderRegistry = {
            ...reportOnlyRegistry,
            Guidance: Object.freeze({ disposition: "reader" as const, buildCandidates: () => undefined }),
        };

        expect(hasCallableReader(reportOnlyRegistry)).toBe(false);
        expect(hasCallableReader(oneReaderRegistry)).toBe(true);
    });

    it("covers every adapter workspace with one frozen exhaustive local registry", () => {
        const packageDirectories = fs
            .readdirSync(path.join(ROOT_DIR, "packages/adapter/providers"), { withFileTypes: true })
            .filter(
                (entry) =>
                    entry.isDirectory() &&
                    fs.existsSync(path.join(ROOT_DIR, "packages/adapter/providers", entry.name, "package.json")),
            )
            .map((entry) => entry.name)
            .sort();

        expect(BUILTIN_ADAPTER_CONFORMANCE_CASES.map(({ packageDirectory }) => packageDirectory).sort()).toEqual(
            packageDirectories,
        );

        for (const { packageDirectory, sourceReaderRegistry } of BUILTIN_ADAPTER_CONFORMANCE_CASES) {
            expect(Object.isFrozen(sourceReaderRegistry), packageDirectory).toBe(true);
            expect(Object.keys(sourceReaderRegistry).sort(), packageDirectory).toEqual([...ASSET_KINDS].sort());
            for (const kind of ASSET_KINDS) {
                expect(Object.isFrozen(sourceReaderRegistry[kind]), `${packageDirectory}/${kind}`).toBe(true);
            }
        }
    });

    it("routes every adapter workspace through the shared compile and coverage gates", () => {
        for (const { packageDirectory } of BUILTIN_ADAPTER_CONFORMANCE_CASES) {
            const packageRoot = path.join(ROOT_DIR, "packages/adapter/providers", packageDirectory);
            const tsconfig = JSON.parse(fs.readFileSync(path.join(packageRoot, "tsconfig.json"), "utf8")) as {
                readonly extends?: unknown;
            };
            expect(tsconfig.extends, packageDirectory).toBe("../../tsconfig.base.json");
            expect(fs.readFileSync(path.join(packageRoot, "vitest.config.ts"), "utf8").trim(), packageDirectory).toBe(
                'export { default } from "../../vitest.base";',
            );
        }
    });

    it("backs every callable source capability with a concrete reader", () => {
        for (const { provider, sourceReaderRegistry } of BUILTIN_ADAPTER_CONFORMANCE_CASES) {
            const callableKinds = new Set(
                provider.assetSourceCapabilities
                    .filter(
                        (capability) => capability.entrySupportStatus === "supported" && capability.readPolicy !== "report_only",
                    )
                    .map((capability) => capability.assetKind),
            );

            for (const kind of callableKinds) {
                const disposition = asDisposition(sourceReaderRegistry[kind]);
                expect(disposition.disposition, `${provider.adapterId}/${kind}`).toBe("reader");
                expect(typeof (disposition as ReaderDisposition).buildCandidates, `${provider.adapterId}/${kind}`).toBe(
                    "function",
                );
            }
        }
    });

    it("keeps unsupported and deferred entries typed, diagnostic, and non-callable", () => {
        for (const { provider, sourceReaderRegistry } of BUILTIN_ADAPTER_CONFORMANCE_CASES) {
            for (const kind of ASSET_KINDS) {
                const disposition = asDisposition(sourceReaderRegistry[kind]);
                if (disposition.disposition === "reader") {
                    expect(Object.keys(disposition).sort(), `${provider.adapterId}/${kind}`).toEqual([
                        "buildCandidates",
                        "disposition",
                    ]);
                    expect(disposition.buildCandidates).toBeTypeOf("function");
                    continue;
                }

                expect(Object.keys(disposition).sort(), `${provider.adapterId}/${kind}`).toEqual([
                    "diagnosticCode",
                    "disposition",
                    "message",
                ]);
                expect(disposition.diagnosticCode.trim().length).toBeGreaterThan(0);
                expect(disposition.message.trim().length).toBeGreaterThan(0);

                const capabilityRows = provider.assetSourceCapabilities.filter((capability) => capability.assetKind === kind);
                expect(capabilityRows.length, `${provider.adapterId}/${kind}`).toBeGreaterThan(0);
                expect(
                    capabilityRows.every(
                        (capability) =>
                            capability.entrySupportStatus !== "supported" &&
                            capability.readPolicy === "report_only" &&
                            capability.diagnostics.length > 0,
                    ),
                    `${provider.adapterId}/${kind}`,
                ).toBe(true);
            }
        }
    });
});

function asDisposition(value: unknown): ReaderDisposition | NonReaderDisposition {
    expect(value).toBeTypeOf("object");
    expect(value).not.toBeNull();
    const disposition = value as { readonly disposition?: unknown };
    expect(["reader", "unsupported", "deferred"]).toContain(disposition.disposition);
    return value as ReaderDisposition | NonReaderDisposition;
}

function hasCallableReader(registry: Readonly<Record<AssetKind, unknown>>): boolean {
    return ASSET_KINDS.some((kind) => asDisposition(registry[kind]).disposition === "reader");
}
