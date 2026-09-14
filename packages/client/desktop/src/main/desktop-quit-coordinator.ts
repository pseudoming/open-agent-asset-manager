import type { UtilityHostSupervisorEvent, UtilityHostSupervisorState } from "./utility-host-supervisor";

/** Desktop may exit only after the Host's actual shutdown acknowledgement. */
export class DesktopQuitCoordinator {
    #attempt: "idle" | "pending" | "failed" = "idle";
    #performanceFinished = false;

    public constructor(
        private readonly dependencies: {
            finishPerformance(): Promise<void>;
            hostState(): UtilityHostSupervisorState;
            subscribeHost(listener: (event: UtilityHostSupervisorEvent) => void): () => void;
            shutdownHost(): void;
            onStart(): void;
            onStopped(): void;
            onFailure(): void;
            onPerformanceFailure(): void;
            performanceDeadlineMs?: number;
            hostDeadlineMs?: number;
        },
    ) {}

    public beforeQuit(event: { preventDefault(): void }): void {
        const state = this.dependencies.hostState();
        if (this.#performanceFinished && state === "stopped") return;
        event.preventDefault();
        if (this.#attempt === "pending" || (this.#attempt === "failed" && state !== "ready" && state !== "starting")) return;
        this.#attempt = "pending";
        this.dependencies.onStart();
        void this.#finish();
    }

    async #finish(): Promise<void> {
        if (!this.#performanceFinished) {
            await this.#finishPerformance();
            this.#performanceFinished = true;
        }
        try {
            await this.#finishHost();
            this.#attempt = "idle";
            this.dependencies.onStopped();
        } catch {
            this.#attempt = "failed";
            this.dependencies.onFailure();
        }
    }

    #finishPerformance(): Promise<void> {
        return new Promise((resolve) => {
            let complete = false;
            const finish = (failed: boolean) => {
                if (complete) return;
                complete = true;
                clearTimeout(timer);
                if (failed) this.dependencies.onPerformanceFailure();
                resolve();
            };
            const timer = setTimeout(() => finish(true), this.dependencies.performanceDeadlineMs ?? 10_000);
            timer.unref?.();
            try {
                void this.dependencies.finishPerformance().then(
                    () => finish(false),
                    () => finish(true),
                );
            } catch {
                finish(true);
            }
        });
    }

    #finishHost(): Promise<void> {
        if (this.dependencies.hostState() === "stopped") return Promise.resolve();
        return new Promise((resolve, reject) => {
            let unsubscribe: () => void = () => undefined;
            let requested = false;
            let complete = false;
            const finish = (failed: boolean) => {
                if (complete) return;
                complete = true;
                clearTimeout(timer);
                unsubscribe();
                if (failed) reject(new Error("Desktop Host shutdown was not acknowledged"));
                else resolve();
            };
            // This is an error-reporting bound, never permission to quit or evidence of cleanup.
            // It includes the restricted process owner's existing ten-minute hard lifetime.
            const timer = setTimeout(() => finish(true), this.dependencies.hostDeadlineMs ?? 610_000);
            timer.unref?.();
            unsubscribe = this.dependencies.subscribeHost((event) => {
                if (event.state === "stopped") finish(false);
                else if (requested && event.state === "failed") finish(true);
            });
            if (complete) {
                unsubscribe();
                return;
            }
            requested = true;
            try {
                this.dependencies.shutdownHost();
                if (this.dependencies.hostState() === "failed") finish(true);
            } catch {
                finish(true);
            }
        });
    }
}
