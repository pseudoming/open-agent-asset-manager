import type { AssetVersionFileContentV2 } from "../contracts/asset-version";
import type { AssetKindTypeDataV2 } from "../contracts/specs";
import type { AssetKind, AssetScope, UuidV4, VersionStatus } from "../contracts/primitives";
import { guidanceSpecHandler } from "./guidance";
import { memorySpecHandler } from "./memory";
import { ruleSpecHandler } from "./rule";
import { skillSpecHandler } from "./skill";
import { subagentSpecHandler } from "./subagent";
import { workflowSpecHandler } from "./workflow";

export const BUILTIN_ASSET_KINDS = [
    "Guidance",
    "Rule",
    "Workflow",
    "Skill",
    "Subagent",
    "Memory",
] as const satisfies readonly AssetKind[];

export interface SpecDependencyRequirement {
    targetAssetVersionId: UuidV4;
    expectedTarget: "any_complete_version" | "Subagent" | "Skill" | "MemoryUnit";
    scopeRequirement: "none" | "same_asset_scope";
    source: string;
}

export interface AssetSpecVersionNode {
    versionId: UuidV4;
    scope: AssetScope;
    projectId: string;
    scopePath: string;
    status: VersionStatus;
    canonical: unknown;
    files: AssetVersionFileContentV2[];
}

export interface AssetSpecValidationIssue {
    code: string;
    path: string;
}

export interface AssetSpecValidationResult {
    valid: boolean;
    issues: AssetSpecValidationIssue[];
}

export interface AssetSpecHandler {
    readonly kind: AssetKind;
    isCanonicalPair(value: unknown): boolean;
    completeEntryRule(canonical: AssetKindTypeDataV2): "one_text" | "zero";
    validateEntryText(text: string): boolean;
    validateFiles(canonical: AssetKindTypeDataV2, files: AssetVersionFileContentV2[]): AssetSpecValidationIssue[];
    collectDependencies(canonical: AssetKindTypeDataV2, files: AssetVersionFileContentV2[]): SpecDependencyRequirement[];
    searchProjection(canonical: AssetKindTypeDataV2, files: AssetVersionFileContentV2[]): string[];
}

export interface AssetSpecRegistry {
    list(): readonly AssetSpecHandler[];
    get(kind: AssetKind): AssetSpecHandler;
}

function createRegistry(handlers: readonly AssetSpecHandler[]): AssetSpecRegistry {
    const byKind = new Map<AssetKind, AssetSpecHandler>();
    for (const handler of handlers) {
        if (byKind.has(handler.kind)) {
            throw new Error(`duplicate AssetSpec handler: ${handler.kind}`);
        }
        byKind.set(handler.kind, Object.freeze(handler));
    }
    for (const kind of BUILTIN_ASSET_KINDS) {
        if (!byKind.has(kind)) throw new Error(`missing AssetSpec handler: ${kind}`);
    }
    if (byKind.size !== BUILTIN_ASSET_KINDS.length) {
        throw new Error("AssetSpec registry contains a foreign kind");
    }
    const frozenHandlers = Object.freeze(BUILTIN_ASSET_KINDS.map((kind) => byKind.get(kind) as AssetSpecHandler));
    return Object.freeze({
        list: () => frozenHandlers,
        get: (kind: AssetKind) => {
            const handler = byKind.get(kind);
            if (handler === undefined) throw new Error(`unknown AssetKind: ${kind}`);
            return handler;
        },
    });
}

const BUILTIN_REGISTRY = createRegistry([
    guidanceSpecHandler,
    ruleSpecHandler,
    workflowSpecHandler,
    skillSpecHandler,
    subagentSpecHandler,
    memorySpecHandler,
]);

export function listAssetSpecHandlers(): readonly AssetSpecHandler[] {
    return BUILTIN_REGISTRY.list();
}

export function getAssetSpecHandler(kind: AssetKind): AssetSpecHandler {
    return BUILTIN_REGISTRY.get(kind);
}

/** Test-only construction seam for completeness/duplicate guards. */
export function createAssetSpecRegistryForTest(handlers: readonly AssetSpecHandler[]): AssetSpecRegistry {
    return createRegistry(handlers);
}

function sameScope(left: AssetSpecVersionNode, right: AssetSpecVersionNode): boolean {
    return left.scope === right.scope && left.projectId === right.projectId && left.scopePath === right.scopePath;
}

function dependencyMatches(requirement: SpecDependencyRequirement, target: AssetSpecVersionNode): boolean {
    if (target.status !== "complete") return false;
    if (requirement.expectedTarget === "any_complete_version") return true;
    if (
        !getAssetSpecHandler(requirement.expectedTarget === "MemoryUnit" ? "Memory" : requirement.expectedTarget).isCanonicalPair(
            target.canonical,
        )
    ) {
        return false;
    }
    if (requirement.expectedTarget !== "MemoryUnit") return true;
    const canonical = target.canonical as AssetKindTypeDataV2;
    return canonical.kind === "Memory" && canonical.typeData.entityRole === "unit";
}

function detectCycle(edges: ReadonlyMap<UuidV4, readonly UuidV4[]>): UuidV4[] | null {
    const visiting = new Set<UuidV4>();
    const visited = new Set<UuidV4>();
    const stack: UuidV4[] = [];

    const visit = (versionId: UuidV4): UuidV4[] | null => {
        if (visiting.has(versionId)) {
            const cycleStart = stack.indexOf(versionId);
            return [...stack.slice(cycleStart), versionId];
        }
        if (visited.has(versionId)) return null;
        visiting.add(versionId);
        stack.push(versionId);
        for (const target of edges.get(versionId) ?? []) {
            const cycle = visit(target);
            if (cycle !== null) return cycle;
        }
        stack.pop();
        visiting.delete(versionId);
        visited.add(versionId);
        return null;
    };

    for (const versionId of edges.keys()) {
        const cycle = visit(versionId);
        if (cycle !== null) return cycle;
    }
    return null;
}

export function validateAssetSpecVersionGraph(nodes: readonly AssetSpecVersionNode[]): AssetSpecValidationResult {
    const issues: AssetSpecValidationIssue[] = [];
    const byVersion = new Map<UuidV4, AssetSpecVersionNode>();
    const edges = new Map<UuidV4, UuidV4[]>();

    for (const node of nodes) {
        if (byVersion.has(node.versionId)) {
            issues.push({ code: "duplicate_version", path: node.versionId });
        } else {
            byVersion.set(node.versionId, node);
        }
    }

    for (const node of nodes) {
        const canonical = node.canonical;
        if (
            typeof canonical !== "object" ||
            canonical === null ||
            !("kind" in canonical) ||
            !BUILTIN_ASSET_KINDS.includes((canonical as { kind: AssetKind }).kind)
        ) {
            issues.push({ code: "invalid_kind", path: node.versionId });
            continue;
        }
        const kind = (canonical as { kind: AssetKind }).kind;
        const handler = getAssetSpecHandler(kind);
        if (!handler.isCanonicalPair(canonical)) {
            issues.push({ code: "invalid_type_data", path: node.versionId });
            continue;
        }
        const typedCanonical = canonical as AssetKindTypeDataV2;

        const entryFiles = node.files.filter((file) => file.file.role === "entry");
        if (node.status === "complete") {
            issues.push(...handler.validateFiles(typedCanonical, node.files));
            const rule = handler.completeEntryRule(typedCanonical);
            if (rule === "zero" && entryFiles.length !== 0) {
                issues.push({ code: "unexpected_entry", path: node.versionId });
            }
            if (
                rule === "one_text" &&
                (entryFiles.length !== 1 ||
                    entryFiles[0]?.contentKind !== "text" ||
                    !handler.validateEntryText(entryFiles[0].text))
            ) {
                issues.push({ code: "invalid_entry", path: node.versionId });
            }
        }

        const logicalPaths = new Set<string>();
        for (const file of node.files) {
            if (logicalPaths.has(file.file.logicalPath)) {
                issues.push({ code: "duplicate_logical_path", path: file.file.logicalPath });
            }
            logicalPaths.add(file.file.logicalPath);
            if (file.contentKind !== file.file.contentKind) {
                issues.push({ code: "content_kind_mismatch", path: file.file.logicalPath });
            }
            for (const reference of file.file.references) {
                if (
                    reference.resolution === "resolved_version_file" &&
                    !logicalPaths.has(reference.targetLogicalPath) &&
                    !node.files.some((candidate) => candidate.file.logicalPath === reference.targetLogicalPath)
                ) {
                    issues.push({ code: "missing_version_file", path: file.file.logicalPath });
                }
                if (
                    node.status === "complete" &&
                    reference.required &&
                    (reference.resolution === "unresolved" ||
                        reference.resolution === "external" ||
                        reference.resolution === "forbidden")
                ) {
                    issues.push({
                        code: "required_reference_unresolved",
                        path: file.file.logicalPath,
                    });
                }
            }
        }

        const requirements = node.status === "complete" ? handler.collectDependencies(typedCanonical, node.files) : [];
        for (const file of node.files) {
            for (const reference of file.file.references) {
                if (node.status === "complete" && reference.resolution === "resolved_asset_version") {
                    requirements.push({
                        targetAssetVersionId: reference.targetAssetVersionId,
                        expectedTarget: "any_complete_version",
                        scopeRequirement: "none",
                        source: file.file.logicalPath,
                    });
                }
            }
        }
        edges.set(
            node.versionId,
            requirements.map((requirement) => requirement.targetAssetVersionId),
        );
        for (const requirement of requirements) {
            const target = byVersion.get(requirement.targetAssetVersionId);
            if (target === undefined) {
                issues.push({ code: "missing_dependency", path: requirement.source });
                continue;
            }
            if (!dependencyMatches(requirement, target)) {
                issues.push({ code: "wrong_dependency_kind", path: requirement.source });
            }
            if (requirement.scopeRequirement === "same_asset_scope" && !sameScope(node, target)) {
                issues.push({ code: "wrong_dependency_scope", path: requirement.source });
            }
        }
    }

    const cycle = detectCycle(edges);
    if (cycle !== null) {
        issues.push({ code: "dependency_cycle", path: cycle.join(" -> ") });
    }
    return { valid: issues.length === 0, issues };
}
