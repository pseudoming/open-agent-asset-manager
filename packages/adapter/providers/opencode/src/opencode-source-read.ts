/** OpenCode hooks consumed by the adapter-framework-owned source-read handler. */

import type { AdapterFrameworkSourceReadDefinition } from "@oaam/adapter-framework";
import { readDiagnostic } from "./opencode-source-read-foundation";
import type { ScanResult, SourceContext } from "./opencode-source-read-model";
import { OPENCODE_ASSET_READER_REGISTRY } from "./opencode-source-read-registry";
import { resolveSourceContext, scanOpencodeReadObligation } from "./opencode-source-read-scan";

export { OPENCODE_NATIVE_DIALECTS } from "./opencode-source-read-model";
export { validateOpencodeNativeDialect } from "./opencode-source-read-native";

export const OPENCODE_SOURCE_READ = {
    registry: OPENCODE_ASSET_READER_REGISTRY,
    resolveContext: (readInput, root) => resolveSourceContext(readInput, root),
    scan: scanOpencodeReadObligation,
    diagnostics: {
        unknownAuthority: () =>
            readDiagnostic(
                "opencode.read_authority_unknown",
                "opencode read obligation does not match a declared capability/root",
                "invalid_schema",
                "error",
            ),
        capabilityNotCallable: (root) =>
            readDiagnostic(
                "opencode.source_capability_not_callable",
                "This opencode source capability is report-only or deferred",
                "unsupported",
                "error",
                root.path,
            ),
        readerUnavailable: (root, unavailable) =>
            readDiagnostic(unavailable.diagnosticCode, unavailable.message, "unsupported", "error", root.path),
        contextUnresolved: (root) =>
            readDiagnostic(
                "opencode.source_scope_unresolved",
                "Cannot resolve scope/layout for the selected opencode source root",
                "invalid_schema",
                "error",
                root.path,
            ),
        rootWithoutObligation: (root) =>
            readDiagnostic(
                "opencode.root_without_obligation",
                "Selected opencode root had no callable source capability",
                "unsupported",
                "error",
                root.path,
            ),
    },
} satisfies AdapterFrameworkSourceReadDefinition<SourceContext, ScanResult>;
