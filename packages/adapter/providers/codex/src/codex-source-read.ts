/** Codex hooks consumed by the adapter-framework-owned source-read handler. */

import type { AdapterFrameworkSourceReadDefinition } from "@oaam/adapter-framework";
import { sourceReadDiagnostic as diagnostic } from "@oaam/adapter-framework";
import type { AdapterProviderReadInput, SourceRoot } from "@oaam/core";
import type { AdapterAssetSourceCapability } from "@oaam/core";
import type { CodexScanResult, CodexSourceContext } from "./codex-source-read-model";
import { CODEX_ASSET_READER_REGISTRY } from "./codex-source-read-registry";
import { scanCodexReadObligation } from "./codex-source-read-scan";

export function resolveCodexSourceContext(
    input: AdapterProviderReadInput,
    root: SourceRoot,
    capability: AdapterAssetSourceCapability,
): CodexSourceContext | null {
    if (
        capability.assetKind !== "Guidance" &&
        capability.assetKind !== "Skill" &&
        capability.assetKind !== "Subagent" &&
        capability.assetKind !== "Workflow" &&
        capability.assetKind !== "Memory"
    ) {
        return null;
    }
    const selector = input.target.sourceSelector;
    if (selector.selectorKind === "user_selected_root") {
        if (capability.assetKind === "Memory" && selector.binding.assetScope !== "global") return null;
        return {
            root,
            scope: selector.binding.assetScope,
            projectRootPath: selector.binding.projectRootPath,
            layout:
                selector.binding.assetScope === "project"
                    ? "project"
                    : capability.assetKind === "Skill"
                      ? "skill_root"
                      : capability.assetKind === "Memory"
                        ? "memory"
                        : "config",
            fallbackConfigurationKnown: selector.binding.assetScope === "global",
            fallbackFilenames: [],
        };
    }
    if (capability.assetKind === "Skill" && root.rootRole === "source" && root.sourceDomain === "family_shared") {
        return {
            root,
            scope: "global",
            projectRootPath: "",
            layout: "skill_root",
            fallbackConfigurationKnown: true,
            fallbackFilenames: [],
        };
    }
    if (root.rootRole === "config" && root.sourceDomain === "family_shared") {
        return {
            root,
            scope: "global",
            projectRootPath: "",
            layout: capability.assetKind === "Memory" ? "memory" : "config",
            fallbackConfigurationKnown: true,
            fallbackFilenames: [],
        };
    }
    if (root.rootRole === "project_actual" && root.sourceDomain === "project_root" && capability.assetKind !== "Workflow") {
        return {
            root,
            scope: "project",
            projectRootPath: root.path,
            layout: "project",
            fallbackConfigurationKnown: probeProvesConfigAbsent(input),
            fallbackFilenames: [],
        };
    }
    return null;
}

function probeProvesConfigAbsent(input: AdapterProviderReadInput): boolean {
    const selector = input.target.sourceSelector;
    if (selector.selectorKind !== "probe_roots") return false;
    const configResources = selector.observation.agentRuntimeResources.filter((resource) =>
        resource.locatorEvidence.some((evidence) => evidence.locatorKey.endsWith(":config.toml")),
    );
    return configResources.length === 1 && configResources[0]?.accessStatus === "not_found";
}

export const CODEX_SOURCE_READ = {
    registry: CODEX_ASSET_READER_REGISTRY,
    resolveContext: resolveCodexSourceContext,
    scan: scanCodexReadObligation,
    diagnostics: {
        unknownAuthority: () =>
            diagnostic(
                "codex.read_authority_unknown",
                "Codex read obligation does not match a declared capability/root",
                "invalid_schema",
                "error",
            ),
        capabilityNotCallable: (root) =>
            diagnostic(
                "codex.source_capability_not_callable",
                "This Codex source capability is report-only or deferred",
                "unsupported",
                "error",
                root.path,
            ),
        readerUnavailable: (root, unavailable) =>
            diagnostic(unavailable.diagnosticCode, unavailable.message, "unsupported", "error", root.path),
        contextUnresolved: (root) =>
            diagnostic(
                "codex.source_scope_unresolved",
                "Cannot resolve scope/layout for the selected Codex source root and AssetKind",
                "invalid_schema",
                "error",
                root.path,
            ),
        rootWithoutObligation: (root) =>
            diagnostic(
                "codex.root_without_obligation",
                "Selected Codex root had no callable source capability",
                "unsupported",
                "error",
                root.path,
            ),
    },
} satisfies AdapterFrameworkSourceReadDefinition<CodexSourceContext, CodexScanResult>;

export { CODEX_NATIVE_DIALECTS } from "./codex-source-read-model";
export { validateCodexNativeDialect } from "./codex-source-read-native";
export { scanCodexReadObligation } from "./codex-source-read-scan";
