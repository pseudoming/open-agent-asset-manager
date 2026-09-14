import { type ComponentPropsWithoutRef, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { DesktopIcon } from "./icons";
import { WorkbenchTooltip } from "./WorkbenchTooltip";

const TECHNICAL_TOOLTIP_AUTO_DISMISS_MILLISECONDS = 3_000;

export interface WorkbenchDisclosureProps extends Omit<ComponentPropsWithoutRef<"details">, "children"> {
    readonly summary: ReactNode;
    readonly children: ReactNode;
    readonly "data-oaam-interaction-entry"?: string;
}

export interface WorkbenchTechnicalFactProps extends Omit<WorkbenchDisclosureProps, "className"> {
    readonly fact: ReactNode;
    readonly className?: string;
    readonly disclosureClassName?: string;
}

export function WorkbenchDisclosure({
    summary,
    children,
    className,
    "data-oaam-interaction-entry": interactionEntry,
    ...props
}: WorkbenchDisclosureProps): React.JSX.Element {
    return (
        <Disclosure {...props} className={className} interactionEntry={interactionEntry} summary={summary} technical={false}>
            {children}
        </Disclosure>
    );
}

export function WorkbenchTechnicalFact({
    fact,
    summary,
    children,
    className,
    disclosureClassName,
    "data-oaam-interaction-entry": interactionEntry,
    ...props
}: WorkbenchTechnicalFactProps): React.JSX.Element {
    return (
        <div className={["workbench-technical-fact", className].filter(Boolean).join(" ")}>
            <div className="workbench-technical-fact-owner">{fact}</div>
            <Disclosure
                {...props}
                className={disclosureClassName}
                interactionEntry={interactionEntry}
                summary={summary}
                technical
            >
                {children}
            </Disclosure>
        </div>
    );
}

interface DisclosureProps extends Omit<ComponentPropsWithoutRef<"details">, "children"> {
    readonly children: ReactNode;
    readonly interactionEntry?: string;
    readonly summary: ReactNode;
    readonly technical: boolean;
}

function Disclosure({ summary, children, technical, className, interactionEntry, ...props }: DisclosureProps): React.JSX.Element {
    const classes = ["workbench-disclosure", className].filter(Boolean).join(" ");
    const summaryElement = useRef<HTMLElement>(null);
    const tooltipId = useId();
    const [focused, setFocused] = useState(false);
    const [hovered, setHovered] = useState(false);
    const [tooltipDismissed, setTooltipDismissed] = useState(false);
    const tooltipLabel = technical && typeof summary === "string" ? summary : undefined;
    const tooltipVisible = tooltipLabel !== undefined && (focused || hovered) && !tooltipDismissed;
    useEffect(() => {
        const element = summaryElement.current;
        if (!technical || element === null) return;
        const handleBlur = () => {
            setFocused(false);
            setTooltipDismissed(true);
        };
        const handleClick = () => setTooltipDismissed(true);
        const handleFocus = () => {
            setFocused(true);
            setTooltipDismissed(false);
        };
        const handlePointerEnter = () => {
            setHovered(true);
            setTooltipDismissed(false);
        };
        const handlePointerLeave = () => {
            setHovered(false);
            setTooltipDismissed(true);
        };
        element.addEventListener("blur", handleBlur);
        element.addEventListener("click", handleClick);
        element.addEventListener("focus", handleFocus);
        element.addEventListener("pointerenter", handlePointerEnter);
        element.addEventListener("pointerleave", handlePointerLeave);
        return () => {
            element.removeEventListener("blur", handleBlur);
            element.removeEventListener("click", handleClick);
            element.removeEventListener("focus", handleFocus);
            element.removeEventListener("pointerenter", handlePointerEnter);
            element.removeEventListener("pointerleave", handlePointerLeave);
        };
    }, [technical]);
    useEffect(() => {
        if (!tooltipVisible) return;
        const timeout = window.setTimeout(() => setTooltipDismissed(true), TECHNICAL_TOOLTIP_AUTO_DISMISS_MILLISECONDS);
        return () => window.clearTimeout(timeout);
    }, [tooltipVisible]);
    return (
        <details {...props} className={classes} data-oaam-technical-detail={technical || undefined}>
            <summary
                data-oaam-interaction-entry={interactionEntry}
                aria-describedby={tooltipVisible ? tooltipId : undefined}
                ref={summaryElement}
            >
                <span className={technical ? "sr-only" : "workbench-disclosure-summary"}>{summary}</span>
                <DesktopIcon name={technical ? "info" : "chevron_down"} size={14} />
            </summary>
            <div className="workbench-disclosure-content">{children}</div>
            {tooltipLabel === undefined ? null : (
                <WorkbenchTooltip anchorRef={summaryElement} id={tooltipId} label={tooltipLabel} visible={tooltipVisible} />
            )}
        </details>
    );
}
