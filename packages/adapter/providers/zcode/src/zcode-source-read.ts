/** ZCode hooks consumed by the adapter-framework-owned source-read handler. */

import { sourceReadDiagnostic as diagnostic, type AdapterFrameworkSourceReadDefinition } from "@oaam/adapter-framework";
import type { AdapterAssetSourceCapability, AdapterProviderReadInput, SourceRoot } from "@oaam/core";
import type { ZcodeScanResult, ZcodeSourceContext } from "./zcode-source-read-model";
import { ZCODE_ASSET_READER_REGISTRY } from "./zcode-source-read-registry";
import { scanZcodeReadObligation } from "./zcode-source-read-scan";

export function resolveZcodeSourceContext(
    input: AdapterProviderReadInput,
    root: SourceRoot,
    capability: AdapterAssetSourceCapability,
): ZcodeSourceContext | null {
    if (!["Guidance", "Workflow", "Skill", "Subagent", "Memory"].includes(capability.assetKind)) return null;
    const selector = input.target.sourceSelector;
    if (selector.selectorKind === "user_selected_root") {
        return {
            root,
            scope: selector.binding.assetScope,
            projectRootPath: selector.binding.projectRootPath,
            layout:
                capability.assetKind === "Memory"
                    ? "memory"
                    : selector.binding.assetScope === "project" && selector.binding.projectRootPath === root.path
                      ? "project"
                      : "external",
        };
    }
    if (root.rootRole === "config" && root.sourceDomain === "agent_runtime_private") {
        return { root, scope: "global", projectRootPath: "", layout: "config" };
    }
    if (root.rootRole === "project_actual" && root.sourceDomain === "project_root") {
        return { root, scope: "project", projectRootPath: root.path, layout: "project" };
    }
    if (capability.assetKind === "Memory" && root.rootRole === "source" && root.sourceDomain === "project_keyed") {
        const projectRootPath = resolveObservedProjectRootPath(input, root);
        if (projectRootPath === null) return null;
        return {
            root,
            scope: "project",
            projectRootPath,
            layout: "memory",
        };
    }
    const sourceLayout = zcodeSourceRootLayout(root);
    if (sourceLayout === "skill_root") {
        const scope = resolveAssociatedScope(input, root);
        return scope === null ? null : { root, ...scope, layout: sourceLayout };
    }
    if (sourceLayout === "agent_root") {
        const scope = resolveAssociatedScope(input, root);
        return scope === null ? null : { root, ...scope, layout: sourceLayout };
    }
    if (sourceLayout === "command_root") {
        return { root, scope: "global", projectRootPath: "", layout: sourceLayout };
    }
    return null;
}

function zcodeSourceRootLayout(root: SourceRoot): "skill_root" | "command_root" | "agent_root" | null {
    if (root.rootRole !== "source") return null;
    const locatorKeys = new Set(root.locatorEvidence.map((evidence) => evidence.locatorKey));
    if (
        [
            "zcode_user_skill_root",
            "zcode_shared_skill_root",
            "zcode_project_skill_root",
            "zcode_project_shared_skill_root",
            "skills.roots",
        ].some((locatorKey) => locatorKeys.has(locatorKey))
    ) {
        return "skill_root";
    }
    if (locatorKeys.has("zcode_shared_command_root")) return "command_root";
    if (locatorKeys.has("zcode_default_storage_root") || locatorKeys.has("storage.dir")) return "agent_root";
    return null;
}

function resolveAssociatedScope(
    input: AdapterProviderReadInput,
    root: SourceRoot,
): { scope: "global" | "project"; projectRootPath: string } | null {
    const associated = root.locatorEvidence.some(
        (evidence) => evidence.locatorKind === "project_registry_entry" || evidence.locatorKind === "user_provided_path",
    );
    if (!associated) return { scope: "global", projectRootPath: "" };
    const projectRootPath = resolveObservedProjectRootPath(input, root);
    return projectRootPath === null ? null : { scope: "project", projectRootPath };
}

function resolveObservedProjectRootPath(input: AdapterProviderReadInput, memoryRoot: SourceRoot): string | null {
    const selector = input.target.sourceSelector;
    if (selector.selectorKind !== "probe_roots") return null;
    const projectLocator = memoryRoot.locatorEvidence.find(
        (evidence) => evidence.locatorKind === "project_registry_entry" || evidence.locatorKind === "user_provided_path",
    );
    if (projectLocator === undefined) return null;
    const projects = selector.observation.observedProjects.filter((project) =>
        project.evidence.some((evidence) =>
            projectLocator.locatorKind === "user_provided_path"
                ? projectLocator.locatorKey === "user_selection" && evidence.evidenceKind === "invocation"
                : evidence.locatorKey === projectLocator.locatorKey,
        ),
    );
    if (projects.length !== 1) return null;
    const primaryWorkspaces = projects[0]?.workspaces.filter((workspace) => workspace.role === "primary") ?? [];
    if (primaryWorkspaces.length !== 1) return null;
    const projectRoot = selector.observation.sourceRoots.find(
        (sourceRoot) => sourceRoot.sourceRootId === primaryWorkspaces[0]?.sourceRootId,
    );
    return projectRoot?.rootRole === "project_actual" && projectRoot.sourceDomain === "project_root" ? projectRoot.path : null;
}

export const ZCODE_SOURCE_READ = {
    registry: ZCODE_ASSET_READER_REGISTRY,
    resolveContext: resolveZcodeSourceContext,
    scan: scanZcodeReadObligation,
    candidateIdentityConflict: {
        identityKey: (candidate) =>
            candidate.kind === "Skill"
                ? JSON.stringify([candidate.kind, candidate.scope, candidate.projectRootPath, candidate.displayName])
                : null,
        diagnostic: (candidate) =>
            diagnostic(
                "zcode.skill_duplicate_identity",
                "Multiple selected ZCode Skill roots declare the same name in one scope",
                "conflict",
                "error",
                candidate.displayName,
            ),
    },
    diagnostics: {
        unknownAuthority: () =>
            diagnostic(
                "zcode.read_authority_unknown",
                "ZCode read obligation does not match a declared capability/root",
                "invalid_schema",
                "error",
            ),
        capabilityNotCallable: (root) =>
            diagnostic(
                "zcode.source_capability_not_callable",
                "This ZCode source capability is report-only or deferred",
                "unsupported",
                "error",
                root.path,
            ),
        readerUnavailable: (root, unavailable) =>
            diagnostic(unavailable.diagnosticCode, unavailable.message, "unsupported", "error", root.path),
        contextUnresolved: (root) =>
            diagnostic(
                "zcode.source_scope_unresolved",
                "Cannot resolve scope/layout for the selected ZCode source root",
                "invalid_schema",
                "error",
                root.path,
            ),
        rootWithoutObligation: (root) =>
            diagnostic(
                "zcode.root_without_obligation",
                "Selected ZCode root had no callable source capability",
                "unsupported",
                "error",
                root.path,
            ),
    },
} satisfies AdapterFrameworkSourceReadDefinition<ZcodeSourceContext, ZcodeScanResult>;

export { ZCODE_NATIVE_DIALECTS } from "./zcode-source-read-model";
export { validateZcodeNativeDialect } from "./zcode-source-read-native";
export { scanZcodeReadObligation } from "./zcode-source-read-scan";
