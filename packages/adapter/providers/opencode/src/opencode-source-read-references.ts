/** OpenCode command @-reference classification through Core read authority. */

import { posix as posixPath, win32 as win32Path } from "node:path";
import { hostPathApiFor } from "@oaam/adapter-framework";
import type {
    AdapterProviderReadInput,
    FileReferenceV2,
    OperationDiagnostic,
    Platform,
    ReadEntryHandle,
    SourceReadObligation,
} from "@oaam/core";
import { isCanonicalNativeRelativePath, parseOpenCodeAtReferenceTokens, readDiagnostic } from "./opencode-source-read-foundation";
import type { SourceContext, WorkflowReferenceClassification } from "./opencode-source-read-model";

export async function classifyOpenCodeAtReferences(
    input: AdapterProviderReadInput,
    obligation: SourceReadObligation,
    context: SourceContext,
    sourcePath: string,
    body: string,
): Promise<WorkflowReferenceClassification> {
    const references: FileReferenceV2[] = [];
    const diagnostics: OperationDiagnostic[] = [];
    const classificationHandles: ReadEntryHandle[] = [];
    for (const rawTarget of parseOpenCodeAtReferenceTokens(body)) {
        const target = projectRelativeRuntimeTarget(context, rawTarget);
        if (target.state === "root") {
            references.push({
                kind: "include",
                rawTarget,
                required: false,
                diagnostics: [],
                resolution: "unresolved",
            });
            continue;
        }
        if (target.state === "external") {
            references.push({
                kind: "include",
                rawTarget,
                required: false,
                diagnostics: [],
                resolution: "external",
            });
            continue;
        }
        if (target.state === "unavailable") {
            const item = readDiagnostic(
                "opencode.workflow_reference_context_unavailable",
                "OpenCode command @ references require an exact project root to distinguish file-first from agent-second resolution",
                "invalid_schema",
                "error",
                sourcePath,
            );
            references.push({
                kind: "include",
                rawTarget,
                required: true,
                diagnostics: [item],
                resolution: "unresolved",
            });
            diagnostics.push(item);
            continue;
        }
        const resolved = await input.readAccess.resolveEntry(
            obligation.sourceReadObligationId,
            obligation.sourceRootId,
            target.relativePath,
        );
        if (resolved.state === "succeeded") {
            classificationHandles.push(resolved.value);
            references.push({
                kind: "include",
                rawTarget,
                required: false,
                diagnostics: [],
                resolution: "unresolved",
            });
            continue;
        }
        if (resolved.failureStatus === "not_found") {
            references.push({
                kind: "execute",
                rawTarget,
                required: true,
                diagnostics: [],
                resolution: "unresolved",
            });
            continue;
        }
        const item = readDiagnostic(
            "opencode.workflow_reference_resolution_failed",
            "OpenCode command @ reference could not be classified without guessing past Core read authority",
            resolved.failureStatus === "permission_denied" ? "permission_denied" : "partial",
            "error",
            sourcePath,
        );
        references.push({
            kind: "include",
            rawTarget,
            required: true,
            diagnostics: [item],
            resolution: "unresolved",
        });
        diagnostics.push(item, ...resolved.diagnostics);
    }
    return { references, diagnostics, classificationHandles };
}

function projectRelativeRuntimeTarget(
    context: SourceContext,
    rawTarget: string,
): { state: "relative"; relativePath: string } | { state: "root" } | { state: "external" } | { state: "unavailable" } {
    const canResolveAgainstSelectedRoot =
        (context.layout === "project" || context.layout === "external") &&
        context.scope === "project" &&
        context.projectRootPath !== "" &&
        context.root.path === context.projectRootPath;
    if (!canResolveAgainstSelectedRoot) {
        return isRuntimeAbsoluteReference(rawTarget, context.platform) ? { state: "external" } : { state: "unavailable" };
    }
    if (rawTarget.startsWith("~/")) return { state: "external" };
    const paths = hostPathApiFor(context.root.path);
    if (paths === null) return { state: "unavailable" };
    const resolved = paths.resolve(context.root.path, rawTarget);
    const relative = paths.relative(context.root.path, resolved);
    if (relative === "") return { state: "root" };
    if (paths.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${paths.sep}`)) {
        return { state: "external" };
    }
    const portable = paths === win32Path ? relative.split("\\").join("/") : relative;
    return isCanonicalNativeRelativePath(portable) ? { state: "relative", relativePath: portable } : { state: "unavailable" };
}

function isRuntimeAbsoluteReference(rawTarget: string, platform: Platform): boolean {
    if (rawTarget.startsWith("~/")) return true;
    return (platform === "win32" ? win32Path : posixPath).isAbsolute(rawTarget);
}
