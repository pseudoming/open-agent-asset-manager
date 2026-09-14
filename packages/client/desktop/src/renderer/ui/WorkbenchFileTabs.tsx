import { useLayoutEffect, useRef } from "react";
import { WorkbenchIconButton } from "./WorkbenchPrimitives";

export interface WorkbenchFileTab {
    readonly tabKey: string;
    readonly label: string;
    readonly title?: string;
    readonly prefix?: string;
}

export function WorkbenchFileTabs<T extends WorkbenchFileTab>({
    tabs,
    activeTabKey,
    label,
    closeLabel,
    selectEntry,
    closeEntry,
    onSelect,
    onClose,
}: {
    readonly tabs: readonly T[];
    readonly activeTabKey: string | undefined;
    readonly label: string;
    readonly closeLabel: (tab: T) => string;
    readonly selectEntry: string;
    readonly closeEntry: string;
    readonly onSelect: (tab: T) => void;
    readonly onClose: (tabKey: string) => void;
}): React.JSX.Element | null {
    const tabList = useRef<HTMLDivElement>(null);
    const previousActive = useRef<string | undefined>(undefined);
    const focusPending = useRef(false);
    useLayoutEffect(() => {
        if (!tabs.some((tab) => tab.tabKey === activeTabKey)) return;
        if (previousActive.current !== activeTabKey || focusPending.current)
            tabList.current
                ?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
                ?.focus({ preventScroll: true });
        previousActive.current = activeTabKey;
        focusPending.current = false;
    }, [activeTabKey, tabs]);
    if (tabs.length === 0) return null;
    return (
        <div className="import-preview-tabs" role="tablist" aria-label={label} ref={tabList}>
            {tabs.map((tab, index) => (
                <div className="import-preview-tab" data-active={tab.tabKey === activeTabKey} key={tab.tabKey}>
                    <button
                        data-oaam-interaction-entry={selectEntry}
                        type="button"
                        role="tab"
                        aria-selected={tab.tabKey === activeTabKey}
                        tabIndex={tab.tabKey === activeTabKey ? 0 : -1}
                        title={tab.title ?? tab.label}
                        onClick={() => {
                            focusPending.current = true;
                            onSelect(tab);
                        }}
                        onKeyDown={(event) => {
                            const nextIndex =
                                event.key === "ArrowRight"
                                    ? (index + 1) % tabs.length
                                    : event.key === "ArrowLeft"
                                      ? (index + tabs.length - 1) % tabs.length
                                      : event.key === "Home"
                                        ? 0
                                        : event.key === "End"
                                          ? tabs.length - 1
                                          : undefined;
                            if (nextIndex === undefined) return;
                            event.preventDefault();
                            focusPending.current = true;
                            onSelect(tabs[nextIndex] as T);
                        }}
                    >
                        {tab.prefix === undefined ? null : <span className="import-preview-tab-prefix">{tab.prefix}</span>}
                        <span className="import-preview-tab-label">{tab.label}</span>
                    </button>
                    <WorkbenchIconButton
                        data-oaam-interaction-entry={closeEntry}
                        icon="close"
                        label={closeLabel(tab)}
                        tabIndex={tab.tabKey === activeTabKey ? 0 : -1}
                        onClick={() => {
                            focusPending.current = true;
                            onClose(tab.tabKey);
                        }}
                    />
                </div>
            ))}
        </div>
    );
}
