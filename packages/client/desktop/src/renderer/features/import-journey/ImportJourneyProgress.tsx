import { type DesktopMessageId, useDesktopPresentation } from "../../presentation";
import {
    type ImportJourneyStep,
    type VisibleImportJourneyStep,
    VISIBLE_IMPORT_JOURNEY_STEPS,
    visibleImportJourneyStep,
} from "./import-journey-model";

const STEP_MESSAGES: Readonly<Record<VisibleImportJourneyStep, DesktopMessageId>> = {
    locations: "import_journey.steps.locations",
    tools: "import_journey.steps.tools",
    results: "import_journey.steps.results",
    sources: "import_journey.steps.sources",
    assets: "import_journey.steps.assets",
    complete: "import_journey.steps.complete",
};

export interface ImportJourneyProgressProps {
    readonly step: ImportJourneyStep;
    readonly label: string;
}

export function ImportJourneyProgress({ step, label }: ImportJourneyProgressProps): React.JSX.Element {
    const { text } = useDesktopPresentation();
    const visibleStep = visibleImportJourneyStep(step);
    const currentIndex = VISIBLE_IMPORT_JOURNEY_STEPS.indexOf(visibleStep);
    return (
        <ol className="journey-steps import-journey-steps" aria-label={label}>
            {VISIBLE_IMPORT_JOURNEY_STEPS.map((item, index) => (
                <li
                    aria-current={visibleStep === item ? "step" : undefined}
                    data-current={visibleStep === item}
                    data-complete={index < currentIndex}
                    key={item}
                >
                    {text(STEP_MESSAGES[item])}
                </li>
            ))}
        </ol>
    );
}
