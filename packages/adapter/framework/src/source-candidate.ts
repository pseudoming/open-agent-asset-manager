/** Runtime-neutral candidate, evidence, metadata, and read-diagnostic construction. */

import type {
    AssetScope,
    CandidateMetadataSourceOrigin,
    ExtractedAssetCandidateBase,
    OperationDiagnostic,
    SourceEvidence,
    SourceEvidenceLevel,
    VersionFileInput,
} from "@oaam/core";
import { inferCanonicalMediaType } from "@oaam/core/adapter-spi";
import { compareCodeUnitText } from "./source-text";

export interface SourceCandidateBaseInput {
    candidateId: string;
    sourceRootId: string;
    scope: AssetScope;
    projectRootPath: string;
    scopePath: string;
    displayName: string;
    dialectId: string;
    observedReadEntryId: string;
}

export function buildSourceCandidateBase(input: SourceCandidateBaseInput): ExtractedAssetCandidateBase {
    return {
        candidateId: input.candidateId,
        sourceRootIds: [input.sourceRootId],
        scope: input.scope,
        projectRootPath: input.projectRootPath,
        scopePath: input.scopePath,
        displayName: input.displayName,
        displayDescription: "",
        files: [],
        nativeRepresentation: {
            representationSource: "canonical_files",
            dialectId: input.dialectId,
        },
        dialectRestorationTransition: { action: "inherit" },
        status: "complete",
        assetCandidateStatus: "importable",
        promotionSafety: "default_promotable",
        sourceFileOrigins: [],
        sourceContainerEntryIds: [],
        metadataSourceOrigins: buildCandidateMetadataOrigins(input.observedReadEntryId, false),
        sourceEvidence: [],
        diagnostics: [],
    };
}

export function buildObservedReadEvidence(input: {
    observedReadEntryId: string;
    kind: Extract<SourceEvidence, { evidenceOrigin: "observed_read" }>["kind"];
    value: string;
    relativePath: string;
    evidenceLevel: SourceEvidenceLevel;
}): SourceEvidence[] {
    return [
        {
            evidenceOrigin: "observed_read",
            observedReadEntryId: input.observedReadEntryId,
            kind: input.kind,
            value: `${input.value}:${input.relativePath}`,
            evidenceLevel: input.evidenceLevel,
        },
    ];
}

export function buildCandidateMetadataOrigins(
    observedReadEntryId: string,
    includesDescription: boolean,
): CandidateMetadataSourceOrigin[] {
    return [
        ...(includesDescription
            ? [
                  {
                      metadataSubject: "display_description" as const,
                      observedReadEntryId,
                  },
              ]
            : []),
        { metadataSubject: "display_name" as const, observedReadEntryId },
        { metadataSubject: "type_data" as const, observedReadEntryId },
    ].sort((left, right) =>
        compareCodeUnitText(
            `${left.metadataSubject}\0${left.observedReadEntryId}`,
            `${right.metadataSubject}\0${right.observedReadEntryId}`,
        ),
    );
}

export function buildSourceTextEntry(logicalPath: string, text: string): VersionFileInput {
    return {
        logicalPath,
        role: "entry",
        contentKind: "text",
        mediaType: inferCanonicalMediaType(logicalPath, "text"),
        text,
        executable: false,
        references: [],
    };
}

export function sourceReadDiagnostic(
    code: string,
    message: string,
    causeKind: OperationDiagnostic["causeKind"],
    severity: OperationDiagnostic["severity"],
    path = "",
): OperationDiagnostic {
    return adapterOperationDiagnostic("read", code, message, causeKind, severity, path);
}

export function probeDiagnostic(
    code: string,
    message: string,
    causeKind: OperationDiagnostic["causeKind"],
    severity: OperationDiagnostic["severity"],
    path = "",
): OperationDiagnostic {
    return adapterOperationDiagnostic("probe", code, message, causeKind, severity, path);
}

export function adapterOperationDiagnostic(
    operation: OperationDiagnostic["operation"],
    code: string,
    message: string,
    causeKind: OperationDiagnostic["causeKind"],
    severity: OperationDiagnostic["severity"],
    path = "",
): OperationDiagnostic {
    return {
        severity,
        code,
        message,
        path,
        traceId: "",
        operation,
        causeKind,
        retryable: false,
        suggestedActions: severity === "error" ? ["skip"] : [],
        rawSummary: "",
    };
}
