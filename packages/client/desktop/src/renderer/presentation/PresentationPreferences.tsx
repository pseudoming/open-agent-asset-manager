import { useState } from "react";
import {
    DESKTOP_PANE_WIDTHS,
    type DesktopLanguagePreference,
    type DesktopPresentationPreferenceInput,
    type DesktopSurfacePalettePreference,
    type DesktopTextSizePreference,
    type DesktopThemePreference,
} from "../../presentation/presentation-preferences";
import { WorkbenchSelect } from "../ui";
import { useDesktopPresentation } from "./PresentationContext";

export function PresentationPreferences(): React.JSX.Element {
    const { snapshot, text, replacePreferences } = useDesktopPresentation();
    const [saving, setSaving] = useState(false);
    const [saveFailed, setSaveFailed] = useState(false);

    const replace = (patch: Partial<DesktopPresentationPreferenceInput>): void => {
        setSaving(true);
        setSaveFailed(false);
        void replacePreferences({
            language: snapshot.preferences.language,
            theme: snapshot.preferences.theme,
            textSize: snapshot.preferences.textSize,
            surfacePalette: snapshot.preferences.surfacePalette,
            leftPaneWidth: snapshot.preferences.leftPaneWidth,
            rightPaneWidth: snapshot.preferences.rightPaneWidth,
            ...patch,
        })
            .catch(() => setSaveFailed(true))
            .finally(() => setSaving(false));
    };

    return (
        <div className="presentation-preferences">
            <div className="presentation-preferences-field">
                <span className="presentation-preferences-label">{text("preferences.language.label")}</span>
                <WorkbenchSelect
                    data-oaam-interaction-entry="presentation.presentation_preferences.001"
                    label={text("preferences.language.label")}
                    value={snapshot.preferences.language}
                    disabled={saving}
                    options={[
                        { value: "system", label: text("preferences.language.system") },
                        { value: "en", label: text("preferences.language.en") },
                        { value: "zh-CN", label: text("preferences.language.zh-CN") },
                        { value: "de", label: text("preferences.language.de") },
                        { value: "ja", label: text("preferences.language.ja") },
                    ]}
                    onChange={(value) => replace({ language: value as DesktopLanguagePreference })}
                />
            </div>
            <div className="presentation-preferences-field">
                <span className="presentation-preferences-label">{text("preferences.theme.label")}</span>
                <WorkbenchSelect
                    data-oaam-interaction-entry="presentation.presentation_preferences.002"
                    label={text("preferences.theme.label")}
                    value={snapshot.preferences.theme}
                    disabled={saving}
                    options={[
                        { value: "system", label: text("preferences.theme.system") },
                        { value: "light", label: text("preferences.theme.light") },
                        { value: "dark", label: text("preferences.theme.dark") },
                    ]}
                    onChange={(value) => replace({ theme: value as DesktopThemePreference })}
                />
            </div>
            <div className="presentation-preferences-field">
                <span className="presentation-preferences-label">{text("preferences.text_size.label")}</span>
                <WorkbenchSelect
                    data-oaam-interaction-entry="presentation.presentation_preferences.003"
                    label={text("preferences.text_size.label")}
                    value={snapshot.preferences.textSize}
                    disabled={saving}
                    options={[
                        { value: "small", label: text("preferences.text_size.small") },
                        { value: "default", label: text("preferences.text_size.default") },
                        { value: "large", label: text("preferences.text_size.large") },
                    ]}
                    onChange={(value) => replace({ textSize: value as DesktopTextSizePreference })}
                />
            </div>
            <div className="presentation-preferences-field">
                <span className="presentation-preferences-label">{text("preferences.palette.label")}</span>
                <WorkbenchSelect
                    data-oaam-interaction-entry="presentation.presentation_preferences.004"
                    label={text("preferences.palette.label")}
                    value={snapshot.preferences.surfacePalette}
                    disabled={saving}
                    options={[
                        { value: "warm", label: text("preferences.palette.warm") },
                        { value: "neutral", label: text("preferences.palette.neutral") },
                        { value: "cool", label: text("preferences.palette.cool") },
                    ]}
                    onChange={(value) => replace({ surfacePalette: value as DesktopSurfacePalettePreference })}
                />
            </div>
            <label>
                <span className="presentation-preferences-label">{text("preferences.left_pane.label")}</span>
                <input
                    data-oaam-interaction-entry="presentation.presentation_preferences.005"
                    aria-label={text("preferences.left_pane.label")}
                    type="range"
                    min={DESKTOP_PANE_WIDTHS.left.minimum}
                    max={DESKTOP_PANE_WIDTHS.left.maximum}
                    step={8}
                    value={snapshot.preferences.leftPaneWidth}
                    disabled={saving}
                    onChange={(event) => replace({ leftPaneWidth: Number(event.currentTarget.value) })}
                />
            </label>
            <label>
                <span className="presentation-preferences-label">{text("preferences.right_pane.label")}</span>
                <input
                    data-oaam-interaction-entry="presentation.presentation_preferences.006"
                    aria-label={text("preferences.right_pane.label")}
                    type="range"
                    min={DESKTOP_PANE_WIDTHS.right.minimum}
                    max={DESKTOP_PANE_WIDTHS.right.maximum}
                    step={8}
                    value={snapshot.preferences.rightPaneWidth}
                    disabled={saving}
                    onChange={(event) => replace({ rightPaneWidth: Number(event.currentTarget.value) })}
                />
            </label>
            {saveFailed ? (
                <small className="presentation-preferences-error" role="alert">
                    {text("preferences.save_failed")}
                </small>
            ) : null}
        </div>
    );
}
