import type { DesktopSessionState } from "../../../../packages/client/desktop/src/renderer/client";

export function createActualRenderSessionState(scenario: string): DesktopSessionState {
    if (scenario === "startup_starting") {
        return Object.freeze({ status: "starting", phase: "startup", message: "session.starting" });
    }
    if (scenario === "startup_reconnecting") {
        return Object.freeze({
            status: "starting",
            phase: "reconnecting",
            message: "session.host_recovering",
            reasonCode: "host.startup_timeout",
        });
    }
    if (scenario === "startup_failed_empty_reason") {
        return Object.freeze({
            status: "failed",
            message: "session.host_startup_failed",
            reasonCode: "",
            canRetry: true,
        }) as unknown as DesktopSessionState;
    }
    if (scenario === "recovery_settings") {
        return Object.freeze({
            status: "ready",
            mode: "state_recovery",
            hostInstanceId: "actual-render-host",
            assetCount: 0,
            catalogWarningCount: 1,
            recoveryReason: "missing_database",
        });
    }
    const assetCount =
        scenario === "journey" || scenario === "journey_empty" || scenario === "asset_library_empty_review"
            ? 0
            : scenario === "asset_library_project_review" || scenario === "catalog_search_context_review"
              ? 9
              : scenario === "asset_library_global_review"
                ? 4
                : 1;
    return Object.freeze({
        status: "ready",
        mode: "normal",
        hostInstanceId: "actual-render-host",
        assetCount,
        catalogWarningCount: 0,
    });
}
