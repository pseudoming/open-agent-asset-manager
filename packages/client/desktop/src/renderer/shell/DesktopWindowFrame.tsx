import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import type { DesktopWindowAction } from "../../bridge/desktop-bridge";
import { useDesktopPresentation } from "../presentation";
import { DesktopIcon, WorkbenchDialog, WorkbenchIconButton } from "../ui";

type WindowMenuId = "file" | "edit" | "view" | "help";
type WindowRendererAction =
    | "add_project"
    | "open_settings"
    | "toggle_sidebar"
    | "toggle_inspector"
    | "navigate_back"
    | "navigate_forward"
    | "show_about";
type WindowMenuFocusEdge = "first" | "last";

interface WindowMenuItem {
    readonly id: string;
    readonly label:
        | "window.menu.file.add_project"
        | "window.menu.file.exit"
        | "window.menu.file.hide_to_tray"
        | "window.menu.edit.undo"
        | "window.menu.edit.redo"
        | "window.menu.edit.cut"
        | "window.menu.edit.copy"
        | "window.menu.edit.paste"
        | "window.menu.edit.delete"
        | "window.menu.edit.select_all"
        | "window.menu.edit.settings"
        | "window.menu.view.back"
        | "window.menu.view.forward"
        | "window.menu.view.inspector"
        | "window.menu.view.sidebar"
        | "window.menu.view.zoom_in"
        | "window.menu.view.zoom_out"
        | "window.menu.view.zoom_reset"
        | "window.menu.view.full_screen"
        | "window.menu.help.about";
    readonly action?: DesktopWindowAction;
    readonly rendererAction?: WindowRendererAction;
    readonly semanticAction?: string;
    readonly semanticEntry?: string;
    readonly shortcut?: string;
    readonly separatorBefore?: boolean;
}

const WINDOW_MENUS = {
    file: [
        { id: "add-project", label: "window.menu.file.add_project", rendererAction: "add_project" },
        {
            id: "hide-to-tray",
            label: "window.menu.file.hide_to_tray",
            action: "hide_to_tray",
            separatorBefore: true,
        },
        { id: "exit", label: "window.menu.file.exit", action: "quit", separatorBefore: true },
    ],
    edit: [
        { id: "undo", label: "window.menu.edit.undo", action: "undo", shortcut: "Ctrl+Z" },
        { id: "redo", label: "window.menu.edit.redo", action: "redo", shortcut: "Ctrl+Y" },
        { id: "cut", label: "window.menu.edit.cut", action: "cut", shortcut: "Ctrl+X", separatorBefore: true },
        { id: "copy", label: "window.menu.edit.copy", action: "copy", shortcut: "Ctrl+C" },
        { id: "paste", label: "window.menu.edit.paste", action: "paste", shortcut: "Ctrl+V" },
        { id: "delete", label: "window.menu.edit.delete", action: "delete" },
        { id: "select-all", label: "window.menu.edit.select_all", action: "select_all", shortcut: "Ctrl+A" },
        {
            id: "settings",
            label: "window.menu.edit.settings",
            rendererAction: "open_settings",
            semanticAction: "shell.open_settings",
            semanticEntry: "shell.menu.settings",
            separatorBefore: true,
        },
    ],
    view: [
        { id: "sidebar", label: "window.menu.view.sidebar", rendererAction: "toggle_sidebar" },
        { id: "inspector", label: "window.menu.view.inspector", rendererAction: "toggle_inspector" },
        {
            id: "back",
            label: "window.menu.view.back",
            rendererAction: "navigate_back",
            semanticAction: "workbench.navigate_history",
            semanticEntry: "shell.menu.history.back",
            separatorBefore: true,
        },
        {
            id: "forward",
            label: "window.menu.view.forward",
            rendererAction: "navigate_forward",
            semanticAction: "workbench.navigate_history",
            semanticEntry: "shell.menu.history.forward",
        },
        { id: "zoom-in", label: "window.menu.view.zoom_in", action: "zoom_in", shortcut: "Ctrl++" },
        { id: "zoom-out", label: "window.menu.view.zoom_out", action: "zoom_out", shortcut: "Ctrl+-" },
        { id: "zoom-reset", label: "window.menu.view.zoom_reset", action: "zoom_reset", shortcut: "Ctrl+0" },
        {
            id: "full-screen",
            label: "window.menu.view.full_screen",
            action: "toggle_full_screen",
            shortcut: "F11",
            separatorBefore: true,
        },
    ],
    help: [{ id: "about", label: "window.menu.help.about", rendererAction: "show_about" }],
} as const satisfies Readonly<Record<WindowMenuId, readonly WindowMenuItem[]>>;

const WINDOW_MENU_LABELS = Object.freeze({
    file: "window.menu.file",
    edit: "window.menu.edit",
    view: "window.menu.view",
    help: "window.menu.help",
} as const);

const WINDOW_MENU_IDS = Object.freeze(Object.keys(WINDOW_MENUS) as WindowMenuId[]);

function windowMenuItems(menuId: WindowMenuId): readonly WindowMenuItem[] {
    return WINDOW_MENUS[menuId];
}

interface WindowMenuItemButtonProps {
    readonly item: WindowMenuItem;
    readonly label: string;
    readonly disabled: boolean;
    readonly selected: boolean | undefined;
    readonly onRun: () => void;
}

function WindowMenuItemButton({ item, label, disabled, selected, onRun }: WindowMenuItemButtonProps): React.JSX.Element {
    const content = (
        <>
            <span aria-hidden="true" className="desktop-window-menu-check">
                {selected === true ? <DesktopIcon name="check" size={13} /> : null}
            </span>
            <span>{label}</span>
            {item.shortcut === undefined ? null : <kbd>{item.shortcut}</kbd>}
        </>
    );
    const shared = {
        type: "button" as const,
        className: "desktop-window-menu-item",
        "data-separator-before": item.separatorBefore === true,
        "data-oaam-semantic-action": item.semanticAction,
        "data-oaam-semantic-entry": item.semanticEntry,
        disabled,
        tabIndex: -1,
        onClick: onRun,
    };
    return selected === undefined ? (
        <button data-oaam-interaction-entry="shell.desktop_window_frame.001" {...shared} role="menuitem">
            {content}
        </button>
    ) : (
        <button
            data-oaam-interaction-entry="shell.desktop_window_frame.002"
            {...shared}
            data-selected={selected}
            role="menuitemcheckbox"
            aria-checked={selected}
        >
            {content}
        </button>
    );
}

export interface DesktopWindowFrameProps {
    readonly children: ReactNode;
    readonly overlay?: ReactNode;
    readonly projectRegistration?: {
        readonly available: boolean;
        readonly request: () => void;
    };
    readonly canOpenSettings: boolean;
    readonly onOpenSettings: () => void;
    readonly navigation?: {
        readonly canGoBack: boolean;
        readonly canGoForward: boolean;
        readonly onBack: () => void;
        readonly onForward: () => void;
    };
    readonly sidebar?: {
        readonly visible: boolean;
        readonly onToggle: () => void;
    };
    readonly inspector?: {
        readonly available: boolean;
        readonly visible: boolean;
        readonly onToggle: () => void;
    };
}

export function DesktopWindowFrame({
    children,
    overlay,
    projectRegistration,
    canOpenSettings,
    onOpenSettings,
    navigation,
    sidebar,
    inspector,
}: DesktopWindowFrameProps): React.JSX.Element {
    const { appIdentity, performWindowAction, text } = useDesktopPresentation();
    const [openMenu, setOpenMenu] = useState<WindowMenuId>();
    const [aboutOpen, setAboutOpen] = useState(false);
    const [actionFailed, setActionFailed] = useState(false);
    const menuRoot = useRef<HTMLDivElement>(null);
    const menuTriggers = useRef<Partial<Record<WindowMenuId, HTMLButtonElement | null>>>({});
    const pendingMenuFocus = useRef<WindowMenuFocusEdge | undefined>(undefined);

    useEffect(() => {
        if (openMenu === undefined) return;
        const closeOutside = (event: PointerEvent): void => {
            if (event.target instanceof Node && menuRoot.current?.contains(event.target)) return;
            setOpenMenu(undefined);
        };
        const closeOnEscape = (event: KeyboardEvent): void => {
            if (event.key !== "Escape") return;
            setOpenMenu(undefined);
            menuTriggers.current[openMenu]?.focus();
        };
        document.addEventListener("pointerdown", closeOutside, true);
        document.addEventListener("keydown", closeOnEscape);
        return () => {
            document.removeEventListener("pointerdown", closeOutside, true);
            document.removeEventListener("keydown", closeOnEscape);
        };
    }, [openMenu]);

    useEffect(() => {
        const edge = pendingMenuFocus.current;
        pendingMenuFocus.current = undefined;
        if (openMenu === undefined || edge === undefined) return;
        const popover = menuRoot.current?.querySelector<HTMLElement>(`[data-oaam-window-menu="${openMenu}"]`);
        if (popover === null || popover === undefined) return;
        const items = [
            ...popover.querySelectorAll<HTMLButtonElement>("button[role='menuitem'],button[role='menuitemcheckbox']"),
        ].filter((item) => !item.disabled);
        const item = edge === "first" ? items[0] : items.at(-1);
        item?.focus();
    }, [openMenu]);

    function enabledMenuItems(menuId: WindowMenuId): readonly HTMLButtonElement[] {
        const popover = menuRoot.current?.querySelector<HTMLElement>(`[data-oaam-window-menu="${menuId}"]`);
        if (popover === null || popover === undefined) return [];
        return [...popover.querySelectorAll<HTMLButtonElement>("button[role='menuitem'],button[role='menuitemcheckbox']")].filter(
            (item) => !item.disabled,
        );
    }

    function focusMenuEdge(menuId: WindowMenuId, edge: WindowMenuFocusEdge): void {
        const items = enabledMenuItems(menuId);
        const item = edge === "first" ? items[0] : items.at(-1);
        item?.focus();
    }

    function openMenuFromKeyboard(menuId: WindowMenuId, edge: WindowMenuFocusEdge): void {
        if (openMenu === menuId) {
            focusMenuEdge(menuId, edge);
            return;
        }
        pendingMenuFocus.current = edge;
        setOpenMenu(menuId);
    }

    function moveMenuItemFocus(menuId: WindowMenuId, offset: -1 | 1): void {
        const items = enabledMenuItems(menuId);
        if (items.length === 0) return;
        const activeElement = document.activeElement;
        const currentIndex = activeElement instanceof HTMLButtonElement ? items.indexOf(activeElement) : -1;
        const nextIndex =
            currentIndex < 0 ? (offset === 1 ? 0 : items.length - 1) : (currentIndex + offset + items.length) % items.length;
        items[nextIndex]?.focus();
    }

    function moveToAdjacentMenu(menuId: WindowMenuId, offset: -1 | 1): void {
        const currentIndex = WINDOW_MENU_IDS.indexOf(menuId);
        const nextMenu = WINDOW_MENU_IDS[(currentIndex + offset + WINDOW_MENU_IDS.length) % WINDOW_MENU_IDS.length];
        if (nextMenu === undefined) return;
        pendingMenuFocus.current = "first";
        setOpenMenu(nextMenu);
    }

    function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>, menuId: WindowMenuId): void {
        switch (event.key) {
            case "ArrowDown":
                event.preventDefault();
                moveMenuItemFocus(menuId, 1);
                return;
            case "ArrowUp":
                event.preventDefault();
                moveMenuItemFocus(menuId, -1);
                return;
            case "Home":
                event.preventDefault();
                focusMenuEdge(menuId, "first");
                return;
            case "End":
                event.preventDefault();
                focusMenuEdge(menuId, "last");
                return;
            case "ArrowLeft":
                event.preventDefault();
                moveToAdjacentMenu(menuId, -1);
                return;
            case "ArrowRight":
                event.preventDefault();
                moveToAdjacentMenu(menuId, 1);
                return;
            case "Escape":
                event.preventDefault();
                event.stopPropagation();
                setOpenMenu(undefined);
                menuTriggers.current[menuId]?.focus();
                return;
            case "Tab":
                setOpenMenu(undefined);
        }
    }

    async function runWindowAction(action: DesktopWindowAction): Promise<void> {
        setOpenMenu(undefined);
        setActionFailed(false);
        try {
            await performWindowAction(action);
        } catch {
            setActionFailed(true);
        }
    }

    function rendererActionAvailable(action: WindowRendererAction): boolean {
        switch (action) {
            case "add_project":
                return projectRegistration?.available === true;
            case "open_settings":
                return canOpenSettings;
            case "toggle_sidebar":
                return sidebar !== undefined;
            case "toggle_inspector":
                return inspector?.available === true;
            case "navigate_back":
                return navigation?.canGoBack === true;
            case "navigate_forward":
                return navigation?.canGoForward === true;
            case "show_about":
                return true;
        }
    }

    function rendererActionSelected(action: WindowRendererAction): boolean | undefined {
        if (action === "toggle_sidebar") return sidebar?.visible;
        if (action === "toggle_inspector") return inspector?.visible;
        return undefined;
    }

    function runRendererAction(action: WindowRendererAction): void {
        setOpenMenu(undefined);
        setActionFailed(false);
        if (!rendererActionAvailable(action)) return;
        switch (action) {
            case "add_project":
                projectRegistration?.request();
                return;
            case "open_settings":
                onOpenSettings();
                return;
            case "toggle_sidebar":
                sidebar?.onToggle();
                return;
            case "toggle_inspector":
                inspector?.onToggle();
                return;
            case "navigate_back":
                navigation?.onBack();
                return;
            case "navigate_forward":
                navigation?.onForward();
                return;
            case "show_about":
                menuTriggers.current.help?.focus();
                setAboutOpen(true);
        }
    }

    function closeAbout(): void {
        setAboutOpen(false);
    }

    return (
        <div className="desktop-window-frame">
            <header className="desktop-window-chrome" data-oaam-window-chrome>
                <div className="desktop-window-chrome-content" ref={menuRoot}>
                    <div className="desktop-window-leading-actions">
                        <WorkbenchIconButton
                            data-oaam-interaction-entry="shell.desktop_window_frame.003"
                            id="oaam-workbench-sidebar-toggle"
                            className="desktop-window-icon-button"
                            icon="sidebar"
                            label={text("window.sidebar.toggle")}
                            aria-pressed={sidebar?.visible}
                            disabled={sidebar === undefined}
                            onClick={sidebar?.onToggle}
                        />
                        <WorkbenchIconButton
                            className="desktop-window-icon-button"
                            icon="back"
                            label={text("window.navigation.back")}
                            data-oaam-semantic-action="workbench.navigate_history"
                            data-oaam-semantic-entry="shell.history.back"
                            disabled={navigation?.canGoBack !== true}
                            onClick={() => navigation?.onBack()}
                        />
                        <WorkbenchIconButton
                            className="desktop-window-icon-button"
                            icon="forward"
                            label={text("window.navigation.forward")}
                            data-oaam-semantic-action="workbench.navigate_history"
                            data-oaam-semantic-entry="shell.history.forward"
                            disabled={navigation?.canGoForward !== true}
                            onClick={() => navigation?.onForward()}
                        />
                    </div>
                    <nav className="desktop-window-menus" aria-label={text("window.chrome.title")}>
                        {WINDOW_MENU_IDS.map((menuId) => (
                            <div className="desktop-window-menu" key={menuId}>
                                <button
                                    data-oaam-interaction-entry="shell.desktop_window_frame.006"
                                    type="button"
                                    className="desktop-window-menu-trigger"
                                    id={`oaam-window-menu-${menuId}-trigger`}
                                    aria-expanded={openMenu === menuId}
                                    aria-haspopup="menu"
                                    ref={(trigger) => {
                                        menuTriggers.current[menuId] = trigger;
                                    }}
                                    onClick={() => {
                                        pendingMenuFocus.current = undefined;
                                        setOpenMenu((current) => (current === menuId ? undefined : menuId));
                                    }}
                                    onKeyDown={(event) => {
                                        if (event.key === "Tab" && openMenu === menuId) {
                                            setOpenMenu(undefined);
                                            return;
                                        }
                                        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                                        event.preventDefault();
                                        openMenuFromKeyboard(menuId, event.key === "ArrowDown" ? "first" : "last");
                                    }}
                                >
                                    {text(WINDOW_MENU_LABELS[menuId])}
                                </button>
                                {openMenu === menuId ? (
                                    <div
                                        data-oaam-interaction-entry="shell.desktop_window_frame.007"
                                        className="desktop-window-menu-popover"
                                        data-oaam-window-menu={menuId}
                                        role="menu"
                                        aria-labelledby={`oaam-window-menu-${menuId}-trigger`}
                                        onKeyDown={(event) => handleMenuKeyDown(event, menuId)}
                                    >
                                        {windowMenuItems(menuId).map((item) => {
                                            const selected =
                                                item.rendererAction === undefined
                                                    ? undefined
                                                    : rendererActionSelected(item.rendererAction);
                                            return (
                                                <WindowMenuItemButton
                                                    disabled={
                                                        item.rendererAction !== undefined &&
                                                        !rendererActionAvailable(item.rendererAction)
                                                    }
                                                    item={item}
                                                    key={item.id}
                                                    label={text(item.label)}
                                                    selected={selected}
                                                    onRun={() => {
                                                        if (item.action !== undefined) void runWindowAction(item.action);
                                                        else if (item.rendererAction !== undefined)
                                                            runRendererAction(item.rendererAction);
                                                    }}
                                                />
                                            );
                                        })}
                                    </div>
                                ) : null}
                            </div>
                        ))}
                    </nav>
                    <div className="desktop-window-drag-region" aria-hidden="true" />
                    {actionFailed ? (
                        <span className="desktop-window-action-error" role="status">
                            {text("window.action.failed")}
                        </span>
                    ) : null}
                </div>
            </header>
            <div className="desktop-window-content">{children}</div>
            {overlay}
            {aboutOpen ? (
                <WorkbenchDialog
                    data-oaam-interaction-entry="shell.desktop_window_frame.008"
                    closeLabel={text("common.close")}
                    dialogId="about"
                    title={text("window.about.title")}
                    onClose={closeAbout}
                >
                    <div className="desktop-about-identity">
                        <DesktopIcon name="info" size={20} />
                        <div>
                            <strong>{appIdentity.name}</strong>
                            <p>{text("window.about.detail", { version: appIdentity.version })}</p>
                        </div>
                    </div>
                </WorkbenchDialog>
            ) : null}
        </div>
    );
}
