import { useEffect, useState } from "react";
import { useDesktopPresentation } from "./PresentationContext";

export interface DesktopPaneWidths {
    readonly left: number;
    readonly right: number;
}

export interface DesktopPaneWidthController {
    readonly widths: DesktopPaneWidths;
    readonly saveFailed: boolean;
    readonly previewLeft: (value: number) => void;
    readonly previewRight: (value: number) => void;
    readonly commitLeft: (value: number) => void;
    readonly commitRight: (value: number) => void;
}

export function useDesktopPaneWidths(): DesktopPaneWidthController {
    const { snapshot, replacePreferences } = useDesktopPresentation();
    const [widths, setWidths] = useState<DesktopPaneWidths>(() => ({
        left: snapshot.preferences.leftPaneWidth,
        right: snapshot.preferences.rightPaneWidth,
    }));
    const [saveFailed, setSaveFailed] = useState(false);

    useEffect(() => {
        setWidths({
            left: snapshot.preferences.leftPaneWidth,
            right: snapshot.preferences.rightPaneWidth,
        });
    }, [snapshot.preferences.leftPaneWidth, snapshot.preferences.rightPaneWidth]);

    function commit(pane: "left" | "right", value: number): void {
        setSaveFailed(false);
        const next = { ...widths, [pane]: value };
        setWidths(next);
        void replacePreferences({
            language: snapshot.preferences.language,
            theme: snapshot.preferences.theme,
            textSize: snapshot.preferences.textSize,
            surfacePalette: snapshot.preferences.surfacePalette,
            leftPaneWidth: next.left,
            rightPaneWidth: next.right,
        }).catch(() => setSaveFailed(true));
    }

    return {
        widths,
        saveFailed,
        previewLeft: (left) => setWidths((current) => ({ ...current, left })),
        previewRight: (right) => setWidths((current) => ({ ...current, right })),
        commitLeft: (left) => commit("left", left),
        commitRight: (right) => commit("right", right),
    };
}
