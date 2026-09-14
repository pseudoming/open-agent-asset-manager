import { probeDiagnostic as diagnostic, type ProviderRegularFileIdentity } from "@oaam/adapter-framework";
import type { InstallationEvidence, OperationDiagnostic } from "@oaam/core";

export interface ClaudeExecutableSearch {
    status: "available" | "not_found" | "needs_permission" | "unknown";
    evidence: InstallationEvidence[];
    diagnostics: OperationDiagnostic[];
    executable: { readonly path: string; readonly identity: ProviderRegularFileIdentity } | null;
}

export function availableClaudeExecutable(executablePath: string, identity: ProviderRegularFileIdentity): ClaudeExecutableSearch {
    return {
        status: "available",
        evidence: [{ kind: "executable", path: executablePath, evidenceLevel: "local_artifact", diagnostics: [] }],
        diagnostics: [],
        executable: { path: executablePath, identity },
    };
}

export function unavailableClaudeExecutable(
    status: "not_found" | "unknown",
    code: "claudecode_executable_not_found" | "claudecode_install_discovery_incomplete",
    targetPath: string,
): ClaudeExecutableSearch {
    return {
        status,
        evidence: [{ kind: "install_root", path: targetPath, evidenceLevel: "user_provided", diagnostics: [] }],
        diagnostics: [
            diagnostic(
                code,
                status === "not_found"
                    ? "The selected folder does not directly contain an executable Claude CLI"
                    : "The selected Claude installation folder could not be inspected safely",
                status === "not_found" ? "not_found" : "partial",
                "warning",
                targetPath,
            ),
        ],
        executable: null,
    };
}
