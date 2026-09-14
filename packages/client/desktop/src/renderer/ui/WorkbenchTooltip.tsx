import { type RefObject, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";

const TOOLTIP_GAP = 6;
const VIEWPORT_PADDING = 8;

export interface WorkbenchTooltipPosition {
    readonly left: number;
    readonly placement: "above" | "below";
    readonly top: number;
}

interface ViewportSize {
    readonly height: number;
    readonly width: number;
}

export function resolveWorkbenchTooltipPosition(
    anchor: Pick<DOMRect, "bottom" | "left" | "right" | "top">,
    tooltip: Pick<DOMRect, "height" | "width">,
    viewport: ViewportSize,
): WorkbenchTooltipPosition {
    const availableAbove = anchor.top - VIEWPORT_PADDING - TOOLTIP_GAP;
    const availableBelow = viewport.height - anchor.bottom - VIEWPORT_PADDING - TOOLTIP_GAP;
    const placement = availableBelow >= tooltip.height || availableBelow >= availableAbove ? "below" : "above";
    const maximumLeft = Math.max(VIEWPORT_PADDING, viewport.width - VIEWPORT_PADDING - tooltip.width);
    const maximumTop = Math.max(VIEWPORT_PADDING, viewport.height - VIEWPORT_PADDING - tooltip.height);
    const preferredLeft = (anchor.left + anchor.right - tooltip.width) / 2;
    const preferredTop = placement === "below" ? anchor.bottom + TOOLTIP_GAP : anchor.top - TOOLTIP_GAP - tooltip.height;
    return Object.freeze({
        left: Math.min(maximumLeft, Math.max(VIEWPORT_PADDING, preferredLeft)),
        placement,
        top: Math.min(maximumTop, Math.max(VIEWPORT_PADDING, preferredTop)),
    });
}

export interface WorkbenchTooltipProps {
    readonly anchorRef: RefObject<HTMLElement | null>;
    readonly id: string;
    readonly label: string;
    readonly visible: boolean;
}

export function WorkbenchTooltip({ anchorRef, id, label, visible }: WorkbenchTooltipProps): React.JSX.Element | null {
    const [position, setPosition] = useState<WorkbenchTooltipPosition>();

    useLayoutEffect(() => {
        if (!visible) {
            setPosition(undefined);
            return;
        }
        const tooltip = document.getElementById(id);
        const anchor = anchorRef.current;
        if (tooltip === null || anchor === null) return;

        const update = (): void => {
            const next = resolveWorkbenchTooltipPosition(anchor.getBoundingClientRect(), tooltip.getBoundingClientRect(), {
                height: window.innerHeight,
                width: window.innerWidth,
            });
            setPosition((current) =>
                current?.left === next.left && current.top === next.top && current.placement === next.placement ? current : next,
            );
        };
        update();
        window.addEventListener("resize", update);
        window.addEventListener("scroll", update, true);
        window.visualViewport?.addEventListener("resize", update);
        window.visualViewport?.addEventListener("scroll", update);
        const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
        resizeObserver?.observe(anchor);
        resizeObserver?.observe(tooltip);
        return () => {
            window.removeEventListener("resize", update);
            window.removeEventListener("scroll", update, true);
            window.visualViewport?.removeEventListener("resize", update);
            window.visualViewport?.removeEventListener("scroll", update);
            resizeObserver?.disconnect();
        };
    }, [anchorRef, id, visible]);

    if (!visible) return null;
    return createPortal(
        <div
            className="workbench-tooltip"
            data-placement={position?.placement}
            data-ready={position !== undefined}
            id={id}
            role="tooltip"
            style={position === undefined ? undefined : { left: position.left, top: position.top }}
        >
            {label}
        </div>,
        document.body,
    );
}
