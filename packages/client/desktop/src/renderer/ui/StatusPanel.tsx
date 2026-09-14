import { type ReactNode, useId } from "react";
import { DesktopIcon } from "./icons";

export interface StatusPanelProps {
    readonly eyebrow?: string;
    readonly title: string;
    readonly message?: string;
    readonly busy?: boolean;
    readonly className?: string;
    readonly compact?: boolean;
    readonly tone?: "neutral" | "danger";
    readonly children?: ReactNode;
}

export function StatusPanel({
    eyebrow,
    title,
    message,
    busy = false,
    className,
    compact = false,
    tone = "neutral",
    children,
}: StatusPanelProps): React.JSX.Element {
    const titleId = useId();
    const classes = ["status-card", compact ? "status-card-compact" : undefined, className].filter(Boolean).join(" ");
    return (
        <section
            className={classes}
            aria-busy={busy}
            aria-labelledby={titleId}
            data-oaam-tone={tone}
            role={tone === "danger" ? "alert" : undefined}
        >
            {eyebrow === undefined ? null : <p className="eyebrow">{eyebrow}</p>}
            <div
                className="status-card-title-row"
                role={busy && message === undefined ? "status" : undefined}
                aria-live={busy && message === undefined ? "polite" : undefined}
            >
                <h2 id={titleId}>{title}</h2>
                {busy ? (
                    <span className="status-card-spinner" data-oaam-loading-indicator>
                        <DesktopIcon name="loading" size={18} />
                    </span>
                ) : null}
            </div>
            {message === undefined ? null : (
                <p role={busy ? "status" : undefined} aria-live={busy ? "polite" : undefined}>
                    {message}
                </p>
            )}
            {children}
        </section>
    );
}
