/** Claude-private composition of scope and native target variants. */

import { adapterOperationDiagnostic as diagnostic } from "@oaam/adapter-framework";
import type { AdapterRenderAnalysisResult, RenderAnalysisInput } from "@oaam/core";
import { CLAUDECODE_NATIVE_DIALECTS } from "./claudecode-source-read-model";

type AnalysisSupport = {
    analyze(value: RenderAnalysisInput): AdapterRenderAnalysisResult | Promise<AdapterRenderAnalysisResult>;
};

export async function analyzeScopeVariant(
    input: RenderAnalysisInput,
    projectSupport: AnalysisSupport,
    globalSupport: AnalysisSupport,
    label: "guidance" | "skill" | "subagent",
): Promise<AdapterRenderAnalysisResult> {
    const results: AdapterRenderAnalysisResult[] = [];
    for (const scope of ["project", "global"] as const) {
        const keys = new Set(
            input.deployment.assets.filter((asset) => asset.scope === scope).map((asset) => versionKey(asset.version.ref)),
        );
        const semantics = input.requiredSemantics.filter((semantic) => keys.has(versionKey(semantic.subject)));
        if (semantics.length === 0) continue;
        results.push(
            await (scope === "project" ? projectSupport : globalSupport).analyze({
                schemaVersion: 1,
                deployment: {
                    ...input.deployment,
                    assets: input.deployment.assets.filter((asset) => keys.has(versionKey(asset.version.ref))),
                },
                requiredSemantics: semantics,
                dialectInputs: input.dialectInputs.filter((entry) => keys.has(versionKey(entry.targetVersion))),
            }),
        );
    }
    return mergeVariantAnalysis(input, results, label);
}

export async function analyzeClaudeCodeRuleTargets(
    input: RenderAnalysisInput,
    supports: {
        projectExact: AnalysisSupport;
        projectCanonical: AnalysisSupport;
        globalExact: AnalysisSupport;
        globalCanonical: AnalysisSupport;
    },
): Promise<AdapterRenderAnalysisResult> {
    const results: AdapterRenderAnalysisResult[] = [];
    const assets = [...input.deployment.assets].sort((left, right) =>
        compareText(versionKey(left.version.ref), versionKey(right.version.ref)),
    );
    for (const asset of assets) {
        const key = versionKey(asset.version.ref);
        const semantics = input.requiredSemantics.filter((semantic) => versionKey(semantic.subject) === key);
        if (semantics.length === 0) continue;
        const dialectInputs = input.dialectInputs.filter((entry) => versionKey(entry.targetVersion) === key);
        const projected: RenderAnalysisInput = {
            schemaVersion: 1,
            deployment: { ...input.deployment, assets: [asset] },
            requiredSemantics: semantics,
            dialectInputs,
        };
        // A Claude-native lineage must pass its exact validator; canonical fallback would erase private syntax.
        const exact = asset.scope === "project" ? supports.projectExact : supports.globalExact;
        const canonical = asset.scope === "project" ? supports.projectCanonical : supports.globalCanonical;
        results.push(await (dialectInputs.length === 0 ? canonical.analyze(projected) : exact.analyze(projected)));
    }
    return mergeVariantAnalysis(input, results, "rule");
}

export async function analyzeClaudeCodeWorkflowTargets(
    input: RenderAnalysisInput,
    supports: {
        command: AnalysisSupport;
        projectCanonical?: AnalysisSupport;
        globalCanonical?: AnalysisSupport;
        globalCommand: AnalysisSupport;
        projectJavaScript: AnalysisSupport;
        globalJavaScript?: AnalysisSupport;
    },
): Promise<AdapterRenderAnalysisResult> {
    const globalJavaScriptSupport = supports.globalJavaScript;
    const groups: ReadonlyArray<{
        dialectId: string;
        scope: "project" | "global";
        canonical?: true;
        analyze: AnalysisSupport["analyze"];
    }> = [
        ...(["project", "global"] as const).flatMap((scope) => {
            const support = scope === "project" ? supports.projectCanonical : supports.globalCanonical;
            return support === undefined
                ? []
                : [
                      {
                          dialectId: CLAUDECODE_NATIVE_DIALECTS.commandWorkflow,
                          scope,
                          canonical: true as const,
                          analyze: (input: RenderAnalysisInput) => support.analyze(input),
                      },
                  ];
        }),
        {
            dialectId: CLAUDECODE_NATIVE_DIALECTS.commandWorkflow,
            scope: "project",
            analyze: (projected) => supports.command.analyze(projected),
        },
        {
            dialectId: CLAUDECODE_NATIVE_DIALECTS.commandWorkflow,
            scope: "global",
            analyze: (projected) => supports.globalCommand.analyze(projected),
        },
        {
            dialectId: CLAUDECODE_NATIVE_DIALECTS.javascriptWorkflow,
            scope: "project",
            analyze: (projected) => supports.projectJavaScript.analyze(projected),
        },
        ...(globalJavaScriptSupport === undefined
            ? []
            : [
                  {
                      dialectId: CLAUDECODE_NATIVE_DIALECTS.javascriptWorkflow,
                      scope: "global" as const,
                      analyze: (projected: RenderAnalysisInput) => globalJavaScriptSupport.analyze(projected),
                  },
              ]),
    ];
    const results: AdapterRenderAnalysisResult[] = [];
    const classified = new Set<string>();
    const assetByVersion = new Map(input.deployment.assets.map((asset) => [versionKey(asset.version.ref), asset]));
    for (const group of groups) {
        const keys = new Set(
            input.dialectInputs
                .filter(
                    (entry) =>
                        assetByVersion.get(versionKey(entry.targetVersion))?.scope === group.scope &&
                        entry.inputs.some((candidate) =>
                            group.canonical === true
                                ? candidate.inputKind === "canonical_materialization" &&
                                  candidate.nativeDialectId === group.dialectId
                                : candidate.inputKind === "native_representation" &&
                                  candidate.representation.dialectId === group.dialectId,
                        ),
                )
                .map((entry) => versionKey(entry.targetVersion)),
        );
        if (keys.size === 0) continue;
        for (const key of keys) classified.add(key);
        results.push(
            await group.analyze({
                schemaVersion: 1,
                deployment: {
                    ...input.deployment,
                    assets: input.deployment.assets.filter((asset) => keys.has(versionKey(asset.version.ref))),
                },
                requiredSemantics: input.requiredSemantics.filter((semantic) => keys.has(versionKey(semantic.subject))),
                dialectInputs: input.dialectInputs.filter((entry) => keys.has(versionKey(entry.targetVersion))),
            }),
        );
    }
    const unclassified = input.requiredSemantics.filter((semantic) => !classified.has(versionKey(semantic.subject)));
    if (unclassified.length > 0) {
        const unavailable = diagnostic(
            "render",
            "claudecode_workflow_native_variant_unavailable",
            "Claude Workflow requires a supported native lineage or one reviewed instruction conversion preserving its invocation and execution semantics",
            "unsupported",
            "error",
        );
        results.push({
            status: "failed",
            outputUnits: [],
            semanticOptions: [],
            blockedSemanticRefs: unclassified.map((semantic) => ({
                semanticRefFingerprint: semantic.semanticRefFingerprint,
                reasonCode: unavailable.code,
                diagnostics: [unavailable],
            })),
            diagnostics: [unavailable],
        });
    }
    return mergeVariantAnalysis(input, results, "workflow");
}

export async function analyzeClaudeCodeMemoryTargets(
    input: RenderAnalysisInput,
    unitSupport: AnalysisSupport,
    catalogSupport: AnalysisSupport,
): Promise<AdapterRenderAnalysisResult> {
    const assetsByVersion = new Map(input.deployment.assets.map((asset) => [versionKey(asset.version.ref), asset]));
    const unitKeys = new Set(
        input.deployment.assets
            .filter(
                (asset) => asset.version.canonical.kind === "Memory" && asset.version.canonical.typeData.entityRole === "unit",
            )
            .map((asset) => versionKey(asset.version.ref)),
    );
    const catalogKeys = new Set(
        input.deployment.assets
            .filter(
                (asset) => asset.version.canonical.kind === "Memory" && asset.version.canonical.typeData.entityRole === "catalog",
            )
            .map((asset) => versionKey(asset.version.ref)),
    );
    const results: AdapterRenderAnalysisResult[] = [];
    if (unitKeys.size > 0) {
        const { targetFileSnapshots: _catalogSnapshots, ...unitDeployment } = input.deployment;
        results.push(
            await unitSupport.analyze({
                schemaVersion: 1,
                deployment: {
                    ...unitDeployment,
                    assets: input.deployment.assets.filter((asset) => unitKeys.has(versionKey(asset.version.ref))),
                },
                requiredSemantics: input.requiredSemantics.filter((semantic) => unitKeys.has(versionKey(semantic.subject))),
                dialectInputs: input.dialectInputs.filter((entry) => unitKeys.has(versionKey(entry.targetVersion))),
            }),
        );
    }
    if (catalogKeys.size > 0) {
        const relatedKeys = new Set(catalogKeys);
        for (const key of catalogKeys) {
            const asset = assetsByVersion.get(key);
            if (asset?.version.canonical.kind !== "Memory" || asset.version.canonical.typeData.entityRole !== "catalog") {
                continue;
            }
            for (const member of asset.version.canonical.typeData.members) {
                const related = input.deployment.assets.find(
                    (candidate) => candidate.version.ref.versionId === member.targetAssetVersionId,
                );
                if (related !== undefined) relatedKeys.add(versionKey(related.version.ref));
            }
        }
        results.push(
            await catalogSupport.analyze({
                schemaVersion: 1,
                deployment: {
                    ...input.deployment,
                    assets: input.deployment.assets.filter((asset) => relatedKeys.has(versionKey(asset.version.ref))),
                },
                requiredSemantics: input.requiredSemantics.filter((semantic) => catalogKeys.has(versionKey(semantic.subject))),
                dialectInputs: input.dialectInputs.filter((entry) => relatedKeys.has(versionKey(entry.targetVersion))),
            }),
        );
    }
    const classified = new Set([...unitKeys, ...catalogKeys]);
    const unclassified = input.requiredSemantics.filter((semantic) => !classified.has(versionKey(semantic.subject)));
    if (unclassified.length > 0 || results.length === 0) {
        const unavailable = diagnostic(
            "render",
            "claudecode_memory_native_variant_unavailable",
            "Claude Memory target requires one exact Unit topic or Catalog native lineage",
            "unsupported",
            "error",
        );
        results.push({
            status: "failed",
            outputUnits: [],
            semanticOptions: [],
            blockedSemanticRefs: unclassified.map((semantic) => ({
                semanticRefFingerprint: semantic.semanticRefFingerprint,
                reasonCode: unavailable.code,
                diagnostics: [unavailable],
            })),
            diagnostics: [unavailable],
        });
    }
    return mergeVariantAnalysis(input, results, "memory");
}

function mergeVariantAnalysis(
    input: RenderAnalysisInput,
    results: readonly AdapterRenderAnalysisResult[],
    variant: "guidance" | "rule" | "workflow" | "skill" | "subagent" | "memory",
): AdapterRenderAnalysisResult {
    const outputUnits = results.flatMap((result) => result.outputUnits);
    const semanticOptions = results.flatMap((result) => result.semanticOptions);
    const blockedSemanticRefs = results.flatMap((result) => result.blockedSemanticRefs);
    const diagnostics = results.flatMap((result) => result.diagnostics);
    const expected = input.requiredSemantics.map((semantic) => semantic.semanticRefFingerprint).sort(compareText);
    const actual = [
        ...semanticOptions.map((option) => option.semanticRefFingerprint),
        ...blockedSemanticRefs.map((blocked) => blocked.semanticRefFingerprint),
    ].sort(compareText);
    if (
        expected.length !== actual.length ||
        expected.some((fingerprint, index) => fingerprint !== actual[index]) ||
        new Set(actual).size !== actual.length ||
        new Set(outputUnits.map((unit) => unit.outputUnitFingerprint)).size !== outputUnits.length
    ) {
        const invalid = diagnostic(
            "render",
            `claudecode_${variant}_variant_closure_invalid`,
            `Claude ${variant[0]?.toUpperCase() ?? ""}${variant.slice(1)} native target variants did not classify one exact semantic closure`,
            "conflict",
            "error",
        );
        return {
            status: "failed",
            outputUnits: [],
            semanticOptions: [],
            blockedSemanticRefs: input.requiredSemantics.map((semantic) => ({
                semanticRefFingerprint: semantic.semanticRefFingerprint,
                reasonCode: invalid.code,
                diagnostics: [invalid],
            })),
            diagnostics: [invalid],
        };
    }
    outputUnits.sort((left, right) => compareText(left.outputUnitFingerprint, right.outputUnitFingerprint));
    semanticOptions.sort((left, right) =>
        compareText(
            `${left.semanticRefFingerprint}\0${left.optionFingerprint}`,
            `${right.semanticRefFingerprint}\0${right.optionFingerprint}`,
        ),
    );
    blockedSemanticRefs.sort((left, right) => compareText(left.semanticRefFingerprint, right.semanticRefFingerprint));
    return {
        status: blockedSemanticRefs.length === 0 ? "complete" : semanticOptions.length === 0 ? "failed" : "partial",
        outputUnits,
        semanticOptions,
        blockedSemanticRefs,
        diagnostics,
    };
}

function versionKey(ref: { assetId: string; versionId: string }): string {
    return `${ref.assetId}\0${ref.versionId}`;
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
