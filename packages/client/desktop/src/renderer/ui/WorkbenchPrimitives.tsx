import {
    type ComponentPropsWithoutRef,
    type KeyboardEvent as ReactKeyboardEvent,
    type ReactNode,
    type RefObject,
    useEffect,
    useId,
    useRef,
    useState,
} from "react";
import { createPortal } from "react-dom";
import type { DesktopDialogId } from "./dialog-inventory";
import { DesktopIcon, type DesktopIconName } from "./icons";
import { WorkbenchTooltip } from "./WorkbenchTooltip";

function joinClassNames(...values: readonly (string | undefined)[]): string {
    return values.filter((value): value is string => value !== undefined && value.length > 0).join(" ");
}

const TOOLTIP_AUTO_DISMISS_MILLISECONDS = 3_000;

export type WorkbenchBadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";

export interface WorkbenchBadgeProps extends ComponentPropsWithoutRef<"span"> {
    readonly tone?: WorkbenchBadgeTone;
}

export function WorkbenchBadge({ tone = "neutral", className, ...props }: WorkbenchBadgeProps): React.JSX.Element {
    return (
        <span
            className={joinClassNames("workbench-badge", `workbench-badge-${tone}`, className)}
            data-oaam-tone={tone}
            {...props}
        />
    );
}

export type WorkbenchNoticeTone = "note" | "warning" | "danger" | "empty";
export type WorkbenchNoticeSurface = "bounded" | "inline";

export interface WorkbenchNoticeProps extends ComponentPropsWithoutRef<"div"> {
    readonly tone?: WorkbenchNoticeTone;
    readonly surface?: WorkbenchNoticeSurface;
}

export function WorkbenchNotice({
    tone = "note",
    surface = "bounded",
    className,
    ...props
}: WorkbenchNoticeProps): React.JSX.Element {
    return (
        <div
            className={joinClassNames("workbench-notice", `workbench-notice-${tone}`, `workbench-notice-${surface}`, className)}
            data-oaam-tone={tone}
            data-oaam-surface={surface}
            {...props}
        />
    );
}

export type WorkbenchPanelSurface = "bounded" | "section";
export interface WorkbenchPanelProps extends ComponentPropsWithoutRef<"section"> {
    readonly surface?: WorkbenchPanelSurface;
}

export function WorkbenchPanel({ surface = "bounded", className, ...props }: WorkbenchPanelProps): React.JSX.Element {
    return (
        <section
            className={joinClassNames("workbench-panel", `workbench-panel-${surface}`, className)}
            data-oaam-surface={surface}
            {...props}
        />
    );
}

export interface WorkbenchIconButtonProps extends Omit<ComponentPropsWithoutRef<"button">, "aria-label" | "children"> {
    readonly icon: DesktopIconName;
    readonly label: string;
    readonly tooltip?: string;
}

export interface WorkbenchTooltipButtonProps extends ComponentPropsWithoutRef<"button"> {
    readonly tooltip: string;
}

export function WorkbenchTooltipButton({
    tooltip,
    className,
    type = "button",
    onBlur,
    onClick,
    onFocus,
    onKeyDown,
    onPointerEnter,
    onPointerLeave,
    "aria-describedby": ariaDescribedBy,
    children,
    ...props
}: WorkbenchTooltipButtonProps): React.JSX.Element {
    const [focused, setFocused] = useState(false);
    const [hovered, setHovered] = useState(false);
    const [tooltipDismissed, setTooltipDismissed] = useState(false);
    const button = useRef<HTMLButtonElement>(null);
    const tooltipId = useId();
    const tooltipVisible = (focused || hovered) && !tooltipDismissed && tooltip.length > 0;
    useEffect(() => {
        if (!tooltipVisible) return;
        const timeout = window.setTimeout(() => setTooltipDismissed(true), TOOLTIP_AUTO_DISMISS_MILLISECONDS);
        return () => window.clearTimeout(timeout);
    }, [tooltipVisible]);
    const describedBy = [ariaDescribedBy, tooltipVisible ? tooltipId : undefined]
        .filter((value): value is string => value !== undefined && value.length > 0)
        .join(" ");
    return (
        <>
            <button
                {...props}
                type={type}
                className={joinClassNames("workbench-tooltip-button", className)}
                aria-describedby={describedBy.length > 0 ? describedBy : undefined}
                data-tooltip={tooltip}
                ref={button}
                onBlur={(event) => {
                    setFocused(false);
                    setTooltipDismissed(true);
                    onBlur?.(event);
                }}
                onClick={(event) => {
                    setTooltipDismissed(true);
                    onClick?.(event);
                }}
                onFocus={(event) => {
                    setFocused(true);
                    setTooltipDismissed(false);
                    onFocus?.(event);
                }}
                onKeyDown={(event) => {
                    if (event.key === "Escape") setTooltipDismissed(true);
                    onKeyDown?.(event);
                }}
                onPointerEnter={(event) => {
                    setHovered(true);
                    setTooltipDismissed(false);
                    onPointerEnter?.(event);
                }}
                onPointerLeave={(event) => {
                    setHovered(false);
                    setTooltipDismissed(true);
                    onPointerLeave?.(event);
                }}
            >
                {children}
            </button>
            <WorkbenchTooltip anchorRef={button} id={tooltipId} label={tooltip} visible={tooltipVisible} />
        </>
    );
}

export function WorkbenchIconButton({
    icon,
    label,
    tooltip = label,
    className,
    type = "button",
    onBlur,
    onClick,
    onFocus,
    onKeyDown,
    onPointerEnter,
    onPointerLeave,
    "aria-describedby": ariaDescribedBy,
    ...props
}: WorkbenchIconButtonProps): React.JSX.Element {
    const [focused, setFocused] = useState(false);
    const [hovered, setHovered] = useState(false);
    const [tooltipDismissed, setTooltipDismissed] = useState(false);
    const button = useRef<HTMLButtonElement>(null);
    const tooltipId = useId();
    const tooltipVisible = (focused || hovered) && !tooltipDismissed && tooltip.length > 0;
    useEffect(() => {
        if (!tooltipVisible) return;
        const timeout = window.setTimeout(() => setTooltipDismissed(true), TOOLTIP_AUTO_DISMISS_MILLISECONDS);
        return () => window.clearTimeout(timeout);
    }, [tooltipVisible]);
    const describedBy = [ariaDescribedBy, tooltipVisible ? tooltipId : undefined]
        .filter((value): value is string => value !== undefined && value.length > 0)
        .join(" ");
    return (
        <>
            <button
                {...props}
                type={type}
                className={joinClassNames("workbench-icon-button", className)}
                aria-describedby={describedBy.length > 0 ? describedBy : undefined}
                aria-label={label}
                data-tooltip={tooltip}
                ref={button}
                onBlur={(event) => {
                    setFocused(false);
                    setTooltipDismissed(true);
                    onBlur?.(event);
                }}
                onClick={(event) => {
                    setTooltipDismissed(true);
                    onClick?.(event);
                }}
                onFocus={(event) => {
                    setFocused(true);
                    setTooltipDismissed(false);
                    onFocus?.(event);
                }}
                onKeyDown={(event) => {
                    if (event.key === "Escape") setTooltipDismissed(true);
                    onKeyDown?.(event);
                }}
                onPointerEnter={(event) => {
                    setHovered(true);
                    setTooltipDismissed(false);
                    onPointerEnter?.(event);
                }}
                onPointerLeave={(event) => {
                    setHovered(false);
                    setTooltipDismissed(true);
                    onPointerLeave?.(event);
                }}
            >
                <DesktopIcon name={icon} />
            </button>
            <WorkbenchTooltip anchorRef={button} id={tooltipId} label={tooltip} visible={tooltipVisible} />
        </>
    );
}

export interface WorkbenchPressedFilterProps extends Omit<ComponentPropsWithoutRef<"button">, "aria-pressed"> {
    readonly pressed: boolean;
}

export function WorkbenchPressedFilter({
    pressed,
    className,
    type = "button",
    ...props
}: WorkbenchPressedFilterProps): React.JSX.Element {
    return (
        <button {...props} type={type} className={joinClassNames("workbench-pressed-filter", className)} aria-pressed={pressed} />
    );
}

export interface WorkbenchSwitchProps {
    readonly checked: boolean;
    readonly label: string;
    readonly description?: string;
    readonly disabled?: boolean;
    readonly onCheckedChange: (checked: boolean) => void;
    readonly "data-oaam-interaction-entry"?: string;
}

export function WorkbenchSwitch({
    checked,
    label,
    description,
    disabled = false,
    onCheckedChange,
    "data-oaam-interaction-entry": interactionEntry,
}: WorkbenchSwitchProps): React.JSX.Element {
    return (
        <button
            data-oaam-interaction-entry={interactionEntry}
            type="button"
            className="workbench-switch"
            role="switch"
            aria-checked={checked}
            disabled={disabled}
            onClick={() => onCheckedChange(!checked)}
        >
            <span className="workbench-switch-copy">
                <strong>{label}</strong>
                {description === undefined ? null : <small>{description}</small>}
            </span>
            <span aria-hidden="true" className="workbench-switch-track">
                <span className="workbench-switch-thumb" />
            </span>
        </button>
    );
}

export interface WorkbenchSelectableCardProps extends Omit<ComponentPropsWithoutRef<"label">, "onChange"> {
    readonly selected: boolean;
    readonly disabled?: boolean;
    readonly inputLabel?: string;
    readonly onSelectedChange: (selected: boolean) => void;
    readonly selectionMode?: "multiple" | "single";
    readonly selectionName?: string;
    readonly tooltip?: string;
}

export function WorkbenchSelectableCard({
    selected,
    disabled = false,
    inputLabel,
    onSelectedChange,
    selectionMode = "multiple",
    selectionName,
    tooltip,
    className,
    children,
    onBlur,
    onFocus,
    onPointerEnter,
    onPointerLeave,
    tabIndex,
    "aria-describedby": ariaDescribedBy,
    ...props
}: WorkbenchSelectableCardProps): React.JSX.Element {
    const [focused, setFocused] = useState(false);
    const [hovered, setHovered] = useState(false);
    const [tooltipDismissed, setTooltipDismissed] = useState(false);
    const card = useRef<HTMLLabelElement>(null);
    const tooltipId = useId();
    const tooltipVisible = tooltip !== undefined && tooltip.length > 0 && (focused || hovered) && !tooltipDismissed;
    useEffect(() => {
        if (!tooltipVisible) return;
        const timeout = window.setTimeout(() => setTooltipDismissed(true), TOOLTIP_AUTO_DISMISS_MILLISECONDS);
        return () => window.clearTimeout(timeout);
    }, [tooltipVisible]);
    const describedBy = [ariaDescribedBy, tooltipVisible ? tooltipId : undefined]
        .filter((value): value is string => value !== undefined && value.length > 0)
        .join(" ");
    return (
        <>
            <label
                {...props}
                className={joinClassNames("workbench-selectable-card", className)}
                aria-disabled={disabled || undefined}
                aria-describedby={describedBy.length > 0 ? describedBy : undefined}
                data-disabled={disabled || undefined}
                data-selected={selected}
                data-tooltip={tooltip}
                ref={card}
                tabIndex={disabled && tooltip !== undefined ? 0 : tabIndex}
                onBlur={(event) => {
                    setFocused(false);
                    setTooltipDismissed(true);
                    onBlur?.(event);
                }}
                onFocus={(event) => {
                    setFocused(true);
                    setTooltipDismissed(false);
                    onFocus?.(event);
                }}
                onPointerEnter={(event) => {
                    setHovered(true);
                    setTooltipDismissed(false);
                    onPointerEnter?.(event);
                }}
                onPointerLeave={(event) => {
                    setHovered(false);
                    setTooltipDismissed(true);
                    onPointerLeave?.(event);
                }}
            >
                <input
                    className="workbench-semantic-input"
                    type={selectionMode === "single" ? "radio" : "checkbox"}
                    aria-label={inputLabel}
                    checked={selected}
                    disabled={disabled}
                    name={selectionMode === "single" ? selectionName : undefined}
                    onChange={(event) => onSelectedChange(event.currentTarget.checked)}
                />
                {children}
                <span className="workbench-selection-indicator" aria-hidden="true">
                    {selected ? <DesktopIcon name="check" size={14} /> : null}
                </span>
            </label>
            {tooltip === undefined ? null : (
                <WorkbenchTooltip anchorRef={card} id={tooltipId} label={tooltip} visible={tooltipVisible} />
            )}
        </>
    );
}

export interface WorkbenchCheckButtonProps extends Omit<ComponentPropsWithoutRef<"label">, "onChange"> {
    readonly checked: boolean;
    readonly disabled?: boolean;
    readonly inputLabel?: string;
    readonly onCheckedChange: (checked: boolean) => void;
}

export function WorkbenchCheckButton({
    checked,
    disabled = false,
    inputLabel,
    onCheckedChange,
    className,
    children,
    ...props
}: WorkbenchCheckButtonProps): React.JSX.Element {
    return (
        <label
            {...props}
            className={joinClassNames("workbench-check-button", className)}
            data-checked={checked}
            data-disabled={disabled || undefined}
        >
            <input
                className="workbench-semantic-input"
                type="checkbox"
                aria-label={inputLabel}
                checked={checked}
                disabled={disabled}
                onChange={(event) => onCheckedChange(event.currentTarget.checked)}
            />
            <span className="workbench-selection-indicator" aria-hidden="true">
                {checked ? <DesktopIcon name="check" size={14} /> : null}
            </span>
            <span>{children}</span>
        </label>
    );
}

export interface WorkbenchRadioButtonProps extends Omit<ComponentPropsWithoutRef<"label">, "onChange"> {
    readonly checked: boolean;
    readonly disabled?: boolean;
    readonly inputLabel?: string;
    readonly name: string;
    readonly onCheckedChange: () => void;
    readonly value: string;
}

export function WorkbenchRadioButton({
    checked,
    disabled = false,
    inputLabel,
    name,
    onCheckedChange,
    value,
    className,
    children,
    ...props
}: WorkbenchRadioButtonProps): React.JSX.Element {
    return (
        <label
            {...props}
            className={joinClassNames("workbench-radio-button", className)}
            data-checked={checked}
            data-disabled={disabled || undefined}
        >
            <input
                className="workbench-semantic-input"
                type="radio"
                aria-label={inputLabel}
                checked={checked}
                disabled={disabled}
                name={name}
                value={value}
                onChange={() => onCheckedChange()}
            />
            <span className="workbench-radio-indicator" aria-hidden="true">
                {checked ? <span /> : null}
            </span>
            <span>{children}</span>
        </label>
    );
}

export interface WorkbenchConfirmationProps extends Omit<ComponentPropsWithoutRef<"label">, "onChange"> {
    readonly checked: boolean;
    readonly disabled?: boolean;
    readonly onCheckedChange: (checked: boolean) => void;
}

export function WorkbenchConfirmation({
    checked,
    disabled = false,
    onCheckedChange,
    className,
    children,
    ...props
}: WorkbenchConfirmationProps): React.JSX.Element {
    return (
        <label className={joinClassNames("workbench-confirmation", className)} {...props}>
            <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={(event) => onCheckedChange(event.currentTarget.checked)}
            />
            <span>{children}</span>
        </label>
    );
}

export interface WorkbenchSelectOption {
    readonly value: string;
    readonly label: string;
    readonly description?: string;
    readonly disabled?: boolean;
}

export interface WorkbenchSelectProps {
    readonly value: string;
    readonly options: readonly WorkbenchSelectOption[];
    readonly label: string;
    readonly disabled?: boolean;
    readonly onChange: (value: string) => void;
    readonly "data-oaam-interaction-entry"?: string;
}

export function WorkbenchSelect({
    value,
    options,
    label,
    disabled = false,
    onChange,
    "data-oaam-interaction-entry": interactionEntry,
}: WorkbenchSelectProps): React.JSX.Element {
    const [open, setOpen] = useState(false);
    const [placement, setPlacement] = useState<"above" | "below">("below");
    const [activeIndex, setActiveIndex] = useState(() =>
        Math.max(
            0,
            options.findIndex((option) => option.value === value),
        ),
    );
    const root = useRef<HTMLDivElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const typeahead = useRef({ lastAt: 0, value: "" });
    const listboxId = useId();
    const selected = options.find((option) => option.value === value);

    useEffect(() => {
        if (!open) return;
        const closeOutside = (event: PointerEvent): void => {
            if (event.target instanceof Node && root.current?.contains(event.target)) return;
            setOpen(false);
        };
        document.addEventListener("pointerdown", closeOutside, true);
        return () => document.removeEventListener("pointerdown", closeOutside, true);
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const option = root.current?.querySelector<HTMLButtonElement>(`[data-option-index="${activeIndex}"]`);
        option?.focus({ preventScroll: true });
        option?.scrollIntoView?.({ block: "nearest" });
    }, [activeIndex, open]);

    function openListbox(): void {
        const rect = trigger.current?.getBoundingClientRect();
        if (rect !== undefined) {
            const below = window.innerHeight - rect.bottom;
            setPlacement(below < Math.min(240, window.innerHeight / 2) && rect.top > below ? "above" : "below");
        }
        setOpen(true);
    }

    function move(offset: -1 | 1): void {
        if (options.length === 0) return;
        let next = activeIndex;
        for (let count = 0; count < options.length; count += 1) {
            next = (next + offset + options.length) % options.length;
            if (options[next]?.disabled !== true) {
                setActiveIndex(next);
                return;
            }
        }
    }

    function choose(option: WorkbenchSelectOption): void {
        if (option.disabled === true) return;
        onChange(option.value);
        trigger.current?.focus();
        setOpen(false);
    }

    function searchByLabel(key: string): void {
        const now = Date.now();
        const previous = typeahead.current;
        const nextValue = `${now - previous.lastAt <= 700 ? previous.value : ""}${key}`.toLocaleLowerCase();
        typeahead.current = { lastAt: now, value: nextValue };
        const candidates = [nextValue, key.toLocaleLowerCase()];
        for (const candidate of candidates) {
            const match = options.findIndex(
                (option) => option.disabled !== true && option.label.toLocaleLowerCase().startsWith(candidate),
            );
            if (match >= 0) {
                setActiveIndex(match);
                return;
            }
        }
    }

    function handleListboxKey(event: ReactKeyboardEvent<HTMLDivElement>): void {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            const option = options[activeIndex];
            if (option !== undefined) choose(option);
            return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            move(event.key === "ArrowDown" ? 1 : -1);
            return;
        }
        if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            const edge =
                event.key === "Home"
                    ? options.findIndex((option) => option.disabled !== true)
                    : options.map((option) => option.disabled !== true).lastIndexOf(true);
            if (edge >= 0) setActiveIndex(edge);
            return;
        }
        if (event.key === "Escape" || event.key === "Tab") {
            setOpen(false);
            if (event.key === "Escape") {
                event.preventDefault();
                trigger.current?.focus();
            }
            return;
        }
        if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey && event.key.trim() !== "") {
            event.preventDefault();
            searchByLabel(event.key);
        }
    }

    return (
        <div className="workbench-select" data-oaam-interaction-entry={interactionEntry} ref={root}>
            <button
                type="button"
                className="workbench-select-trigger"
                role="combobox"
                aria-controls={listboxId}
                aria-expanded={open}
                aria-haspopup="listbox"
                aria-label={label}
                disabled={disabled}
                ref={trigger}
                onClick={() => {
                    const selectedIndex = options.findIndex((option) => option.value === value);
                    setActiveIndex(Math.max(0, selectedIndex));
                    if (open) setOpen(false);
                    else openListbox();
                }}
                onKeyDown={(event) => {
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                        event.preventDefault();
                        const selectedIndex = options.findIndex((option) => option.value === value);
                        setActiveIndex(Math.max(0, selectedIndex));
                        openListbox();
                        return;
                    }
                    if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey && event.key.trim() !== "") {
                        event.preventDefault();
                        searchByLabel(event.key);
                        openListbox();
                    }
                }}
            >
                <span>{selected?.label ?? value}</span>
                <DesktopIcon name="chevron_down" size={14} />
            </button>
            {open ? (
                <div
                    className="workbench-select-listbox"
                    id={listboxId}
                    role="listbox"
                    aria-label={label}
                    data-placement={placement}
                    onKeyDown={handleListboxKey}
                >
                    {options.map((option, index) => (
                        <button
                            type="button"
                            role="option"
                            aria-selected={option.value === value}
                            className="workbench-select-option"
                            data-option-index={index}
                            disabled={option.disabled}
                            key={option.value}
                            onClick={() => choose(option)}
                        >
                            <span>
                                <strong>{option.label}</strong>
                                {option.description === undefined ? null : <small>{option.description}</small>}
                            </span>
                            {option.value === value ? <DesktopIcon name="check" size={14} /> : null}
                        </button>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

export interface WorkbenchDialogProps {
    readonly dialogId: DesktopDialogId;
    readonly title: string;
    readonly children: ReactNode;
    readonly closeLabel: string;
    readonly className?: string;
    readonly dismissible?: boolean;
    readonly initialFocusRef?: RefObject<HTMLElement | null>;
    readonly onClose: () => void;
    readonly "data-oaam-interaction-entry"?: string;
}

export function WorkbenchDialog({
    dialogId,
    title,
    children,
    closeLabel,
    className,
    dismissible = true,
    initialFocusRef,
    onClose,
    "data-oaam-interaction-entry": interactionEntry,
}: WorkbenchDialogProps): React.JSX.Element {
    const titleId = useId();
    const dialog = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
        const requestedFocus = initialFocusRef?.current;
        if (requestedFocus !== null && requestedFocus !== undefined && dialog.current?.contains(requestedFocus)) {
            requestedFocus.focus({ preventScroll: true });
        } else {
            const defaultFocus = dialog.current?.querySelector<HTMLElement>(
                "button:not(:disabled),[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex='-1'])",
            );
            (defaultFocus ?? dialog.current)?.focus({ preventScroll: true });
        }
        return () => {
            if (previouslyFocused?.isConnected === true) previouslyFocused.focus({ preventScroll: true });
        };
    }, [initialFocusRef]);

    function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
        if (event.key === "Escape" && dismissible) {
            event.preventDefault();
            onClose();
            return;
        }
        if (event.key !== "Tab") return;
        const focusable = [
            ...(dialog.current?.querySelectorAll<HTMLElement>(
                "button:not(:disabled),[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex='-1'])",
            ) ?? []),
        ];
        if (focusable.length === 0) {
            event.preventDefault();
            return;
        }
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus({ preventScroll: true });
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus({ preventScroll: true });
        }
    }

    return createPortal(
        <div className="workbench-dialog-backdrop" data-oaam-dialog-backdrop onPointerDown={dismissible ? onClose : undefined}>
            <div
                className={joinClassNames("workbench-dialog", className)}
                data-oaam-dialog={dialogId}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                ref={dialog}
                tabIndex={-1}
                onKeyDown={handleKeyDown}
                onPointerDown={(event) => event.stopPropagation()}
            >
                <header>
                    <h2 id={titleId}>{title}</h2>
                    <WorkbenchIconButton
                        data-oaam-interaction-entry={interactionEntry}
                        icon="close"
                        label={closeLabel}
                        disabled={!dismissible}
                        onClick={onClose}
                    />
                </header>
                <div className="workbench-dialog-body">{children}</div>
            </div>
        </div>,
        document.body,
    );
}
