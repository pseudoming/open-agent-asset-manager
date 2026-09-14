/** Cursor-owned runtime descriptors and exact capability dispositions. */
import { adapterOperationDiagnostic as diagnostic } from "@oaam/adapter-framework";
import type { AssetKind, AgentRuntimeDescriptor } from "@oaam/core";

export const ASSET_KINDS: AssetKind[] = ["Guidance", "Rule", "Workflow", "Skill", "Subagent", "Memory"];
export const AGENT_RUNTIMES: AgentRuntimeDescriptor[] = [
    { agentRuntimeId: "CURSOR_AGENT_CLI", displayName: "Cursor Agent CLI", entryClass: "cli" },
    { agentRuntimeId: "CURSOR_APP", displayName: "Cursor App", entryClass: "app" },
];

export function capabilityDiagnostic(operation: "read" | "render", runtimeLabel: string, assetKind: AssetKind) {
    let message = `${runtimeLabel} ${assetKind} lifecycle has not yet crossed the exact source/target/load/reverse evidence gate`;
    if (assetKind === "Memory") {
        const cli = runtimeLabel === "Cursor Agent CLI";
        if (operation === "read") {
            message = cli
                ? `${runtimeLabel} exposes model-mediated knowledge vocabulary, but no callable exact-entry item-selected source or durable local owner`
                : `${runtimeLabel} supports only an explicitly selected, exact-build read-only frozen Memory snapshot; live remote discovery remains outside automatic source probing`;
        } else {
            message = cli
                ? `${runtimeLabel} exposes no callable exact-entry Memory mutation, consumer-load receipt or attributable reverse owner`
                : `${runtimeLabel} Memory is remote-only; OAAM mutation authority is local-disk only, so remote target and reverse are unsupported`;
        }
    }
    return diagnostic(
        operation,
        operation === "render" && runtimeLabel === "Cursor App" && assetKind === "Memory"
            ? "cursor_cursor_app_memory_remote_target_unsupported"
            : `cursor_${runtimeLabel.toLowerCase().replaceAll(" ", "_")}_${assetKind.toLowerCase()}_deferred`,
        message,
        "unsupported",
        "warning",
    );
}
