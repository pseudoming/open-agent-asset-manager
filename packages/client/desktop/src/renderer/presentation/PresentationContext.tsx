import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { DesktopAppIdentity, DesktopWindowAction, OaamDesktopBridge } from "../../bridge/desktop-bridge";
import {
    type DesktopDisplayText,
    type DesktopMessageId,
    type DesktopMessageValues,
    formatDesktopMessage,
} from "../../presentation/localization";
import type {
    DesktopAssetLayoutPreference,
    DesktopPresentationPreferenceInput,
    DesktopPresentationSnapshot,
} from "../../presentation/presentation-preferences";

export interface DesktopPresentationContextValue {
    readonly appIdentity: DesktopAppIdentity;
    readonly snapshot: DesktopPresentationSnapshot;
    readonly text: (id: DesktopMessageId, values?: DesktopMessageValues) => string;
    readonly displayText: (value: DesktopDisplayText) => string;
    readonly replacePreferences: (input: DesktopPresentationPreferenceInput) => Promise<void>;
    readonly completeOnboarding: () => Promise<void>;
    readonly rememberLastProject: (projectId: string) => Promise<void>;
    readonly replaceAssetLayout: (assetLayout: DesktopAssetLayoutPreference) => Promise<void>;
    readonly performWindowAction: (action: DesktopWindowAction) => Promise<void>;
}

const DesktopPresentationContext = createContext<DesktopPresentationContextValue | undefined>(undefined);

function applyDocumentPresentation(snapshot: DesktopPresentationSnapshot): void {
    document.documentElement.lang = snapshot.resolvedLocale;
    document.documentElement.dataset.oaamTheme = snapshot.resolvedTheme;
    document.documentElement.dataset.oaamTextSize = snapshot.preferences.textSize;
    document.documentElement.dataset.oaamSurfacePalette = snapshot.preferences.surfacePalette;
    document.documentElement.style.colorScheme = snapshot.resolvedTheme;
}

export interface DesktopPresentationProviderProps {
    readonly bridge: OaamDesktopBridge;
    readonly children: ReactNode;
}

export function DesktopPresentationProvider({ bridge, children }: DesktopPresentationProviderProps): React.JSX.Element {
    const [snapshot, setSnapshot] = useState(bridge.initialPresentation);
    useEffect(() => {
        applyDocumentPresentation(snapshot);
    }, [snapshot]);
    useEffect(() => bridge.subscribePresentation(setSnapshot), [bridge]);
    const text = useCallback(
        (id: DesktopMessageId, values?: DesktopMessageValues) => formatDesktopMessage(snapshot, id, values),
        [snapshot],
    );
    const displayText = useCallback(
        (value: DesktopDisplayText) =>
            value.kind === "technical" ? value.text : formatDesktopMessage(snapshot, value.id, value.values),
        [snapshot],
    );
    const replacePreferences = useCallback(
        async (input: DesktopPresentationPreferenceInput): Promise<void> => {
            setSnapshot(await bridge.replacePresentationPreferences(input));
        },
        [bridge],
    );
    const completeOnboarding = useCallback(async (): Promise<void> => {
        setSnapshot(await bridge.completeOnboarding());
    }, [bridge]);
    const rememberLastProject = useCallback(
        async (projectId: string): Promise<void> => {
            setSnapshot(await bridge.rememberLastProject(projectId));
        },
        [bridge],
    );
    const replaceAssetLayout = useCallback(
        async (assetLayout: DesktopAssetLayoutPreference): Promise<void> => {
            setSnapshot(await bridge.replaceAssetLayout(assetLayout));
        },
        [bridge],
    );
    const performWindowAction = useCallback(
        async (action: DesktopWindowAction): Promise<void> => {
            await bridge.performWindowAction(action);
        },
        [bridge],
    );
    const value = useMemo(
        () =>
            Object.freeze({
                appIdentity: bridge.initialAppIdentity,
                snapshot,
                text,
                displayText,
                replacePreferences,
                completeOnboarding,
                rememberLastProject,
                replaceAssetLayout,
                performWindowAction,
            }),
        [
            completeOnboarding,
            bridge.initialAppIdentity,
            displayText,
            performWindowAction,
            rememberLastProject,
            replaceAssetLayout,
            replacePreferences,
            snapshot,
            text,
        ],
    );
    return <DesktopPresentationContext.Provider value={value}>{children}</DesktopPresentationContext.Provider>;
}

export function useDesktopPresentation(): DesktopPresentationContextValue {
    const value = useContext(DesktopPresentationContext);
    if (value === undefined) throw new Error("Desktop presentation context is unavailable");
    return value;
}

export type { DesktopDisplayText, DesktopMessageValues };
export { formatDesktopMessage };
