import type { ProtocolDiagnosticV1 } from "@oaam/app-server-protocol";
import type { DesktopApplicationClientApi } from "../../client";
import type { AdapterEnablementView } from "./discovery-model";

export type TargetProbeAuthorizationResult =
    | { readonly status: "unchanged" }
    | {
          readonly status: "persisted";
          readonly enablement: AdapterEnablementView;
          readonly selectedAdapterIds: readonly string[];
          readonly diagnostics: readonly ProtocolDiagnosticV1[];
      }
    | { readonly status: "failed"; readonly diagnostics: readonly ProtocolDiagnosticV1[] };

export function providerSelectionChanged(enablement: AdapterEnablementView, selectedAdapterIds: readonly string[]): boolean {
    const enabled = new Set(enablement.enabledAdapterIds);
    return selectedAdapterIds.some((adapterId) => !enabled.has(adapterId)) || enabled.size !== selectedAdapterIds.length;
}

export function targetProbeAuthorizationRequired(
    purpose: "source_discovery" | "target_discovery" | undefined,
    enablement: AdapterEnablementView,
    selectedAdapterIds: readonly string[],
): boolean {
    if (purpose !== "target_discovery") return false;
    const enabled = new Set(enablement.enabledAdapterIds);
    return selectedAdapterIds.some((adapterId) => !enabled.has(adapterId));
}

export async function persistTargetProbeAuthorization(
    client: DesktopApplicationClientApi,
    enablement: AdapterEnablementView,
    selectedAdapterIds: readonly string[],
    userActionId: string,
): Promise<TargetProbeAuthorizationResult> {
    const enabled = new Set(enablement.enabledAdapterIds);
    if (selectedAdapterIds.every((adapterId) => enabled.has(adapterId))) return { status: "unchanged" };
    const exactSelection = Object.freeze([...selectedAdapterIds]);
    const nextEnabledAdapterIds = [...new Set([...enablement.enabledAdapterIds, ...exactSelection])].sort();
    try {
        const outcome = await client.replaceAdapterEnablement({
            expectedRevision: enablement.revision,
            expectedSettingFingerprint: enablement.settingFingerprint,
            enabledAdapterIds: nextEnabledAdapterIds,
            userActionId,
        });
        if (outcome.status === "failed") return { status: "failed", diagnostics: outcome.diagnostics };
        const persisted = new Set(outcome.value.enabledAdapterIds);
        if (!exactSelection.every((adapterId) => persisted.has(adapterId))) {
            return { status: "failed", diagnostics: outcome.diagnostics };
        }
        return {
            status: "persisted",
            enablement: outcome.value,
            selectedAdapterIds: exactSelection,
            diagnostics: outcome.diagnostics,
        };
    } catch {
        return { status: "failed", diagnostics: [] };
    }
}
