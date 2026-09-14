import { Component, type ErrorInfo, type ReactNode } from "react";
import type { DesktopRendererDiagnosticInput } from "../../bridge/desktop-renderer-diagnostics";
import { useDesktopPresentation } from "../presentation";

interface RendererFailureBoundaryCoreProps {
    readonly children: ReactNode;
    readonly copy: {
        readonly action: string;
        readonly copy: string;
        readonly eyebrow: string;
        readonly retryFailed: string;
        readonly restarting: string;
        readonly title: string;
    };
    readonly onDiagnostic?: (input: DesktopRendererDiagnosticInput) => Promise<void>;
    readonly onRecover: () => Promise<void>;
}

interface RendererFailureBoundaryCoreState {
    readonly failed: boolean;
    readonly failureKind?: "render" | "window_error" | "unhandled_rejection";
    readonly recovering: boolean;
    readonly recoveryFailed: boolean;
}

const RENDERER_SURFACES = new Set<DesktopRendererDiagnosticInput["surface"]>([
    "startup",
    "onboarding",
    "guided_import",
    "library",
    "sources",
    "deployment",
    "settings",
    "recovery_settings",
]);

export function currentRendererSurface(): DesktopRendererDiagnosticInput["surface"] {
    const route = document.querySelector<HTMLElement>("[data-oaam-route]")?.dataset.oaamRoute;
    return route !== undefined && RENDERER_SURFACES.has(route as DesktopRendererDiagnosticInput["surface"])
        ? (route as DesktopRendererDiagnosticInput["surface"])
        : "unknown";
}

export function boundedRendererComponentTrail(info: ErrorInfo): readonly string[] {
    const trail: string[] = [];
    for (const line of (info.componentStack ?? "").split("\n")) {
        const component = /^\s*at\s+([A-Za-z_$][A-Za-z0-9_$.-]*)(?:\s|\(|$)/u.exec(line)?.[1];
        if (component === undefined || trail.includes(component)) continue;
        trail.push(component);
        if (trail.length === 8) break;
    }
    return Object.freeze(trail);
}

export class RendererFailureBoundaryCore extends Component<RendererFailureBoundaryCoreProps, RendererFailureBoundaryCoreState> {
    public state: RendererFailureBoundaryCoreState = {
        failed: false,
        recovering: false,
        recoveryFailed: false,
    };

    public static getDerivedStateFromError(): RendererFailureBoundaryCoreState {
        return { failed: true, failureKind: "render", recovering: false, recoveryFailed: false };
    }

    readonly #captureWindowError = (event: ErrorEvent): void => {
        event.preventDefault();
        this.#recordDiagnostic("failure", "window_error", []);
        this.setState({ failed: true, failureKind: "window_error", recovering: false, recoveryFailed: false });
    };

    readonly #captureUnhandledRejection = (event: PromiseRejectionEvent): void => {
        event.preventDefault();
        this.#recordDiagnostic("failure", "unhandled_rejection", []);
        this.setState({ failed: true, failureKind: "unhandled_rejection", recovering: false, recoveryFailed: false });
    };

    public componentDidMount(): void {
        window.addEventListener("error", this.#captureWindowError);
        window.addEventListener("unhandledrejection", this.#captureUnhandledRejection);
    }

    public componentWillUnmount(): void {
        window.removeEventListener("error", this.#captureWindowError);
        window.removeEventListener("unhandledrejection", this.#captureUnhandledRejection);
    }

    public componentDidCatch(_error: Error, info: ErrorInfo): void {
        this.#recordDiagnostic("failure", "render", boundedRendererComponentTrail(info));
    }

    readonly #recordDiagnostic = (
        event: DesktopRendererDiagnosticInput["event"],
        failureKind: DesktopRendererDiagnosticInput["failureKind"],
        componentTrail: readonly string[],
    ): void => {
        const input: DesktopRendererDiagnosticInput = Object.freeze({
            event,
            failureKind,
            surface: currentRendererSurface(),
            componentTrail,
        });
        try {
            void Promise.resolve(this.props.onDiagnostic?.(input)).catch(() => undefined);
        } catch {
            // Diagnostic delivery cannot replace the friendly recovery surface with another failure.
        }
    };

    readonly #recover = async (): Promise<void> => {
        if (this.state.recovering) return;
        const failureKind = this.state.failureKind ?? "render";
        this.#recordDiagnostic("recovery_started", failureKind, []);
        this.setState({ failed: true, failureKind: this.state.failureKind, recovering: true, recoveryFailed: false });
        try {
            await this.props.onRecover();
            this.#recordDiagnostic("recovery_dispatched", failureKind, []);
            this.setState({ failed: false, failureKind: undefined, recovering: false, recoveryFailed: false });
        } catch {
            this.#recordDiagnostic("recovery_failed", failureKind, []);
            this.setState({ failed: true, failureKind: this.state.failureKind, recovering: false, recoveryFailed: true });
        }
    };

    public render(): ReactNode {
        if (!this.state.failed) return this.props.children;
        return (
            <main
                className="renderer-failure-screen"
                data-oaam-renderer-failure
                data-oaam-renderer-failure-kind={this.state.failureKind}
            >
                <section role="alert">
                    <p className="eyebrow">{this.props.copy.eyebrow}</p>
                    <h1>{this.props.copy.title}</h1>
                    <p>{this.props.copy.copy}</p>
                    {this.state.recoveryFailed ? <p>{this.props.copy.retryFailed}</p> : null}
                    <button
                        data-oaam-interaction-entry="app.renderer_failure_boundary.001"
                        type="button"
                        disabled={this.state.recovering}
                        onClick={() => void this.#recover()}
                    >
                        {this.state.recovering ? this.props.copy.restarting : this.props.copy.action}
                    </button>
                </section>
            </main>
        );
    }
}

export function RendererFailureBoundary({
    children,
    onDiagnostic,
    onRecover,
}: {
    readonly children: ReactNode;
    readonly onDiagnostic?: (input: DesktopRendererDiagnosticInput) => Promise<void>;
    readonly onRecover: () => Promise<void>;
}): React.JSX.Element {
    const { text } = useDesktopPresentation();
    return (
        <RendererFailureBoundaryCore
            copy={{
                action: text("renderer.failure.action"),
                copy: text("renderer.failure.copy"),
                eyebrow: text("renderer.failure.eyebrow"),
                retryFailed: text("renderer.failure.retry_failed"),
                restarting: text("renderer.failure.restarting"),
                title: text("renderer.failure.title"),
            }}
            onDiagnostic={onDiagnostic}
            onRecover={onRecover}
        >
            {children}
        </RendererFailureBoundaryCore>
    );
}
