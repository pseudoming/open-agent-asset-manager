/** Claude Code hooks consumed by the adapter-framework-owned source-read handler. */

import type { AdapterFrameworkSourceReadDefinition } from "@oaam/adapter-framework";
import { readDiagnostic } from "./claudecode-source-read-foundation";
import type { ScanResult, SourceContext } from "./claudecode-source-read-model";
import { CLAUDECODE_ASSET_READER_REGISTRY } from "./claudecode-source-read-registry";
import { resolveSourceContext, scanClaudeCodeReadObligation } from "./claudecode-source-read-scan";

export { CLAUDECODE_NATIVE_DIALECTS } from "./claudecode-source-read-model";
export { validateClaudeCodeNativeDialect } from "./claudecode-source-read-native";

export const CLAUDECODE_SOURCE_READ = {
    registry: CLAUDECODE_ASSET_READER_REGISTRY,
    resolveContext: (readInput, root, capability) => resolveSourceContext(readInput, root, capability.assetKind),
    scan: scanClaudeCodeReadObligation,
    diagnostics: {
        unknownAuthority: () =>
            readDiagnostic(
                "claudecode.read_authority_unknown",
                "Claude Code read obligation does not match a declared capability/root",
                "invalid_schema",
                "error",
            ),
        capabilityNotCallable: (root) =>
            readDiagnostic(
                "claudecode.source_capability_not_callable",
                "This Claude Code source capability is report-only or deferred",
                "unsupported",
                "error",
                root.path,
            ),
        readerUnavailable: (root, unavailable) =>
            readDiagnostic(unavailable.diagnosticCode, unavailable.message, "unsupported", "error", root.path),
        contextUnresolved: (root) =>
            readDiagnostic(
                "claudecode.source_scope_unresolved",
                `Cannot resolve source scope for ${root.sourceRootId}`,
                "invalid_schema",
                "error",
                root.path,
            ),
        rootWithoutObligation: (root) =>
            readDiagnostic(
                "claudecode.root_without_obligation",
                "Selected Claude Code root had no callable source capability",
                "unsupported",
                "error",
                root.path,
            ),
    },
} satisfies AdapterFrameworkSourceReadDefinition<SourceContext, ScanResult>;
