export {
    PACKAGED_RUNTIME_SINGLE_INSTANCE_PROBE_SWITCH,
    PACKAGED_RUNTIME_SMOKE_SWITCH,
    PACKAGED_STARTUP_RECOVERY_SMOKE_SWITCH,
} from "./packaged-proof-launch-authority";
export const PACKAGED_RUNTIME_READY_LINE = "OAAM_DESKTOP_RUNTIME_SMOKE initialize=ok asset.list=empty renderer=ready";
export const PACKAGED_RUNTIME_ONBOARDING_LINE =
    "OAAM_DESKTOP_RUNTIME_SMOKE onboarding-import=complete asset.list=1 deployment=not-run";
export const PACKAGED_RUNTIME_SINGLE_INSTANCE_LINE = "OAAM_DESKTOP_RUNTIME_SMOKE single-instance=blocked primary=focused";
export const PACKAGED_RUNTIME_STOPPED_LINE = "OAAM_DESKTOP_RUNTIME_SMOKE host=stopped app=closing";
export const PACKAGED_STARTUP_RECOVERY_LINE = "OAAM_DESKTOP_STARTUP_RECOVERY_SMOKE first=timed-out replacement=ready";

const READY_PROBE_SCRIPT = `(() => {
    const root = document.querySelector("main[data-oaam-state]");
    if (!(root instanceof HTMLElement)) return null;
    return {
        state: root.dataset.oaamState ?? "",
        assetCount: root.dataset.oaamAssetCount ?? "",
    };
})()`;

export interface DesktopRuntimeSmokeWebContents {
    executeJavaScript(script: string): Promise<unknown>;
}

export interface DesktopSecondInstanceProbe {
    readonly completed: Promise<number | null>;
    terminate(): void;
}

export interface DesktopRuntimeSmokeDependencies {
    readonly writeOutput: (text: string) => void;
    readonly writeError: (text: string) => void;
    readonly requestQuit: (failed: boolean) => void;
    readonly proveOnboardingImport?: () => Promise<void>;
    readonly startSecondInstanceProbe?: () => DesktopSecondInstanceProbe;
    readonly schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    readonly cancel?: (handle: ReturnType<typeof setTimeout>) => void;
}

type DesktopRuntimeSmokeState =
    | "disabled"
    | "idle"
    | "probing"
    | "proving_onboarding"
    | "awaiting_second_instance"
    | "shutdown_requested"
    | "failed"
    | "complete";

export class DesktopRuntimeSmokeController {
    readonly #enabled: boolean;
    readonly #dependencies: DesktopRuntimeSmokeDependencies;
    readonly #pollIntervalMs: number;
    readonly #timeoutMs: number;
    #state: DesktopRuntimeSmokeState;
    #startedAt = 0;
    #lastRendererState = "unobserved";
    #lastHostState = "unobserved";
    #timer: ReturnType<typeof setTimeout> | undefined;
    #webContents: DesktopRuntimeSmokeWebContents | undefined;
    #secondInstanceProbe: DesktopSecondInstanceProbe | undefined;
    #secondInstanceObserved = false;
    #secondInstanceProbeCompleted = false;

    public constructor(
        enabled: boolean,
        dependencies: DesktopRuntimeSmokeDependencies,
        options: { readonly pollIntervalMs?: number; readonly timeoutMs?: number } = {},
    ) {
        this.#enabled = enabled;
        this.#dependencies = dependencies;
        this.#pollIntervalMs = options.pollIntervalMs ?? 50;
        this.#timeoutMs = options.timeoutMs ?? 15_000;
        this.#state = enabled ? "idle" : "disabled";
    }

    public observe(webContents: DesktopRuntimeSmokeWebContents): void {
        if (!this.#enabled) return;
        if (this.#state !== "idle") throw new Error("Desktop runtime smoke can observe only one packaged window");
        this.#state = "probing";
        this.#startedAt = Date.now();
        this.#webContents = webContents;
        void this.#poll();
    }

    public hostStopped(): void {
        if (this.#state !== "shutdown_requested") return;
        this.#state = "complete";
        this.#dependencies.writeOutput(`${PACKAGED_RUNTIME_STOPPED_LINE}\n`);
    }

    public secondInstanceObserved(): void {
        if (!this.#enabled || (this.#state !== "probing" && this.#state !== "awaiting_second_instance")) return;
        this.#secondInstanceObserved = true;
        this.#completeSecondInstanceProof();
    }

    public observeHostState(state: "stopped" | "starting" | "ready" | "draining" | "failed"): void {
        if (!this.#enabled || this.#state === "complete") return;
        this.#lastHostState = state;
    }

    public dispose(): void {
        if (this.#timer !== undefined) {
            (this.#dependencies.cancel ?? clearTimeout)(this.#timer);
            this.#timer = undefined;
        }
        this.#secondInstanceProbe?.terminate();
        this.#secondInstanceProbe = undefined;
        this.#webContents = undefined;
    }

    async #poll(): Promise<void> {
        if (this.#state !== "probing" || this.#webContents === undefined) return;
        let result: unknown;
        try {
            result = await this.#webContents.executeJavaScript(READY_PROBE_SCRIPT);
        } catch {
            result = null;
        }
        if (this.#state !== "probing") return;
        this.#lastRendererState = rendererStateName(result);
        if (isExactReadyProjection(result)) {
            this.#state = "proving_onboarding";
            this.#dependencies.writeOutput(`${PACKAGED_RUNTIME_READY_LINE}\n`);
            void this.#proveOnboardingImport();
            return;
        }
        if (isFailedProjection(result)) {
            this.#fail(`renderer=${result.state}`);
            return;
        }
        if (Date.now() - this.#startedAt >= this.#timeoutMs) {
            this.#fail(`timeout_renderer=${this.#lastRendererState}_host=${this.#lastHostState}`);
            return;
        }
        this.#timer = (this.#dependencies.schedule ?? setTimeout)(() => {
            this.#timer = undefined;
            void this.#poll();
        }, this.#pollIntervalMs);
        this.#timer.unref?.();
    }

    async #proveOnboardingImport(): Promise<void> {
        if (this.#state !== "proving_onboarding") return;
        const prove = this.#dependencies.proveOnboardingImport;
        if (prove === undefined) {
            this.#fail("onboarding_import_proof_unavailable");
            return;
        }
        const remainingMs = Math.max(0, this.#timeoutMs - (Date.now() - this.#startedAt));
        this.#timer = (this.#dependencies.schedule ?? setTimeout)(() => {
            this.#timer = undefined;
            this.#fail("timeout_onboarding_import");
        }, remainingMs);
        this.#timer.unref?.();
        try {
            await prove();
        } catch {
            if (this.#state === "proving_onboarding") this.#fail("onboarding_import_failed");
            return;
        }
        if (this.#state !== "proving_onboarding") return;
        if (this.#timer !== undefined) {
            (this.#dependencies.cancel ?? clearTimeout)(this.#timer);
            this.#timer = undefined;
        }
        this.#dependencies.writeOutput(`${PACKAGED_RUNTIME_ONBOARDING_LINE}\n`);
        this.#state = "awaiting_second_instance";
        this.#startSecondInstanceProof();
    }

    #fail(reason: string): void {
        this.#state = "failed";
        if (this.#timer !== undefined) {
            (this.#dependencies.cancel ?? clearTimeout)(this.#timer);
            this.#timer = undefined;
        }
        this.#secondInstanceProbe?.terminate();
        this.#dependencies.writeError(`OAAM_DESKTOP_RUNTIME_SMOKE failed=${reason}\n`);
        this.#dependencies.requestQuit(true);
    }

    #startSecondInstanceProof(): void {
        const startProbe = this.#dependencies.startSecondInstanceProbe;
        if (startProbe === undefined) {
            this.#fail("second_instance_probe_unavailable");
            return;
        }
        try {
            this.#secondInstanceProbe = startProbe();
        } catch {
            this.#fail("second_instance_probe_start_failed");
            return;
        }
        const remainingMs = Math.max(0, this.#timeoutMs - (Date.now() - this.#startedAt));
        this.#timer = (this.#dependencies.schedule ?? setTimeout)(() => {
            this.#timer = undefined;
            this.#fail(
                `timeout_second_instance_event=${this.#secondInstanceObserved ? "observed" : "missing"}_probe=${
                    this.#secondInstanceProbeCompleted ? "exited" : "running"
                }`,
            );
        }, remainingMs);
        this.#timer.unref?.();
        void this.#secondInstanceProbe.completed.then(
            (exitCode) => {
                if (this.#state !== "awaiting_second_instance") return;
                if (exitCode !== 0) {
                    this.#fail(`second_instance_probe_exit=${exitCode === null ? "signal" : String(exitCode)}`);
                    return;
                }
                this.#secondInstanceProbeCompleted = true;
                this.#completeSecondInstanceProof();
            },
            () => {
                if (this.#state === "awaiting_second_instance") this.#fail("second_instance_probe_failed");
            },
        );
    }

    #completeSecondInstanceProof(): void {
        if (this.#state !== "awaiting_second_instance" || !this.#secondInstanceObserved || !this.#secondInstanceProbeCompleted) {
            return;
        }
        if (this.#timer !== undefined) {
            (this.#dependencies.cancel ?? clearTimeout)(this.#timer);
            this.#timer = undefined;
        }
        this.#state = "shutdown_requested";
        this.#dependencies.writeOutput(`${PACKAGED_RUNTIME_SINGLE_INSTANCE_LINE}\n`);
        this.#dependencies.requestQuit(false);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExactReadyProjection(value: unknown): boolean {
    return isRecord(value) && Object.keys(value).length === 2 && value.state === "ready" && value.assetCount === "0";
}

function rendererStateName(value: unknown): string {
    if (
        isRecord(value) &&
        (value.state === "starting" ||
            value.state === "failed" ||
            value.state === "client_unavailable" ||
            value.state === "ready")
    ) {
        return value.state;
    }
    return "unavailable";
}

function isFailedProjection(value: unknown): value is { readonly state: string } {
    return isRecord(value) && (value.state === "failed" || value.state === "client_unavailable");
}
