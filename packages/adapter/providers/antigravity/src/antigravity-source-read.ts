/** Antigravity hooks consumed by the adapter-framework-owned source-read handler. */

import type { AdapterFrameworkSourceReadDefinition } from "@oaam/adapter-framework";
import { readDiagnostic } from "./antigravity-source-read-foundation";
import type { ScanResult, SourceContext } from "./antigravity-source-read-model";
import { ANTIGRAVITY_ASSET_READER_REGISTRY, getAntigravityAssetReader } from "./antigravity-source-read-registry";
import { resolveSourceContext, scanAntigravityReadObligation } from "./antigravity-source-read-scan";

export { ANTIGRAVITY_NATIVE_DIALECTS } from "./antigravity-source-read-model";
export { validateAntigravityNativeDialect } from "./antigravity-source-read-native";

export const ANTIGRAVITY_SOURCE_READ = {
    registry: ANTIGRAVITY_ASSET_READER_REGISTRY,
    resolveContext: (readInput, root, capability) => resolveSourceContext(readInput, root, capability),
    scan: scanAntigravityReadObligation,
    diagnostics: {
        unknownAuthority: () =>
            readDiagnostic(
                "antigravity.read_authority_unknown",
                "Antigravity read obligation does not match a declared capability/root",
                "invalid_schema",
                "error",
            ),
        capabilityNotCallable: (root, capability) => {
            const reader = getAntigravityAssetReader(capability.assetKind);
            return readDiagnostic(
                reader.disposition === "reader" ? "antigravity.source_capability_not_callable" : reader.diagnosticCode,
                reader.disposition === "reader"
                    ? "This Antigravity source capability is report-only or deferred"
                    : reader.message,
                "unsupported",
                "error",
                root.path,
            );
        },
        readerUnavailable: (root, unavailable) =>
            readDiagnostic(unavailable.diagnosticCode, unavailable.message, "unsupported", "error", root.path),
        contextUnresolved: (root) =>
            readDiagnostic(
                "antigravity.source_scope_unresolved",
                `Cannot resolve source scope for ${root.sourceRootId}`,
                "invalid_schema",
                "error",
                root.path,
            ),
        rootWithoutObligation: (root) =>
            readDiagnostic(
                "antigravity.root_without_obligation",
                "Selected Antigravity root had no callable source capability",
                "unsupported",
                "error",
                root.path,
            ),
    },
} satisfies AdapterFrameworkSourceReadDefinition<SourceContext, ScanResult>;
