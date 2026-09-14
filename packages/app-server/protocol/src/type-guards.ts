import type { ProtocolRequestV1 } from "./messages";
import type { ProtocolOperationParams } from "./operations";

type IsExact<TLeft, TRight> =
    (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2
        ? (<T>() => T extends TRight ? 1 : 2) extends <T>() => T extends TLeft ? 1 : 2
            ? true
            : false
        : false;

type Assert<TValue extends true> = TValue;

type AssetGetParams = Readonly<{ assetId: string }>;
export type _AssetGetParamsRemainExact = Assert<IsExact<ProtocolOperationParams<"asset.get">, AssetGetParams>>;
export type _DeploymentCreateParamKeysRemainExact = Assert<
    IsExact<
        keyof ProtocolOperationParams<"deployment.create">,
        "probeToken" | "probeResultRowId" | "targetRowId" | "subject" | "consumerAgentRuntimeIds" | "assets"
    >
>;
export type _DeploymentCreateTargetIdentityRemainsTyped = Assert<
    IsExact<
        Pick<ProtocolOperationParams<"deployment.create">, "probeToken" | "probeResultRowId" | "targetRowId" | "subject">,
        Readonly<{
            probeToken: string;
            probeResultRowId: string;
            targetRowId: string;
            subject: Readonly<{ subjectKind: "global" }> | Readonly<{ subjectKind: "project"; projectId: string }>;
        }>
    >
>;
type WatchedScanReplaceParams = ProtocolOperationParams<"watched_scan_intent.replace">;
type WatchedScanDecision = WatchedScanReplaceParams["decisions"][number];
export type _WatchedScanReplaceKeysRemainExact = Assert<
    IsExact<keyof WatchedScanReplaceParams, "expectedRevision" | "expectedSettingFingerprint" | "decisions" | "userActionId">
>;
export type _WatchedScanDecisionActionsRemainExact = Assert<
    IsExact<
        WatchedScanDecision["action"],
        "retain_existing" | "include_observed" | "exclude_observed" | "include_user_selected_root"
    >
>;
export type _WatchedUserSelectedRootUsesLauncherToken = Assert<
    IsExact<
        keyof Extract<WatchedScanDecision, { readonly action: "include_user_selected_root" }>,
        "action" | "localPathSelectionToken" | "environment" | "adapterId" | "agentRuntimeIds" | "binding"
    >
>;
export type _RequestMethodAndParamsRemainCorrelated = Assert<
    IsExact<
        ProtocolRequestV1<"asset.get" | "project.get">,
        | { readonly id: string; readonly method: "asset.get"; readonly params: AssetGetParams }
        | { readonly id: string; readonly method: "project.get"; readonly params: Readonly<{ projectId: string }> }
    >
>;
