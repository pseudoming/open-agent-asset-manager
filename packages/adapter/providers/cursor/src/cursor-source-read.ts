/** Cursor hooks consumed by the Adapter Framework source coordinator. */

import { type AdapterFrameworkSourceReadDefinition, sourceReadDiagnostic as diagnostic } from "@oaam/adapter-framework";
import type { AdapterAssetSourceCapability, AdapterProviderReadInput, SourceRoot } from "@oaam/core";
import type { CursorScanResult, CursorSourceContext } from "./cursor-source-read-model";
import { CURSOR_ASSET_READER_REGISTRY } from "./cursor-source-read-registry";
import { scanCursorReadObligation } from "./cursor-source-read-scan";

export function resolveCursorSourceContext(
    input: AdapterProviderReadInput,
    root: SourceRoot,
    capability: AdapterAssetSourceCapability,
): CursorSourceContext | null {
    if (
        capability.assetKind !== "Guidance" &&
        capability.assetKind !== "Rule" &&
        capability.assetKind !== "Workflow" &&
        capability.assetKind !== "Skill" &&
        capability.assetKind !== "Subagent" &&
        capability.assetKind !== "Memory"
    ) {
        return null;
    }
    const ownsSharedPhysicalSource = sharedPhysicalSourceOwner(input) === capability.agentRuntimeId;
    const selector = input.target.sourceSelector;
    if (selector.selectorKind === "user_selected_root") {
        if (capability.assetKind === "Memory") {
            if (
                capability.agentRuntimeId !== "CURSOR_APP" ||
                root.rootRole !== "source" ||
                root.sourceDomain !== "external_managed" ||
                selector.binding.assetScope !== "project" ||
                selector.binding.projectRootPath === ""
            ) {
                return null;
            }
            return {
                root,
                scope: "project",
                projectRootPath: selector.binding.projectRootPath,
                layout: "memory_snapshot",
                agentRuntimeId: "CURSOR_APP",
                ownsSharedPhysicalSource: true,
            };
        }
        return {
            root,
            scope: selector.binding.assetScope,
            projectRootPath: selector.binding.projectRootPath,
            layout:
                capability.assetKind === "Skill"
                    ? "skill_root"
                    : capability.assetKind === "Subagent" && selector.binding.assetScope === "project"
                      ? "project"
                      : "external",
            agentRuntimeId: capability.agentRuntimeId,
            ownsSharedPhysicalSource,
        };
    }
    if (capability.assetKind === "Memory") return null;
    if (root.rootRole === "project_actual" && root.sourceDomain === "project_root") {
        return {
            root,
            scope: "project",
            projectRootPath: root.path,
            layout: "project",
            agentRuntimeId: capability.agentRuntimeId,
            ownsSharedPhysicalSource,
        };
    }
    if (
        (capability.assetKind === "Workflow" || capability.assetKind === "Skill") &&
        root.rootRole === "config" &&
        root.sourceDomain === "agent_runtime_private"
    ) {
        return {
            root,
            scope: "global",
            projectRootPath: "",
            layout: "config",
            agentRuntimeId: capability.agentRuntimeId,
            ownsSharedPhysicalSource,
        };
    }
    if (
        capability.assetKind === "Skill" &&
        root.rootRole === "source" &&
        (root.sourceDomain === "family_shared" || root.sourceDomain === "external_managed")
    ) {
        return {
            root,
            scope: "global",
            projectRootPath: "",
            layout: "skill_root",
            agentRuntimeId: capability.agentRuntimeId,
            ownsSharedPhysicalSource,
        };
    }
    return null;
}

function sharedPhysicalSourceOwner(input: AdapterProviderReadInput): "CURSOR_AGENT_CLI" | "CURSOR_APP" {
    const selector = input.target.sourceSelector;
    if (selector.selectorKind !== "probe_roots") return "CURSOR_AGENT_CLI";
    const status = new Map(
        selector.observation.observedAgentRuntimes.map((runtime) => [runtime.agentRuntimeId, runtime.installationStatus]),
    );
    if (status.get("CURSOR_AGENT_CLI") === "available") return "CURSOR_AGENT_CLI";
    return status.get("CURSOR_APP") === "available" ? "CURSOR_APP" : "CURSOR_AGENT_CLI";
}

export const CURSOR_SOURCE_READ = {
    registry: CURSOR_ASSET_READER_REGISTRY,
    resolveContext: resolveCursorSourceContext,
    scan: scanCursorReadObligation,
    candidateIdentityConflict: {
        identityKey: (candidate) =>
            candidate.kind === "Skill" || candidate.kind === "Subagent"
                ? JSON.stringify([candidate.kind, candidate.scope, candidate.projectRootPath, candidate.displayName])
                : null,
        diagnostic: (candidate) =>
            diagnostic(
                "cursor.skill_duplicate_identity",
                "Multiple selected Cursor Skill or Subagent roots declare the same name in one scope",
                "conflict",
                "error",
                candidate.displayName,
            ),
    },
    diagnostics: {
        unknownAuthority: () =>
            diagnostic(
                "cursor.read_authority_unknown",
                "Cursor read obligation does not match a declared capability/root",
                "invalid_schema",
                "error",
            ),
        capabilityNotCallable: (root) =>
            diagnostic(
                "cursor.source_capability_not_callable",
                "This Cursor source capability is report-only or deferred",
                "unsupported",
                "error",
                root.path,
            ),
        readerUnavailable: (root, unavailable) =>
            diagnostic(unavailable.diagnosticCode, unavailable.message, "unsupported", "error", root.path),
        contextUnresolved: (root) =>
            diagnostic(
                "cursor.source_scope_unresolved",
                "Cannot resolve scope/layout for the selected Cursor source root",
                "invalid_schema",
                "error",
                root.path,
            ),
        rootWithoutObligation: (root) =>
            diagnostic(
                "cursor.root_without_obligation",
                "Selected Cursor root had no callable source capability",
                "unsupported",
                "error",
                root.path,
            ),
    },
} satisfies AdapterFrameworkSourceReadDefinition<CursorSourceContext, CursorScanResult>;

export { CURSOR_NATIVE_DIALECTS } from "./cursor-source-read-model";
export { validateCursorNativeDialect } from "./cursor-source-read-native";
