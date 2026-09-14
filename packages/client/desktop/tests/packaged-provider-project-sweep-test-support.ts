import { PACKAGED_PROVIDER_PROJECT_SWEEP_ADAPTER_IDS } from "../src/main/packaged-provider-project-sweep-ui-smoke";

export function projectSweepContextReceipts(windows: string, wsl: string) {
    return [windows, wsl].flatMap((environment) =>
        PACKAGED_PROVIDER_PROJECT_SWEEP_ADAPTER_IDS.map((adapterId) => ({
            environment,
            adapterId,
            status: environment === windows ? "complete" : "partial",
            installationStatus: "available",
            agentRuntimeIds: [`${adapterId}_ENTRY`],
            versionTexts: ["current"],
            diagnostics: [],
        })),
    );
}
