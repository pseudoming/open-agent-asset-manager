/** Stable native project-Rule facade. */

export type {
    NativeProjectRuleProfileDefinition,
    NativeProjectRuleTargetDeclaration,
    VerifiedNativeProjectRuleBuild,
} from "./native-project-rule-profiles";
export {
    findNativeProjectRuleDeclaration,
    isNativeProjectRuleFileNameSuffix,
    isSafePortableRuleName,
    nativeProjectRuleNameFromRelativePath,
    nativeProjectRuleRelativePath,
} from "./native-project-rule-profiles";
export type { NativeGlobalRuleProviderSupport, NativeProjectRuleProviderSupport } from "./native-project-rule-support-types";
export {
    createNativeGlobalRuleProviderSupport,
    createNativeProjectRuleProviderSupport,
    createVerifiedNativeGlobalRuleBuild,
    createVerifiedNativeProjectRuleBuild,
    nativeProjectRuleRegistryComponents,
} from "./native-project-rule-behavior";
