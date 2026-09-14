/** Existing Adapter contracts and implementations without App Server/State composition. */
export type * from "./index";
export { createAdapterAssetSourceCapability } from "./adapters/adapter-source-capability";
export { inferCanonicalMediaType } from "./foundation/media-type";
export { readJsoncTopLevelPropertyValue } from "./foundation/jsonc-top-level-property";
export { BUILTIN_ASSET_KINDS } from "./specs/registry";
export {
    createNativeGlobalGuidanceProviderSupport,
    createNativeProjectGuidanceProviderSupport,
    createVerifiedNativeGlobalGuidanceBuild,
    createVerifiedNativeProjectGuidanceBuild,
} from "./render/native-project-guidance";
export {
    createNativeGlobalRuleProviderSupport,
    createNativeProjectRuleProviderSupport,
    createVerifiedNativeGlobalRuleBuild,
    createVerifiedNativeProjectRuleBuild,
} from "./render/native-project-rule";
export {
    createNativeProjectExactFileProviderSupport,
    createVerifiedNativeProjectExactFileBuild,
} from "./render/native-project-exact-file";
export {
    createNativeGlobalExactGraphProviderSupport,
    createNativeProjectExactGraphProviderSupport,
    createVerifiedNativeGlobalExactGraphBuild,
    createVerifiedNativeProjectExactGraphBuild,
} from "./render/native-project-exact-graph";
export {
    createNativeGlobalEncodedFileProviderSupport,
    createNativeProjectEncodedFileProviderSupport,
    createVerifiedNativeGlobalEncodedFileBuild,
    createVerifiedNativeProjectEncodedFileBuild,
} from "./render/native-project-encoded-file";
export { rebindAdapterRenderAnalysisOptionFingerprints } from "./render/render-analysis-validator";
export { projectRenderDialectInputs } from "./render/render-dialect-scope";
export { resolveTargetBuildCompatibility } from "./render/target-build-compatibility";
