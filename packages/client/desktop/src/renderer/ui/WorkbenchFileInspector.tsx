import { type CSSProperties, type ReactNode, type Ref, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { WorkbenchResizeSeparator } from "./WorkbenchResizeSeparator";

export function useWorkbenchFileInspectorWidth(
    preferredWidth: number,
    minimumMainWidth: number,
): {
    readonly width: number;
    readonly maximumWidth: number;
} {
    const readViewportWidth = (): number => document.documentElement.clientWidth || globalThis.innerWidth;
    const [viewportWidth, setViewportWidth] = useState(readViewportWidth);
    useLayoutEffect(() => {
        const observe = (): void => setViewportWidth(document.documentElement.clientWidth || globalThis.innerWidth);
        const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(observe);
        observer?.observe(document.documentElement);
        globalThis.addEventListener("resize", observe);
        globalThis.visualViewport?.addEventListener("resize", observe);
        return () => {
            observer?.disconnect();
            globalThis.removeEventListener("resize", observe);
            globalThis.visualViewport?.removeEventListener("resize", observe);
        };
    }, []);
    const maximumWidth = Math.max(320, Math.min(1440, viewportWidth - minimumMainWidth));
    return { width: Math.max(320, Math.min(preferredWidth, maximumWidth)), maximumWidth };
}

export function WorkbenchFileInspector({
    children,
    className,
    label,
    ref,
    width,
    maximumWidth,
    resizeLabel,
    resizeEntry,
    onResize,
}: {
    readonly children: ReactNode;
    readonly className: string;
    readonly label: string;
    readonly ref?: Ref<HTMLElement>;
    readonly width: number;
    readonly maximumWidth: number;
    readonly resizeLabel: string;
    readonly resizeEntry: string;
    readonly onResize: (width: number) => void;
}): React.JSX.Element {
    const inspector = useRef<HTMLElement>(null);
    const returnFocus = useRef(document.activeElement);
    useImperativeHandle(ref, () => inspector.current as HTMLElement, []);
    useLayoutEffect(
        () => () => {
            if (
                inspector.current?.contains(document.activeElement) &&
                returnFocus.current instanceof HTMLElement &&
                returnFocus.current.isConnected
            )
                returnFocus.current.focus({ preventScroll: true });
        },
        [],
    );
    return (
        <aside
            className={`workbench-file-inspector ${className}`}
            aria-label={label}
            ref={inspector}
            style={{ "--oaam-file-inspector-width": `${String(width)}px` } as CSSProperties}
        >
            <WorkbenchResizeSeparator
                data-oaam-interaction-entry={resizeEntry}
                label={resizeLabel}
                value={width}
                minimum={320}
                maximum={maximumWidth}
                direction={-1}
                onPreview={onResize}
                onCommit={onResize}
            />
            {children}
        </aside>
    );
}
