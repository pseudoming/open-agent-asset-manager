/** Guidance, Rule, and Workflow candidate builders. */

import type { AdapterExtractedAssetCandidate, OperationDiagnostic, RuleTypeDataV2, WorkflowTypeDataV2 } from "@oaam/core";
import {
    antigravityFrontmatterString,
    antigravityFrontmatterStrings,
    parseAntigravityFrontmatter,
    type ParsedAntigravityFrontmatter,
} from "./antigravity-frontmatter";
import {
    basenamePath,
    candidateBase,
    candidateIdFor,
    frontmatterDiagnostics,
    frontmatterStringDiagnostics,
    isPortablePattern,
    metadataOrigins,
    nonBlank,
    parseAtReferences,
    parseWorkflowReferences,
    readDiagnostic,
    rejectNonUtf8Declaration,
    separateNative,
    sourceEvidence,
    textEntry,
    uniquePreservingOrder,
    unknownFieldDiagnostic,
    unknownKeys,
    withoutExtension,
} from "./antigravity-source-read-foundation";
import {
    ANTIGRAVITY_NATIVE_DIALECTS,
    type CandidateBuildResult,
    type ScanResult,
    type SourceContext,
} from "./antigravity-source-read-model";

const RULE_SIZE_LIMIT = 12_000;
const WORKFLOW_SIZE_LIMIT = 12_000;

export function buildGuidanceCandidates(context: SourceContext, scan: ScanResult): CandidateBuildResult {
    const candidates: AdapterExtractedAssetCandidate[] = [];
    const diagnostics: OperationDiagnostic[] = [];
    let ignoredSource = false;
    for (const file of scan.files) {
        if (file.text === null) {
            rejectNonUtf8Declaration(scan, file, "Guidance", diagnostics);
            ignoredSource = true;
            continue;
        }
        if (file.text.trim() === "") {
            scan.ignoreRecord(file, "empty_guidance_source");
            ignoredSource = true;
            continue;
        }
        const candidateId = candidateIdFor("Guidance", scan, file.relativePath);
        const displayName = basenamePath(file.relativePath);
        const candidate: AdapterExtractedAssetCandidate = {
            ...candidateBase(context, scan, candidateId, file.relativePath, file.observedReadEntryId),
            displayName,
            displayDescription:
                context.scope === "global" ? "Antigravity family-shared guidance" : "Antigravity project guidance",
            files: [
                {
                    ...textEntry("GUIDANCE.md", file.text),
                    references: parseAtReferences(file.text),
                },
            ],
            nativeRepresentation: separateNative(ANTIGRAVITY_NATIVE_DIALECTS.guidance, [file]),
            dialectRestorationTransition: { action: "inherit" },
            status: "complete",
            assetCandidateStatus: "importable",
            promotionSafety: "default_promotable",
            sourceFileOrigins: [
                {
                    logicalPath: "GUIDANCE.md",
                    observedReadEntryIds: [file.observedReadEntryId],
                },
            ],
            sourceContainerEntryIds: [],
            metadataSourceOrigins: metadataOrigins(file.observedReadEntryId, false),
            sourceEvidence: sourceEvidence(scan, file, "document", "antigravity_guidance"),
            diagnostics: [],
            kind: "Guidance",
            typeData: { schemaVersion: 1 },
        };
        scan.attachCandidate(candidateId, [file]);
        candidates.push(candidate);
    }
    return { candidates, diagnostics, ignoredSource };
}

export function buildRuleCandidates(context: SourceContext, scan: ScanResult): CandidateBuildResult {
    const candidates: AdapterExtractedAssetCandidate[] = [];
    const diagnostics: OperationDiagnostic[] = [];
    let ignoredSource = false;
    for (const file of scan.files) {
        if (file.text === null) {
            rejectNonUtf8Declaration(scan, file, "Rule", diagnostics);
            ignoredSource = true;
            continue;
        }
        const parsed = parseAntigravityFrontmatter(file.text);
        const candidateDiagnostics = [
            ...frontmatterDiagnostics(parsed, file.relativePath),
            ...frontmatterStringDiagnostics(parsed, ["name", "description", "trigger", "pattern"], "Rule", file.relativePath),
        ];
        const unknown = unknownKeys(parsed, ["name", "description", "trigger", "globs", "paths", "pattern"]);
        if (unknown.length > 0) {
            candidateDiagnostics.push(unknownFieldDiagnostic("Rule", unknown, file.relativePath));
        }
        const body = parsed.hasFrontmatter && parsed.closed ? parsed.body : file.text;
        if (body.trim() === "") {
            candidateDiagnostics.push(
                readDiagnostic(
                    "antigravity.rule_body_missing",
                    "Rule requires a non-empty Markdown body",
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            );
        }
        if (file.text.length > RULE_SIZE_LIMIT) {
            candidateDiagnostics.push(
                readDiagnostic(
                    "antigravity.rule_size_limit_exceeded",
                    "Rule exceeds the docs-declared 12,000 character limit",
                    "partial",
                    "warning",
                    file.relativePath,
                ),
            );
        }
        const activation = ruleActivation(parsed, candidateDiagnostics, file.relativePath);
        const name = nonBlank(antigravityFrontmatterString(parsed, "name")) ?? withoutExtension(basenamePath(file.relativePath));
        const description = antigravityFrontmatterString(parsed, "description") ?? "";
        if (activation.mode === "model_decision" && description.trim() === "") {
            candidateDiagnostics.push(
                readDiagnostic(
                    "antigravity.rule_model_description_missing",
                    "Model-decision Rule requires a non-empty description",
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            );
        }
        const typeData: RuleTypeDataV2 = {
            schemaVersion: 2,
            name,
            description,
            activation,
        };
        const complete = candidateDiagnostics.every((item) => item.severity !== "error");
        const candidateId = candidateIdFor("Rule", scan, file.relativePath);
        const candidate: AdapterExtractedAssetCandidate = {
            ...candidateBase(context, scan, candidateId, file.relativePath, file.observedReadEntryId),
            displayName: name,
            displayDescription: description,
            files: [{ ...textEntry("RULE.md", body), references: parseAtReferences(body) }],
            nativeRepresentation: separateNative(ANTIGRAVITY_NATIVE_DIALECTS.rule, [file]),
            dialectRestorationTransition: { action: "inherit" },
            status: complete ? "complete" : "incomplete",
            assetCandidateStatus: complete ? "importable" : "incomplete",
            promotionSafety: "default_promotable",
            sourceFileOrigins: [
                {
                    logicalPath: "RULE.md",
                    observedReadEntryIds: [file.observedReadEntryId],
                },
            ],
            sourceContainerEntryIds: [],
            metadataSourceOrigins: metadataOrigins(file.observedReadEntryId, parsed.hasFrontmatter),
            sourceEvidence: sourceEvidence(scan, file, parsed.hasFrontmatter ? "frontmatter" : "document", "antigravity_rule"),
            diagnostics: candidateDiagnostics,
            kind: "Rule",
            typeData,
        };
        scan.attachCandidate(candidateId, [file]);
        candidates.push(candidate);
    }
    return { candidates, diagnostics, ignoredSource };
}

export function buildWorkflowCandidates(context: SourceContext, scan: ScanResult): CandidateBuildResult {
    const candidates: AdapterExtractedAssetCandidate[] = [];
    const diagnostics: OperationDiagnostic[] = [];
    let ignoredSource = false;
    for (const file of scan.files) {
        if (file.text === null) {
            rejectNonUtf8Declaration(scan, file, "Workflow", diagnostics);
            ignoredSource = true;
            continue;
        }
        const parsed = parseAntigravityFrontmatter(file.text);
        const candidateDiagnostics = [
            ...frontmatterDiagnostics(parsed, file.relativePath),
            ...frontmatterStringDiagnostics(parsed, ["name", "description"], "Workflow", file.relativePath),
        ];
        const unknown = unknownKeys(parsed, ["description", "name"]);
        if (unknown.length > 0) {
            candidateDiagnostics.push(unknownFieldDiagnostic("Workflow", unknown, file.relativePath));
        }
        const name = nonBlank(antigravityFrontmatterString(parsed, "name")) ?? withoutExtension(basenamePath(file.relativePath));
        const description = nonBlank(antigravityFrontmatterString(parsed, "description"));
        const body = parsed.hasFrontmatter && parsed.closed ? parsed.body : file.text;
        if (description === undefined) {
            candidateDiagnostics.push(
                readDiagnostic(
                    "antigravity.workflow_description_missing",
                    "Workflow requires a description for portable command discovery",
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            );
        }
        if (body.trim() === "") {
            candidateDiagnostics.push(
                readDiagnostic(
                    "antigravity.workflow_body_missing",
                    "Workflow requires a non-empty instruction body",
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            );
        }
        if (file.text.length > WORKFLOW_SIZE_LIMIT) {
            candidateDiagnostics.push(
                readDiagnostic(
                    "antigravity.workflow_size_limit_exceeded",
                    "Workflow exceeds the docs-declared 12,000 character limit",
                    "partial",
                    "warning",
                    file.relativePath,
                ),
            );
        }
        const typeData: WorkflowTypeDataV2 = {
            schemaVersion: 2,
            name,
            description: description ?? "",
            implementation: {
                kind: "instructions",
                instructionDialectId: "antigravity-workflow-markdown-v1",
                execution: {
                    mode: "caller",
                    agent: { mode: "agent_runtime_default" },
                    model: { mode: "inherit" },
                    effort: { mode: "inherit" },
                    shell: { mode: "none" },
                },
                toolPolicy: {
                    preapproved: [],
                    denied: [],
                    otherwise: "inherit_agent_runtime_policy",
                },
            },
            invocation: {
                commandNames: [name],
                userInvocable: true,
                agentInvocable: true,
                argumentHint: "",
                argumentNames: [],
            },
        };
        const complete = candidateDiagnostics.every((item) => item.severity !== "error");
        const candidateId = candidateIdFor("Workflow", scan, file.relativePath);
        const candidate: AdapterExtractedAssetCandidate = {
            ...candidateBase(context, scan, candidateId, file.relativePath, file.observedReadEntryId),
            displayName: name,
            displayDescription: description ?? "",
            files: [
                {
                    ...textEntry("WORKFLOW.md", body),
                    references: parseWorkflowReferences(body),
                },
            ],
            nativeRepresentation: separateNative(ANTIGRAVITY_NATIVE_DIALECTS.workflow, [file]),
            dialectRestorationTransition: { action: "inherit" },
            status: complete ? "complete" : "incomplete",
            assetCandidateStatus: complete ? "importable" : "incomplete",
            promotionSafety: "default_promotable",
            sourceFileOrigins: [
                {
                    logicalPath: "WORKFLOW.md",
                    observedReadEntryIds: [file.observedReadEntryId],
                },
            ],
            sourceContainerEntryIds: [],
            metadataSourceOrigins: metadataOrigins(file.observedReadEntryId, parsed.hasFrontmatter),
            sourceEvidence: sourceEvidence(
                scan,
                file,
                parsed.hasFrontmatter ? "frontmatter" : "document",
                "antigravity_workflow",
            ),
            diagnostics: candidateDiagnostics,
            kind: "Workflow",
            typeData,
            workflowExecutionAgentBindingInput: { bindingInputKind: "none" },
        };
        scan.attachCandidate(candidateId, [file]);
        candidates.push(candidate);
    }
    return { candidates, diagnostics, ignoredSource };
}

function ruleActivation(
    parsed: ParsedAntigravityFrontmatter,
    diagnostics: OperationDiagnostic[],
    path: string,
): RuleTypeDataV2["activation"] {
    const raw = nonBlank(antigravityFrontmatterString(parsed, "trigger"));
    if (raw === "always_on" || raw === "always") return { mode: "always" };
    if (raw === "manual") {
        diagnostics.push(unverifiedActivationDiagnostic(raw, path));
        return { mode: "manual" };
    }
    if (raw === "model_decision" || raw === "model") {
        diagnostics.push(unverifiedActivationDiagnostic(raw, path));
        return { mode: "model_decision" };
    }
    if (raw === "glob" || raw === "path") {
        const globs = uniquePreservingOrder([
            ...(antigravityFrontmatterStrings(parsed, "globs") ?? []),
            ...(antigravityFrontmatterStrings(parsed, "paths") ?? []),
            ...(nonBlank(antigravityFrontmatterString(parsed, "pattern")) === undefined
                ? []
                : [nonBlank(antigravityFrontmatterString(parsed, "pattern")) as string]),
        ]);
        if (globs.length === 0 || globs.some((glob) => !isPortablePattern(glob))) {
            diagnostics.push(
                readDiagnostic(
                    "antigravity.rule_glob_invalid",
                    "Glob/path Rule requires at least one canonical relative pattern",
                    "invalid_schema",
                    "error",
                    path,
                ),
            );
            return { mode: "manual" };
        }
        diagnostics.push(unverifiedActivationDiagnostic(raw, path));
        return { mode: "path", globs };
    }
    diagnostics.push(
        readDiagnostic(
            raw === undefined ? "antigravity.rule_trigger_missing" : "antigravity.rule_trigger_unknown",
            raw === undefined
                ? "Rule trigger is absent; OAAM retained the source as incomplete instead of guessing always-on"
                : `Rule trigger ${raw} is not a verified Antigravity encoding`,
            "invalid_schema",
            "error",
            path,
        ),
    );
    return { mode: "manual" };
}

function unverifiedActivationDiagnostic(trigger: string, path: string): OperationDiagnostic {
    return readDiagnostic(
        "antigravity.rule_trigger_schema_unverified",
        `Rule trigger ${trigger} is docs-declared but lacks an exact runtime-written fixture`,
        "invalid_schema",
        "error",
        path,
    );
}
