import {
    type ComponentPropsWithoutRef,
    type FocusEvent as ReactFocusEvent,
    type KeyboardEvent as ReactKeyboardEvent,
    type PointerEvent as ReactPointerEvent,
    useCallback,
    useEffect,
    useRef,
    useState,
} from "react";

const TRANSIENT_SIDEBAR_DISMISS_MS = 220;

type TransientSidebarPhase = "closed" | "open" | "closing";

export interface TransientWorkbenchSidebarProps
    extends Omit<
        ComponentPropsWithoutRef<"aside">,
        "aria-hidden" | "hidden" | "onBlur" | "onFocus" | "onKeyDown" | "onPointerEnter" | "onPointerLeave"
    > {
    readonly persistentVisible: boolean;
    readonly restoreFocusElementId: string;
}

/**
 * Presents one route-owned sidebar either in the persistent grid or as a short-lived edge overlay.
 * It deliberately owns no sidebar contents and never mutates the persisted visibility preference.
 */
export function TransientWorkbenchSidebar({
    persistentVisible,
    restoreFocusElementId,
    ...asideProps
}: TransientWorkbenchSidebarProps): React.JSX.Element {
    const [phase, setPhase] = useState<TransientSidebarPhase>("closed");
    const aside = useRef<HTMLElement>(null);
    const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const pointerInsideEdge = useRef(false);
    const pointerInsideSidebar = useRef(false);

    const clearCloseTimer = useCallback((): void => {
        if (closeTimer.current === undefined) return;
        clearTimeout(closeTimer.current);
        closeTimer.current = undefined;
    }, []);

    function openTransient(): void {
        if (persistentVisible) return;
        clearCloseTimer();
        setPhase("open");
    }

    function finishClosing(): void {
        closeTimer.current = undefined;
        if (pointerInsideEdge.current || pointerInsideSidebar.current || aside.current?.contains(document.activeElement)) {
            setPhase("open");
            return;
        }
        setPhase("closed");
    }

    function closeTransient(): void {
        if (persistentVisible || phase === "closed") return;
        clearCloseTimer();
        setPhase("closing");
        closeTimer.current = setTimeout(finishClosing, TRANSIENT_SIDEBAR_DISMISS_MS);
    }

    function closeWhenUnoccupied(): void {
        if (pointerInsideEdge.current || pointerInsideSidebar.current || aside.current?.contains(document.activeElement)) {
            return;
        }
        closeTransient();
    }

    function handleEdgeEnter(): void {
        pointerInsideEdge.current = true;
        openTransient();
    }

    function handleEdgeLeave(): void {
        pointerInsideEdge.current = false;
        closeWhenUnoccupied();
    }

    function handleSidebarEnter(_event: ReactPointerEvent<HTMLElement>): void {
        pointerInsideSidebar.current = true;
        openTransient();
    }

    function handleSidebarLeave(_event: ReactPointerEvent<HTMLElement>): void {
        pointerInsideSidebar.current = false;
        closeWhenUnoccupied();
    }

    function handleSidebarBlur(event: ReactFocusEvent<HTMLElement>): void {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        if (pointerInsideEdge.current || pointerInsideSidebar.current) return;
        closeTransient();
    }

    function handleSidebarKeyDown(event: ReactKeyboardEvent<HTMLElement>): void {
        if (persistentVisible || event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        pointerInsideEdge.current = false;
        pointerInsideSidebar.current = false;
        closeTransient();
        document.getElementById(restoreFocusElementId)?.focus();
    }

    useEffect(() => {
        if (!persistentVisible) return;
        clearCloseTimer();
        pointerInsideEdge.current = false;
        pointerInsideSidebar.current = false;
        setPhase("closed");
    }, [clearCloseTimer, persistentVisible]);

    useEffect(
        () => () => {
            clearCloseTimer();
        },
        [clearCloseTimer],
    );

    const transient = !persistentVisible;
    const hidden = transient && phase === "closed";
    return (
        <>
            {transient ? (
                <div
                    data-oaam-interaction-entry="shell.transient_workbench_sidebar.001"
                    className="workbench-transient-sidebar-edge"
                    data-oaam-transient-sidebar-edge
                    aria-hidden="true"
                    onPointerEnter={handleEdgeEnter}
                    onPointerLeave={handleEdgeLeave}
                />
            ) : null}
            <aside
                data-oaam-interaction-entry="shell.transient_workbench_sidebar.002"
                {...asideProps}
                ref={aside}
                hidden={hidden}
                data-oaam-sidebar-mode={transient ? "transient" : "persistent"}
                data-oaam-transient-phase={transient ? phase : undefined}
                onBlur={handleSidebarBlur}
                onKeyDown={handleSidebarKeyDown}
                onPointerEnter={handleSidebarEnter}
                onPointerLeave={handleSidebarLeave}
            />
        </>
    );
}
