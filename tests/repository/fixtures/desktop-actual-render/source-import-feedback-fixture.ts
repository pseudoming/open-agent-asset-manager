import {
    type ProtocolDiagnosticV1,
    type ProtocolOperationParams,
    protocolDiagnosticSchema,
    protocolWatchedScanIntentSchema,
} from "@oaam/app-server-protocol";
import type { DesktopApplicationClientApi } from "../../../../packages/client/desktop/src/renderer/client";

const DIGEST = "a".repeat(64);
const CANDIDATE_IDS = ["feedback-guidance", "feedback-skill"] as const;

function diagnostic(code: string, operation: ProtocolDiagnosticV1["operation"]): ProtocolDiagnosticV1 {
    return protocolDiagnosticSchema.parse({
        severity: "error",
        code,
        operation,
        causeKind: "internal_error",
        retryable: true,
        suggestedActions: ["retry"],
        message: "Controlled actual-render response failure.",
    });
}

async function awaitRelease(eventName: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const release = () => {
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(() => {
            window.removeEventListener(eventName, release);
            reject(new Error(`actual-render response was not released: ${eventName}`));
        }, 15_000);
        window.addEventListener(eventName, release, { once: true });
    });
}

export function createSourceImportFeedbackFixtureClient(
    enabled: boolean,
    watchedIntent: unknown,
): Readonly<Partial<DesktopApplicationClientApi>> {
    if (!enabled) return {};
    let acceptCount = 0;
    return {
        async getWatchedScanIntent() {
            if (document.documentElement.dataset.oaamFeedbackSourceRefresh === "hold") {
                document.documentElement.dataset.oaamFeedbackSourceRefresh = "pending";
                await awaitRelease("oaam-feedback-release-source");
                document.documentElement.dataset.oaamFeedbackSourceRefresh = "failed";
                return { status: "failed", diagnostics: [diagnostic("fixture.sources.failed", "settings")] };
            }
            return { status: "complete", value: protocolWatchedScanIntentSchema.parse(watchedIntent), diagnostics: [] };
        },
        async previewImport() {
            return {
                status: "partial",
                value: {
                    previewToken: "actual-render-feedback-preview",
                    snapshotFingerprint: DIGEST,
                    candidates: CANDIDATE_IDS.map((candidateId, index) => ({
                        candidateId,
                        kind: index === 0 ? "Guidance" : "Skill",
                        scope: "global",
                        displayName: index === 0 ? "Portable instructions" : "Review skill",
                        displayDescription: "",
                        status: "importable",
                        freshness: "fresh",
                        fileCount: 1,
                        logicalPaths: [index === 0 ? "AGENTS.md" : "SKILL.md"],
                        logicalPathsTruncated: false,
                        callableBindingRequestCount: 0,
                        callableBindingRequests: [],
                        callableBindingRequestsTruncated: false,
                    })),
                },
                diagnostics: [
                    ...[".agents/skills/managed", ".agents/skills/managed-workflow/SKILL.md"].map((path) =>
                        protocolDiagnosticSchema.parse({
                            severity: "info",
                            code: "read.managed_source_entry_ignored",
                            operation: "read",
                            causeKind: "conflict",
                            retryable: false,
                            suggestedActions: [],
                            path,
                            message: "The selected source entry is already managed by OAAM.",
                        }),
                    ),
                    protocolDiagnosticSchema.parse({
                        severity: "warning",
                        code: "codex.guidance_fallback_configuration_unknown",
                        operation: "read",
                        causeKind: "partial",
                        retryable: false,
                        suggestedActions: [],
                        message: "Custom project guidance filenames were not bound by this read.",
                    }),
                ],
            };
        },
        async acceptImportBatch(input: ProtocolOperationParams<"import.accept_batch">) {
            acceptCount += 1;
            document.documentElement.dataset.oaamFeedbackAcceptCount = String(acceptCount);
            document.documentElement.dataset.oaamFeedbackAcceptRequest = JSON.stringify(input);
            if (
                acceptCount > 2 ||
                input.previewToken !== "actual-render-feedback-preview" ||
                input.expectedSnapshotFingerprint !== DIGEST ||
                JSON.stringify(input.decisions.map((decision) => decision.candidateId).sort()) !==
                    JSON.stringify(CANDIDATE_IDS) ||
                input.decisions.some((decision) => decision.action !== "create_asset" || decision.callableBindings.length !== 0)
            ) {
                throw new Error("unexpected actual-render import request");
            }
            if (acceptCount === 1) {
                document.documentElement.dataset.oaamFeedbackAcceptStage = "pending";
                await awaitRelease("oaam-feedback-release-import");
                document.documentElement.dataset.oaamFeedbackAcceptStage = "failed";
                return { status: "failed", diagnostics: [diagnostic("fixture.import.failed", "version")] };
            }
            document.documentElement.dataset.oaamFeedbackAcceptStage = "partial";
            return {
                status: "partial",
                value: {
                    schemaVersion: 1,
                    items: [
                        {
                            status: "complete",
                            candidateId: CANDIDATE_IDS[0],
                            version: {
                                assetId: "22222222-2222-4222-8222-222222222222",
                                versionId: "33333333-3333-4333-8333-333333333333",
                            },
                            diagnostics: [],
                        },
                        {
                            status: "failed",
                            candidateId: CANDIDATE_IDS[1],
                            diagnostics: [diagnostic("fixture.import.item_failed", "version")],
                        },
                    ],
                },
                diagnostics: [],
            };
        },
    };
}
