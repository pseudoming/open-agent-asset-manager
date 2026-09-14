/** OAAM Core public contract entry point. */
export type * from "./types";
export type { RestrictedProbeSession, RestrictedProbeRequest } from "./orchestration/restricted-probe-service";
export type { SelectedWslProbeExecution } from "./orchestration/selected-wsl-probe-execution";
export type {
    SelectedWslTargetExecution,
    SelectedWslTargetRequest,
    SelectedWslUsageTargetRequest,
} from "./orchestration/selected-wsl-target-execution";
export type { RestrictedTargetServiceConfiguration } from "./orchestration/restricted-target-service";
export type { DeploymentTargetExecution, AssetUsageTargetExecution } from "./orchestration/restricted-target-channel";
export type {
    RestrictedTargetBinding,
    RestrictedUsageTargetBinding,
    RestrictedTargetRequest,
    RestrictedTargetSession,
} from "./deployment/restricted-target-contract";
export { createCoreService, StateProfileRecoveryRequiredError } from "./orchestration/core-service";
export type { CoreServiceConfiguration } from "./orchestration/core-service";
export type { StateProfileRecoveryReason } from "./orchestration/core-service";
export { createStateRestoreService } from "./orchestration/state-restore-service";
export type {
    StateRestoreService,
    StateRestoreServiceConfiguration,
} from "./orchestration/state-restore-service";
export { reconcileStateRestoreBeforeStartup } from "./orchestration/state-restore-reconciliation";
export type {
    StateRestoreStartupConfiguration,
    StateRestoreStartupReconciliation,
} from "./orchestration/state-restore-reconciliation";
export { createAdapterAssetSourceCapability } from "./adapters/adapter-source-capability";
export type { AdapterAssetSourceCapabilityInput } from "./adapters/adapter-source-capability";
export { inferCanonicalMediaType } from "./foundation/media-type";
export {
    jsoncDiffIsOneTopLevelPropertyValue,
    readJsoncTopLevelPropertyValue,
    replaceJsoncTopLevelPropertyValue,
} from "./foundation/jsonc-top-level-property";
export type { JsoncTopLevelPropertyValue } from "./foundation/jsonc-top-level-property";
export { BUILTIN_ASSET_KINDS } from "./specs/registry";
export {
    createNativeGlobalGuidanceProviderSupport,
    createNativeProjectGuidanceProviderSupport,
    createVerifiedNativeGlobalGuidanceBuild,
    createVerifiedNativeProjectGuidanceBuild,
    resolveObservedNativeProjectGuidanceTargetContext,
} from "./render/native-project-guidance";
export type {
    ObservedNativeProjectGuidanceTargetContextResolution,
    ResolveObservedNativeProjectGuidanceTargetContextInput,
} from "./render/native-project-guidance";
export {
    createNativeGlobalRuleProviderSupport,
    createNativeProjectRuleProviderSupport,
    createVerifiedNativeGlobalRuleBuild,
    createVerifiedNativeProjectRuleBuild,
} from "./render/native-project-rule";
export type { NativeGlobalRuleProviderSupport, NativeProjectRuleProviderSupport } from "./render/native-project-rule";
export {
    createNativeProjectExactFileProviderSupport,
    createVerifiedNativeProjectExactFileBuild,
} from "./render/native-project-exact-file";
export type {
    NativeProjectExactFileComponent,
    NativeProjectExactFileProviderSupport,
} from "./render/native-project-exact-file";
export {
    createNativeGlobalExactGraphProviderSupport,
    createNativeProjectExactGraphProviderSupport,
    createVerifiedNativeGlobalExactGraphBuild,
    createVerifiedNativeProjectExactGraphBuild,
} from "./render/native-project-exact-graph";
export {
    createNativeGlobalEncodedFileProviderSupport,
    createVerifiedNativeGlobalEncodedFileBuild,
    createNativeProjectEncodedFileProviderSupport,
    createVerifiedNativeProjectEncodedFileBuild,
} from "./render/native-project-encoded-file";
export type {
    DecodedCanonicalSection,
    EncodedCanonicalSectionDescriptor,
    NativeGlobalEncodedFileProviderSupport,
    NativeProjectEncodedFileComponent,
    NativeProjectEncodedFileProviderSupport,
    NativeProjectEncodedFileRebaseInput,
    NativeProjectEncodedFileRebaseMaterializer,
} from "./render/native-project-encoded-file";
export type {
    NativeGlobalExactGraphComponent,
    NativeGlobalExactGraphProviderSupport,
    NativeProjectExactGraphComponent,
    NativeProjectExactGraphCanonicalMaterializationInput,
    NativeProjectExactGraphCanonicalMaterializer,
    NativeProjectExactGraphProviderSupport,
    NativeProjectExactGraphProjection,
    NativeProjectExactGraphRebaseInput,
    NativeProjectExactGraphRebaseMaterializer,
} from "./render/native-project-exact-graph";
export { rebindAdapterRenderAnalysisOptionFingerprints } from "./render/render-analysis-validator";
export { resolveTargetBuildCompatibility } from "./render/target-build-compatibility";
export type {
    CurrentTargetBuildIdentity,
    TargetBuildCompatibilityAnchor,
    TargetBuildCompatibilityResolution,
} from "./render/target-build-compatibility";
