/** Stable native project-Guidance facade. */

export type {
    NativeProjectGuidanceObservationDependenciesForTest,
    NativeGlobalGuidanceProviderSupport,
    NativeProjectGuidanceProfileDefinition,
    NativeProjectGuidanceProviderSupport,
    NativeProjectGuidanceTargetDeclaration,
    ObservedNativeProjectGuidanceTargetContextResolution,
    ResolveObservedNativeProjectGuidanceTargetContextInput,
    VerifiedNativeProjectGuidanceBuild,
    VerifiedNativeGlobalGuidanceBuild,
} from "./native-project-guidance-profiles";
export {
    createVerifiedNativeGlobalGuidanceBuild,
    createVerifiedNativeProjectGuidanceBuild,
} from "./native-project-guidance-profiles";
export {
    findVerifiedNativeProjectGuidanceBuildForTest,
    makeVerifiedNativeProjectGuidanceTargetContextForTest,
    resolveObservedNativeProjectGuidanceTargetContext,
    resolveObservedNativeProjectGuidanceTargetContextForTest,
    resolveObservedNativeProjectTargetContext,
    resolveObservedNativeProjectTargetContextForTest,
} from "./native-project-guidance-observation";
export {
    createNativeProjectGuidanceProviderSupport,
    createNativeGlobalGuidanceProviderSupport,
    nativeProjectGuidanceRegistryComponents,
    nativeProjectGuidanceRegistryComponentsForTest,
} from "./native-project-guidance-behavior";
