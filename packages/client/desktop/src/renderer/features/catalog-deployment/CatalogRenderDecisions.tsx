/** One visible decision may approve equivalent semantics within the same reviewed asset graph. */
import { useDesktopPresentation } from "../../presentation";
import { WorkbenchConfirmation, WorkbenchRadioButton } from "../../ui";
import type { AdapterProviderView } from "../discovery/presentation";
import {
    CatalogRenderOptionDetails,
    CatalogRenderSemanticHeader,
    catalogRenderGroupIsPassive,
} from "./CatalogRenderReviewDetails";
import type {
    AssetSummaryView,
    DeploymentTargetView,
    RenderOptionSelection,
    RenderReviewProjection,
} from "./catalog-deployment-model";
import { RENDER_APPROVAL_MESSAGES, RENDER_STRATEGY_MESSAGES } from "./render-review-presentation";

type ReadyReview = Extract<RenderReviewProjection, { status: "ready" }>;
type Group = ReadyReview["groups"][number];
export function groupEquivalentRenderDecisions(review: ReadyReview): Group[][] {
    const groups: Group[][] = [],
        byIdentity = new Map<string, Group[]>();
    for (const group of review.groups) {
        const selected = group.options[0],
            option = selected?.option;
        if (
            group.blocked !== undefined ||
            group.options.length !== 1 ||
            selected === undefined ||
            option?.outcome !== "degraded" ||
            option.approvalState !== "required" ||
            selected.outputUnits.length === 0
        ) {
            groups.push([group]);
            continue;
        }
        const identity = JSON.stringify({
            assetId: group.semantic.subject.assetId,
            versionId: group.semantic.subject.versionId,
            consumerAgentRuntimeId: group.semantic.consumerAgentRuntimeId,
            outputUnits: selected.outputUnits,
            requiredOutputUnitFingerprints: option.requiredOutputUnitFingerprints,
            renderStrategy: option.renderStrategy,
            actualReverseExtractPolicy: option.actualReverseExtractPolicy,
            reasonCode: option.reasonCode,
            diagnostics: option.diagnostics,
            degradationKinds: option.degradationKinds,
            approvalConcerns: option.approvalConcerns,
        });
        const existing = byIdentity.get(identity);
        if (existing === undefined) {
            const members = [group];
            byIdentity.set(identity, members);
            groups.push(members);
        } else existing.push(group);
    }
    return groups;
}

export function CatalogRenderDecisions({
    review,
    assets,
    selections,
    target,
    providers,
    disabled,
    onChange,
    reverse = false,
}: {
    readonly review: ReadyReview;
    readonly assets: readonly AssetSummaryView[];
    readonly selections: readonly RenderOptionSelection[];
    readonly target: DeploymentTargetView | undefined;
    readonly providers: readonly AdapterProviderView[];
    readonly disabled: boolean;
    readonly reverse?: boolean;
    readonly onChange: (updates: readonly RenderOptionSelection[]) => void;
}): React.JSX.Element {
    const { text } = useDesktopPresentation();
    return (
        <>
            {groupEquivalentRenderDecisions(review).map((members) => {
                const group = members[0]!,
                    semantic = group.semantic,
                    semanticRefFingerprint = semantic.semanticRefFingerprint;
                const assetName = assets.find((asset) => asset.assetId === semantic.subject.assetId)?.displayName;
                const selected = selections.find((selection) => selection.semanticRefFingerprint === semanticRefFingerprint);
                const passive = catalogRenderGroupIsPassive(group),
                    Surface = passive ? "section" : "fieldset";
                return (
                    <Surface
                        key={semanticRefFingerprint}
                        data-oaam-semantic-kind={semantic.semanticKind}
                        data-oaam-render-decision-members={members.length}
                        className={
                            reverse
                                ? passive
                                    ? "reverse-semantic-review render-passive-group"
                                    : "reverse-semantic-review"
                                : passive
                                  ? "render-passive-group"
                                  : undefined
                        }
                    >
                        <CatalogRenderSemanticHeader
                            passive={passive}
                            wholeAsset={members.length > 1}
                            semantic={semantic}
                            assetName={assetName}
                            target={target}
                            providers={providers}
                            blocked={group.blocked}
                        />
                        {group.options.map(({ option, outputUnits }) => {
                            const selectedHere = selected?.optionFingerprint === option.optionFingerprint;
                            const approved = members.every((member) => {
                                const selection = selections.find(
                                    (item) => item.semanticRefFingerprint === member.semantic.semanticRefFingerprint,
                                );
                                const expected = members.length === 1 ? option : member.options[0]!.option;
                                return selection?.optionFingerprint === expected.optionFingerprint && selection.approved;
                            });
                            const update = (approved: boolean) =>
                                onChange(
                                    members.map((member) => ({
                                        semanticRefFingerprint: member.semantic.semanticRefFingerprint,
                                        optionFingerprint:
                                            members.length === 1
                                                ? option.optionFingerprint
                                                : member.options[0]!.option.optionFingerprint,
                                        approved,
                                    })),
                                );
                            return (
                                <article
                                    className={reverse ? "render-option" : "preview-detail"}
                                    key={option.optionFingerprint}
                                    data-oaam-render-option-fingerprint={option.optionFingerprint}
                                    data-oaam-render-outcome={option.outcome}
                                    data-oaam-reverse-policy={option.actualReverseExtractPolicy}
                                    data-oaam-semantic-ref-fingerprint={semanticRefFingerprint}
                                    data-oaam-subject-version-id={semantic.subject.versionId}
                                    data-oaam-render-option={group.options.length === 1 ? true : undefined}
                                    data-oaam-render-option-auto-selected={group.options.length === 1 ? "true" : undefined}
                                >
                                    {group.options.length === 1 ? (
                                        reverse ? (
                                            <strong data-oaam-reverse-option-auto-selected="true">
                                                {text(RENDER_STRATEGY_MESSAGES[option.renderStrategy])}
                                            </strong>
                                        ) : null
                                    ) : (
                                        <WorkbenchRadioButton
                                            data-oaam-interaction-entry={
                                                reverse
                                                    ? "features.catalog-deployment.catalog_reverse_review.004"
                                                    : "features.catalog-deployment.catalog_deployment_workspace.011"
                                            }
                                            data-oaam-reverse-option={reverse ? true : undefined}
                                            data-oaam-render-option
                                            checked={selectedHere}
                                            disabled={disabled}
                                            name={`${reverse ? "catalog-reverse" : "catalog-render"}-${semanticRefFingerprint}`}
                                            value={option.optionFingerprint}
                                            onCheckedChange={() => update(false)}
                                        >
                                            <strong>{text(RENDER_STRATEGY_MESSAGES[option.renderStrategy])}</strong>
                                        </WorkbenchRadioButton>
                                    )}
                                    <CatalogRenderOptionDetails semantic={semantic} option={option} outputUnits={outputUnits} />
                                    {option.approvalState !== "required" ? null : (
                                        <div>
                                            <ul className="compact-list">
                                                {option.approvalConcerns
                                                    .filter(
                                                        (concern) =>
                                                            !(
                                                                concern === "semantic_degradation" &&
                                                                option.outcome === "degraded"
                                                            ) &&
                                                            !(
                                                                concern === "reverse_extract_unsupported" &&
                                                                option.actualReverseExtractPolicy === "unsupported"
                                                            ),
                                                    )
                                                    .map((concern) => (
                                                        <li key={concern}>{text(RENDER_APPROVAL_MESSAGES[concern])}</li>
                                                    ))}
                                            </ul>
                                            {!selectedHere ? null : (
                                                <WorkbenchConfirmation
                                                    data-oaam-interaction-entry={
                                                        reverse
                                                            ? "features.catalog-deployment.catalog_reverse_review.005"
                                                            : "features.catalog-deployment.catalog_deployment_workspace.012"
                                                    }
                                                    checked={approved}
                                                    disabled={disabled}
                                                    onCheckedChange={update}
                                                >
                                                    {text("catalog.ui.render.approve_degraded")}
                                                </WorkbenchConfirmation>
                                            )}
                                        </div>
                                    )}
                                </article>
                            );
                        })}
                    </Surface>
                );
            })}
        </>
    );
}
