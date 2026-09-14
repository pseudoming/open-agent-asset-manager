/** Public adapter-framework composition surface. */

export {
    defineDialectComponentV1,
    defineNativeDialectContractV1,
    definePortableEntryDialectContractV1,
    definePortableSelectorDialectContractV1,
    hasCanonicalTextEntryV1,
} from "./dialect-contract";
export {
    canonicalHostPath,
    canonicalProviderHostPathWithinAccessRoot,
    hostAbsolutePathToRuntime,
    hostPathApiFor,
    isWindowsHostedWslContext,
    isWslUncHostPath,
    resolveProviderHostPathReference,
    resolveProviderProbeEnvironment,
    runtimeAbsolutePathToHost,
} from "./probe-paths";
export type { HostPathApi, ProviderProbeEnvironment } from "./probe-paths";
export {
    defineAdapterProvider,
    isAdapterFrameworkProvider,
    isAdapterFrameworkReadHandler,
    isAdapterFrameworkTargetHandler,
} from "./provider";
export type {
    AdapterFrameworkProviderDefinition,
    AdapterFrameworkSourceReadDefinition,
} from "./provider";
export {
    inspectProviderDirectoryNoFollow,
    inspectProviderRegularFileNoFollow,
    inventoryProviderDirectoryNoFollow,
    observeProviderDirectoryMembersBounded,
    readProviderRegularFileNoFollow,
    readProviderRegularFileRangeNoFollow,
    sameProviderPathIdentity,
    sameProviderRegularFileIdentity,
    snapshotProviderRegularFileNoFollow,
} from "./provider-probe-filesystem";
export type {
    ProviderDirectoryInventory,
    ProviderPathIdentity,
    ProviderRegularFileIdentity,
    ProviderRegularFileRead,
    ProviderRegularFileRangeRead,
    ProviderRegularFileSnapshot,
} from "./provider-probe-filesystem";
export {
    classifyProviderProcessObservationFailure,
    createProviderProbeDeadline,
    invokeProviderLocalExecutableTreeBounded,
    listProviderLocalProcessExecutableCandidateIdsBounded,
    listProviderLocalProcessIdsBounded,
    observeProviderLocalProcessBounded,
    observeProviderLocalProcessExecutableBounded,
    providerExecutableObservationFailureFromError,
    providerExecutableObservationFailureFromInvocation,
    providerExecutableObservationIdentityFailure,
    providerExecutableObservationMalformedOutput,
    remainingProviderProbeDeadlineMilliseconds,
    serializeProviderExecutableObservationFailure,
} from "./provider-probe-process";
export type {
    ProviderExecutableObservationFailure,
    ProviderExecutableObservationFailureReceipt,
    ProviderExecutableObservationInvocation,
    ProviderExecutableObservationOwnerCode,
    ProviderExecutableObservationStage,
    ProviderLocalExecutableTreeInvocationInput,
    ProviderLocalExecutableTreeInvocationResult,
    ProviderLocalProcessObservation,
    ProviderProbeDeadline,
    ProviderProcessObservationFailure,
    ProviderProcessObservationFailureDisposition,
} from "./provider-probe-process";
export {
    adapterOperationDiagnostic,
    buildCandidateMetadataOrigins,
    buildObservedReadEvidence,
    buildSourceCandidateBase,
    buildSourceTextEntry,
    probeDiagnostic,
    sourceReadDiagnostic,
} from "./source-candidate";
export type { SourceCandidateBaseInput } from "./source-candidate";
export { coordinateSourceRead } from "./source-coordinator";
export type {
    SourceCandidateIdentityConflictPolicy,
    SourceReadCoordinatorDiagnostics,
    SourceReadCoordinatorHooks,
} from "./source-coordinator";
export { buildSourceFileGraph } from "./source-file-graph";
export type { SourceFileGraphInput, SourceFileGraphResult } from "./source-file-graph";
export {
    boundedFrontmatterBoolean,
    boundedFrontmatterFiniteNumber,
    boundedFrontmatterScalarMap,
    boundedFrontmatterString,
    boundedFrontmatterStringList,
    boundedFrontmatterStringMap,
    parseBoundedFrontmatter,
    projectBoundedFrontmatterDiagnostics,
    splitBoundedDelimited,
} from "./source-frontmatter";
export type {
    BoundedFrontmatterScalar,
    BoundedFrontmatterSyntax,
    BoundedFrontmatterValue,
    ParsedBoundedFrontmatter,
} from "./source-frontmatter";
export { unavailableReferencedSourceFileRead } from "./source-model";
export type {
    ReferencedSourceFileReadResult,
    SourceCandidateBuildResult,
    SourceCandidateBuilder,
    SourceContextBase,
    SourceDirectoryRecord,
    SourceFileRecord,
    SourceRecord,
    SourceScanResultBase,
} from "./source-model";
export {
    buildNativeAncestorDirectories,
    buildSeparateNativeRepresentation,
    comparableCandidateNativeFiles,
    comparablePersistedNativeFiles,
    hydrateValidatedNativeSourceFiles,
    projectCandidateVersionFiles,
    projectPersistedVersionFiles,
    sha256SourceBytes,
    stableSourceValueEqual,
    zeroSha256Digest,
} from "./source-native";
export type {
    CanonicalVersionFileProjection,
    ComparableNativeFile,
    NativeVersionFileProjectionPolicy,
    ValidatedNativeSourceFileInput,
} from "./source-native";
export { buildMarkdownLinkReferences } from "./source-references";
export type {
    MarkdownLinkReferenceInput,
    MarkdownLinkReferencePolicy,
} from "./source-references";
export {
    defineAssetReaderRegistry,
    sourceReader,
    sourceUnavailable,
} from "./source-registry";
export type {
    AssetReaderDisposition,
    AssetReaderRegistry,
    SourceReaderDisposition,
    SourceUnavailableDisposition,
} from "./source-registry";
export {
    compareCodeUnitText,
    compareLogicalPath,
    decodeUtf8Strict,
    isAsciiWhitespace,
    isPlainRecord,
    isPortablePathAtOrBelow,
    isPortableSourcePattern,
    normalizePortableRelativeReference,
    portableBasename,
    portableParentPath,
    portablePathWithoutExtension,
    relativePortablePath,
    trimNonBlankText,
    uniqueSortedStrings,
    uniqueStringsPreservingOrder,
    unknownSourceKeys,
} from "./source-text";
export { traverseSourceRead } from "./source-traversal";
export { isDirectSourceDirectoryEntry } from "./source-managed-entry";
export type { SourceTraversalPolicy } from "./source-traversal";
export type {
    AdapterFrameworkTargetDefinition,
    AdapterTargetConsumerHandler,
    AdapterTargetMaterializerHandler,
} from "./target-model";

export { createTargetCoordinator } from "./target-coordinator";
