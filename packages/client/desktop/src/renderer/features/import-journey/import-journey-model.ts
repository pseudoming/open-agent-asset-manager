import type { DiscoveryJourneyStage } from "../discovery";

export type ImportJourneyStep = DiscoveryJourneyStage | "assets" | "complete";

export type VisibleImportJourneyStep = ImportJourneyStep;

export const VISIBLE_IMPORT_JOURNEY_STEPS: readonly VisibleImportJourneyStep[] = Object.freeze([
    "locations",
    "tools",
    "results",
    "sources",
    "assets",
    "complete",
]);

export function isDiscoveryJourneyStep(step: ImportJourneyStep): step is DiscoveryJourneyStage {
    return step === "locations" || step === "tools" || step === "results" || step === "sources";
}

export function visibleImportJourneyStep(step: ImportJourneyStep): VisibleImportJourneyStep {
    return step;
}
