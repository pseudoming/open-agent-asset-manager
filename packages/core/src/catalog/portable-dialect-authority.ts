/** Portable semantic-dialect discovery, validation, and immutable Version binding. */

import type { AssetVersionFileContentV2 } from "../contracts/asset-version";
import type {
    PortableEntryDialectUseV1,
    PortableDialectSourceRuntimeV1,
    PortableSelectorDialectUseV1,
} from "../contracts/dialect";
import type { VersionPortableDialectContractRefV1 } from "../contracts/persistence";
import type { VersionStatus } from "../contracts/primitives";
import type { AssetKindTypeDataV2 } from "../contracts/specs";
import { stableStringify } from "../foundation/fingerprint";
import { compareUtf8Bytes } from "../foundation/text-order";
import type { VersionDialectRegistryV1 } from "./version-dialect-registry";

interface PortableDialectUsesV1 {
    entries: PortableEntryDialectUseV1[];
    selectors: PortableSelectorDialectUseV1[];
}

export function resolvePortableDialectContractRefs(
    canonical: AssetKindTypeDataV2,
    canonicalFiles: readonly AssetVersionFileContentV2[],
    versionStatus: VersionStatus,
    registry: VersionDialectRegistryV1,
    sourceRuntimes?: readonly PortableDialectSourceRuntimeV1[],
): VersionPortableDialectContractRefV1[] {
    const files = canonicalFiles.map(cloneFile);
    const uses = collectPortableDialectUses(canonical, files);
    const refs = new Map<string, VersionPortableDialectContractRefV1>();

    for (const use of uses.entries) {
        const contract = registry.getPortableEntry(use.kind, use.field, use.dialectId);
        if (
            contract === null ||
            !acceptsSourceRuntime(contract, sourceRuntimes) ||
            !contract.validateCanonicalEntry({
                use,
                versionStatus,
                canonical: structuredClone(canonical),
                canonicalFiles: files.map(cloneFile),
            })
        ) {
            throw new Error(`portable entry dialect contract rejected: ${use.field}/${use.dialectId}`);
        }
        addRef(refs, {
            field: use.field,
            dialectId: use.dialectId,
            dialectContractFingerprint: contract.contractFingerprint,
        });
    }

    for (const use of uses.selectors) {
        const contract = registry.getPortableSelector(use.kind, use.field, use.dialectId);
        if (contract === null || !acceptsSourceRuntime(contract, sourceRuntimes) || !contract.validateSelector(use)) {
            throw new Error(`portable selector dialect contract rejected: ${use.field}/${use.dialectId}`);
        }
        addRef(refs, {
            field: use.field,
            dialectId: use.dialectId,
            dialectContractFingerprint: contract.contractFingerprint,
        });
    }

    return [...refs.values()].sort((left, right) => compareUtf8Bytes(refKey(left), refKey(right)));
}

function acceptsSourceRuntime(
    contract: {
        applicableAgentRuntimeIds: readonly string[];
        validateSourceApplicability(source: PortableDialectSourceRuntimeV1): boolean;
    },
    sourceRuntimes: readonly PortableDialectSourceRuntimeV1[] | undefined,
): boolean {
    if (sourceRuntimes === undefined) return true;
    return sourceRuntimes.some(
        (source) =>
            contract.applicableAgentRuntimeIds.includes(source.agentRuntimeId) && contract.validateSourceApplicability(source),
    );
}

export function assertPortableDialectContractRefs(input: {
    canonical: AssetKindTypeDataV2;
    canonicalFiles: readonly AssetVersionFileContentV2[];
    versionStatus: VersionStatus;
    storedRefs: readonly VersionPortableDialectContractRefV1[];
    registry: VersionDialectRegistryV1;
}): void {
    const expected = resolvePortableDialectContractRefs(
        input.canonical,
        input.canonicalFiles,
        input.versionStatus,
        input.registry,
    );
    if (stableStringify(expected) !== stableStringify(input.storedRefs)) {
        throw new Error("portable dialect contract refs do not match canonical Version semantics");
    }
}

function collectPortableDialectUses(
    canonical: AssetKindTypeDataV2,
    files: readonly AssetVersionFileContentV2[],
): PortableDialectUsesV1 {
    const entries: PortableEntryDialectUseV1[] = [];
    const selectors: PortableSelectorDialectUseV1[] = [];
    const entryPath = files.find((file) => file.file.role === "entry")?.file.logicalPath ?? "";

    if (canonical.kind === "Workflow") {
        const implementation = canonical.typeData.implementation;
        entries.push({
            kind: "Workflow",
            field: implementation.kind === "instructions" ? "workflow_instruction" : "workflow_executable",
            dialectId:
                implementation.kind === "instructions" ? implementation.instructionDialectId : implementation.executableDialectId,
            logicalPath: entryPath,
        });
        if (implementation.kind === "instructions") {
            pushToolSelectors(selectors, "Workflow", "workflow_tool", [
                ...implementation.toolPolicy.preapproved,
                ...implementation.toolPolicy.denied,
            ]);
            pushTier(selectors, "Workflow", "workflow_model", implementation.execution.model);
            pushTier(selectors, "Workflow", "workflow_effort", implementation.execution.effort);
            if (implementation.execution.shell.mode === "selected") {
                selectors.push({
                    kind: "Workflow",
                    field: "workflow_shell",
                    dialectId: implementation.execution.shell.dialectId,
                    value: {
                        valueKind: "selector",
                        selector: implementation.execution.shell.selector,
                    },
                });
            }
        }
    } else if (canonical.kind === "Skill") {
        entries.push({
            kind: "Skill",
            field: "skill_entry",
            dialectId: canonical.typeData.entryDialectId,
            logicalPath: entryPath,
        });
        pushToolSelectors(selectors, "Skill", "skill_tool", [
            ...canonical.typeData.toolPolicy.preapproved,
            ...canonical.typeData.toolPolicy.denied,
        ]);
        if (
            canonical.typeData.execution.mode === "isolated" &&
            canonical.typeData.execution.agent.mode === "agent_runtime_named"
        ) {
            selectors.push({
                kind: "Skill",
                field: "skill_agent",
                dialectId: canonical.typeData.execution.agent.dialectId,
                value: {
                    valueKind: "selector",
                    selector: canonical.typeData.execution.agent.selector,
                },
            });
        }
        pushTier(selectors, "Skill", "skill_model", canonical.typeData.execution.model);
        pushTier(selectors, "Skill", "skill_effort", canonical.typeData.execution.effort);
    } else if (canonical.kind === "Subagent") {
        const typeData = canonical.typeData;
        if (typeData.promptContextPolicy.mode === "selected") {
            selectors.push({
                kind: "Subagent",
                field: "subagent_context",
                dialectId: typeData.promptContextPolicy.dialectId,
                value: {
                    valueKind: "selector_set",
                    selectors: [...typeData.promptContextPolicy.selectors],
                },
            });
        }
        const toolSelectors = [
            ...(typeData.tools.availability.base.mode === "allowlist" ? typeData.tools.availability.base.allowed : []),
            ...typeData.tools.availability.unavailable,
            ...typeData.tools.permission.rules.map((rule) => rule.selector),
        ].flatMap((selector) => (selector.mode === "agent_runtime_tool" ? [selector.selector] : []));
        pushToolSelectors(selectors, "Subagent", "subagent_tool", toolSelectors);
        if (typeData.execution.permission.mode === "selected") {
            selectors.push({
                kind: "Subagent",
                field: "subagent_permission",
                dialectId: typeData.execution.permission.dialectId,
                value: {
                    valueKind: "permission_effect",
                    selector: typeData.execution.permission.selector,
                    effect: typeData.execution.permission.effect,
                },
            });
        }
        pushTier(selectors, "Subagent", "subagent_model", typeData.execution.model);
        pushTier(selectors, "Subagent", "subagent_effort", typeData.execution.effort);
        if (typeData.execution.turnLimit.mode === "bounded") {
            selectors.push({
                kind: "Subagent",
                field: "subagent_turn_limit",
                dialectId: typeData.execution.turnLimit.dialectId,
                value: { valueKind: "positive_limit", limit: typeData.execution.turnLimit.limit },
            });
        }
        if (typeData.presentation.color.mode === "selected") {
            selectors.push({
                kind: "Subagent",
                field: "subagent_color",
                dialectId: typeData.presentation.color.dialectId,
                value: {
                    valueKind: "selector",
                    selector: typeData.presentation.color.selector,
                },
            });
        }
        if (typeData.directInvocation.mode === "user_selectable" && typeData.directInvocation.initialPrompt.mode === "resource") {
            entries.push({
                kind: "Subagent",
                field: "subagent_initial_prompt",
                dialectId: typeData.directInvocation.initialPrompt.dialectId,
                logicalPath: typeData.directInvocation.initialPrompt.logicalPath,
            });
        }
    }

    return { entries, selectors };
}

function pushToolSelectors(
    target: PortableSelectorDialectUseV1[],
    kind: "Workflow" | "Skill" | "Subagent",
    field: "workflow_tool" | "skill_tool" | "subagent_tool",
    values: readonly { dialectId: string; selector: string }[],
): void {
    for (const value of values) {
        target.push({
            kind,
            field,
            dialectId: value.dialectId,
            value: { valueKind: "selector", selector: value.selector },
        });
    }
}

function pushTier(
    target: PortableSelectorDialectUseV1[],
    kind: "Workflow" | "Skill" | "Subagent",
    field: "workflow_model" | "workflow_effort" | "skill_model" | "skill_effort" | "subagent_model" | "subagent_effort",
    value:
        | { mode: "inherit" }
        | {
              mode: "selected";
              dialectId: string;
              selector: string;
              relativeTier: -1 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
          },
): void {
    if (value.mode !== "selected") return;
    target.push({
        kind,
        field,
        dialectId: value.dialectId,
        value: {
            valueKind: "relative_tier",
            selector: value.selector,
            relativeTier: value.relativeTier,
        },
    });
}

function addRef(refs: Map<string, VersionPortableDialectContractRefV1>, ref: VersionPortableDialectContractRefV1): void {
    const key = refKey(ref);
    const existing = refs.get(key);
    if (existing !== undefined && existing.dialectContractFingerprint !== ref.dialectContractFingerprint) {
        throw new Error(`portable dialect contract fingerprint conflict: ${key}`);
    }
    refs.set(key, ref);
}

function refKey(ref: Pick<VersionPortableDialectContractRefV1, "field" | "dialectId">): string {
    return `${ref.field}\0${ref.dialectId}`;
}

function cloneFile(file: AssetVersionFileContentV2): AssetVersionFileContentV2 {
    return file.contentKind === "text" ? structuredClone(file) : { ...structuredClone(file), bytes: new Uint8Array(file.bytes) };
}
