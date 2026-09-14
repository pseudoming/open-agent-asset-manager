import { type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, useRef } from "react";

export interface WorkbenchResizeSeparatorProps {
    readonly label: string;
    readonly value: number;
    readonly minimum: number;
    readonly maximum: number;
    readonly direction?: 1 | -1;
    readonly onPreview: (value: number) => void;
    readonly onCommit: (value: number) => void;
    readonly "data-oaam-interaction-entry"?: string;
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

export function WorkbenchResizeSeparator({
    label,
    value,
    minimum,
    maximum,
    direction = 1,
    onPreview,
    onCommit,
    "data-oaam-interaction-entry": interactionEntry,
}: WorkbenchResizeSeparatorProps): React.JSX.Element {
    const drag = useRef<{ readonly pointerId: number; readonly originX: number; readonly originValue: number } | undefined>(
        undefined,
    );
    const preview = useRef(value);
    preview.current = value;

    function pointerDown(event: ReactPointerEvent<HTMLHRElement>): void {
        if (event.button !== 0) return;
        drag.current = { pointerId: event.pointerId, originX: event.clientX, originValue: value };
        preview.current = value;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        event.preventDefault();
    }

    function pointerMove(event: ReactPointerEvent<HTMLHRElement>): void {
        const active = drag.current;
        if (active === undefined || active.pointerId !== event.pointerId) return;
        const next = clamp(active.originValue + (event.clientX - active.originX) * direction, minimum, maximum);
        preview.current = next;
        onPreview(next);
    }

    function pointerEnd(event: ReactPointerEvent<HTMLHRElement>): void {
        const active = drag.current;
        if (active === undefined || active.pointerId !== event.pointerId) return;
        drag.current = undefined;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        onCommit(preview.current);
    }

    function pointerCancel(event: ReactPointerEvent<HTMLHRElement>): void {
        const active = drag.current;
        if (active === undefined || active.pointerId !== event.pointerId) return;
        drag.current = undefined;
        preview.current = active.originValue;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        onPreview(active.originValue);
    }

    function keyDown(event: ReactKeyboardEvent<HTMLHRElement>): void {
        let next: number | undefined;
        if (event.key === "Home") next = minimum;
        else if (event.key === "End") next = maximum;
        else if (event.key === "ArrowLeft") next = clamp(value - 8 * direction, minimum, maximum);
        else if (event.key === "ArrowRight") next = clamp(value + 8 * direction, minimum, maximum);
        if (next === undefined) return;
        event.preventDefault();
        onPreview(next);
        onCommit(next);
    }

    return (
        <hr
            data-oaam-interaction-entry={interactionEntry}
            aria-label={label}
            aria-orientation="vertical"
            aria-valuemax={maximum}
            aria-valuemin={minimum}
            aria-valuenow={value}
            className="workbench-resize-separator"
            tabIndex={0}
            onKeyDown={keyDown}
            onPointerCancel={pointerCancel}
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onPointerUp={pointerEnd}
        />
    );
}
