import { ProtocolDiagnostics, useDesktopPresentation } from "../../presentation";
import { WorkbenchNotice } from "../../ui";
import type { AdapterProviderView } from "../discovery/presentation";
import { catalogCreationRuntimeLabel } from "./CatalogAssetUsageRelationships";
import { CatalogReasonTechnicalDetails } from "./CatalogDeploymentTechnicalDetails";
import { CatalogRenderDisposition } from "./CatalogRenderDisposition";
import type {
    DeploymentTargetView,
    RenderAnalysisView,
    RenderOptionSelection,
    RenderOptionView,
    RenderOutputUnitView,
    RenderReviewProjection,
    RenderSemanticView,
} from "./catalog-deployment-model";
import {
    presentClaudeExactFileDisposition,
    RENDER_DEGRADATION_MESSAGES,
    RENDER_REVERSE_MESSAGES,
    RENDER_SEMANTIC_MESSAGES,
} from "./render-review-presentation";

type ReadyRenderReview = Extract<RenderReviewProjection, { readonly status: "ready" }>;

export function catalogRenderGroupIsPassive(group: ReadyRenderReview["groups"][number]): boolean {
    const option = group.options[0]?.option;
    return (
        group.blocked === undefined &&
        group.options.length === 1 &&
        option?.outcome === "preserved" &&
        option.approvalState === "not_required" &&
        option.diagnostics.length === 0
    );
}

export function catalogRenderReviewIsPassiveSingleton(review: ReadyRenderReview): boolean {
    const firstGroup = review.groups[0];
    const firstOption = firstGroup?.options[0]?.option;
    if (firstGroup === undefined || firstOption === undefined) return false;
    const firstOutputs = firstGroup.options[0]?.outputUnits.map((unit) => unit.outputUnitFingerprint).sort() ?? [];
    return review.groups.every((group) => {
        const selected = group.options[0];
        const option = selected?.option;
        return (
            group.blocked === undefined &&
            group.options.length === 1 &&
            selected !== undefined &&
            selected.outputUnits.length > 0 &&
            selected.outputUnits.length === firstOutputs.length &&
            selected.outputUnits
                .map((unit) => unit.outputUnitFingerprint)
                .sort()
                .every((fingerprint, index) => fingerprint === firstOutputs[index]) &&
            option !== undefined &&
            option.outcome === "preserved" &&
            option.approvalState === "not_required" &&
            option.diagnostics.length === 0 &&
            option.renderStrategy === firstOption.renderStrategy &&
            option.actualReverseExtractPolicy === firstOption.actualReverseExtractPolicy &&
            group.semantic.consumerAgentRuntimeId === firstGroup.semantic.consumerAgentRuntimeId &&
            group.semantic.subject.assetId === firstGroup.semantic.subject.assetId &&
            group.semantic.subject.versionId === firstGroup.semantic.subject.versionId &&
            presentClaudeExactFileDisposition(group.semantic, { state: "option", option }) === undefined
        );
    });
}

export function CatalogRenderPassiveSingletonSummary({
    review,
    target,
    providers,
}: {
    readonly review: ReadyRenderReview;
    readonly target: DeploymentTargetView | undefined;
    readonly providers: readonly AdapterProviderView[];
}): React.JSX.Element | null {
    const { displayText, text } = useDesktopPresentation();
    if (!catalogRenderReviewIsPassiveSingleton(review)) return null;
    const firstGroup = review.groups[0];
    const firstOption = firstGroup?.options[0]?.option;
    if (firstGroup === undefined || firstOption === undefined) return null;
    const runtime = catalogCreationRuntimeLabel(target, firstGroup.semantic.consumerAgentRuntimeId, providers, {
        displayText,
        text,
    });
    return (
        <section className="render-passive-plan" data-oaam-render-passive-summary>
            <div className="render-passive-plan-policy">
                <small>{text("catalog.ui.render.runtime", { runtime })}</small>
                <span>
                    {text("catalog.ui.render.reverse_label", {
                        policy: text(RENDER_REVERSE_MESSAGES[firstOption.actualReverseExtractPolicy]),
                    })}
                </span>
            </div>
            <ul className="render-passive-semantics">
                {[...new Set(review.groups.map((group) => group.semantic.semanticKind))].map((semanticKind) => (
                    <li key={semanticKind} data-oaam-passive-semantic-kind={semanticKind}>
                        {text(RENDER_SEMANTIC_MESSAGES[semanticKind])}
                    </li>
                ))}
            </ul>
            {/* Preserve exact receipt metadata; only the visible summary above is presentation evidence. */}
            <div className="render-passive-contract-metadata" hidden>
                {review.groups.map((group) => {
                    const option = group.options[0]?.option;
                    if (option === undefined) return null;
                    return (
                        <fieldset
                            key={group.semantic.semanticRefFingerprint}
                            data-oaam-semantic-kind={group.semantic.semanticKind}
                        >
                            <article
                                className="preview-detail render-passive-option-metadata"
                                data-oaam-render-option-fingerprint={option.optionFingerprint}
                                data-oaam-render-outcome={option.outcome}
                                data-oaam-reverse-policy={option.actualReverseExtractPolicy}
                                data-oaam-semantic-ref-fingerprint={group.semantic.semanticRefFingerprint}
                                data-oaam-subject-version-id={group.semantic.subject.versionId}
                            >
                                <span data-oaam-render-option data-oaam-render-option-auto-selected="true" />
                            </article>
                        </fieldset>
                    );
                })}
            </div>
        </section>
    );
}

export function CatalogRenderOutputSummary({
    review,
    selections,
}: {
    readonly review: ReadyRenderReview;
    readonly selections: readonly RenderOptionSelection[];
}): React.JSX.Element | null {
    const { text } = useDesktopPresentation();
    const outputUnits = [
        ...new Map(
            review.groups.flatMap((group) => {
                const selected = selections.find(
                    (selection) => selection.semanticRefFingerprint === group.semantic.semanticRefFingerprint,
                );
                const option = group.options.find(
                    (candidate) => candidate.option.optionFingerprint === selected?.optionFingerprint,
                );
                return (option?.outputUnits ?? []).map((unit) => [unit.outputUnitFingerprint, unit] as const);
            }),
        ).values(),
    ];
    if (outputUnits.length === 0) return null;
    const claims = outputUnits.flatMap((unit) => unit.claims);
    const summarizeFiles = claims.length > 3;
    const directoryPaths = [...new Set(outputUnits.flatMap((unit) => unit.managedDirectoryPaths))];
    return (
        <section className="render-output-summary" data-oaam-render-output-summary>
            <h4>{text("catalog.ui.render.outputs_title")}</h4>
            {summarizeFiles ? (
                <p>
                    {text("catalog.ui.render.output_counts", {
                        count: claims.length,
                        text: claims.filter((claim) => claim.contentKind === "text").length,
                        binary: claims.filter((claim) => claim.contentKind === "binary").length,
                        executable: claims.filter((claim) => claim.executable).length,
                    })}
                </p>
            ) : null}
            {directoryPaths.length > 3 ? (
                <p>{text("catalog.ui.render.directory_count", { count: directoryPaths.length })}</p>
            ) : null}
            <ul className="render-output-paths">
                {outputUnits.flatMap((unit) => [
                    ...(summarizeFiles ? [] : unit.claims).map((claim) => (
                        <li key={`${unit.outputUnitFingerprint}:${claim.relativePath}`}>
                            {text(
                                claim.contentKind === "text"
                                    ? "catalog.ui.render.output_text"
                                    : "catalog.ui.render.output_binary",
                                {
                                    path: claim.relativePath,
                                    executable: claim.executable ? text("catalog.ui.render.executable_suffix") : "",
                                },
                            )}
                        </li>
                    )),
                ])}
                {(directoryPaths.length > 3 ? [] : directoryPaths).map((path) => (
                    <li key={`directory:${path}`}>{text("catalog.ui.render.managed_directory", { path })}</li>
                ))}
            </ul>
        </section>
    );
}

export function CatalogRenderSemanticHeader({
    semantic,
    assetName,
    target,
    providers,
    blocked,
    passive = false,
    wholeAsset = false,
}: {
    readonly semantic: RenderSemanticView;
    readonly assetName: string | undefined;
    readonly target: DeploymentTargetView | undefined;
    readonly providers: readonly AdapterProviderView[];
    readonly blocked: RenderAnalysisView["blockedSemantics"][number] | undefined;
    readonly passive?: boolean;
    readonly wholeAsset?: boolean;
}): React.JSX.Element {
    const { displayText, text } = useDesktopPresentation();
    const Heading = passive ? "h4" : "legend";
    return (
        <>
            <Heading>
                {assetName === undefined
                    ? text(RENDER_SEMANTIC_MESSAGES[semantic.semanticKind])
                    : wholeAsset
                      ? assetName
                      : text("catalog.ui.render.subject", {
                            asset: assetName,
                            semantic: text(RENDER_SEMANTIC_MESSAGES[semantic.semanticKind]),
                        })}
            </Heading>
            <small>
                {text("catalog.ui.render.runtime", {
                    runtime: catalogCreationRuntimeLabel(target, semantic.consumerAgentRuntimeId, providers, {
                        displayText,
                        text,
                    }),
                })}
            </small>
            {blocked === undefined ? null : (
                <WorkbenchNotice tone="danger" role="alert">
                    <CatalogRenderDisposition semantic={semantic} blocked={blocked} />
                    <ProtocolDiagnostics
                        embedded
                        diagnostics={blocked.diagnostics}
                        technicalSummary={text("import.ui.technical_details")}
                    />
                    <CatalogReasonTechnicalDetails
                        fact={<span>{text("catalog.ui.render.blocked")}</span>}
                        reason={blocked.reasonCode}
                    />
                </WorkbenchNotice>
            )}
        </>
    );
}

export function CatalogRenderOptionDetails({
    semantic,
    option,
    outputUnits,
}: {
    readonly semantic: RenderSemanticView;
    readonly option: RenderOptionView;
    readonly outputUnits: readonly RenderOutputUnitView[];
}): React.JSX.Element {
    const { text } = useDesktopPresentation();
    return (
        <>
            <CatalogRenderDisposition semantic={semantic} option={option} />
            {outputUnits.length === 0 ? <p>{text("catalog.ui.render.no_target_file")}</p> : null}
            <p>
                {text("catalog.ui.render.reverse_label", {
                    policy: text(RENDER_REVERSE_MESSAGES[option.actualReverseExtractPolicy]),
                })}
            </p>
            {option.outcome === "degraded" ? (
                <div>
                    <strong>{text("catalog.ui.render.degradations")}</strong>
                    <ul className="compact-list">
                        {option.degradationKinds.map((kind) => (
                            <li key={kind}>{text(RENDER_DEGRADATION_MESSAGES[kind])}</li>
                        ))}
                    </ul>
                </div>
            ) : null}
        </>
    );
}
