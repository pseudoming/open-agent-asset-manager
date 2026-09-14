/** Stable current-exact project-file facade. */

export type {
    NativeProjectExactFileContractParts,
    NativeProjectExactFileProfileDefinition,
    VerifiedNativeProjectExactFileBuild,
} from "./native-project-exact-file-profiles";
export {
    createVerifiedNativeProjectExactFileBuild,
    findNativeProjectExactFileDeclaration,
    isNativeProjectExactFileAssetKind,
    makeNativeProjectExactFileContractParts,
} from "./native-project-exact-file-profiles";
export type {
    NativeProjectExactFileComponent,
    NativeProjectExactFileProviderSupport,
} from "./native-project-exact-file-behavior";
export type {
    NativeProjectExactFileRebaseInput,
    NativeProjectExactFileRebaseMaterializer,
} from "./native-project-exact-file-results";
export {
    createNativeProjectExactFileProviderSupport,
    nativeProjectExactFileRegistryComponents,
} from "./native-project-exact-file-behavior";
