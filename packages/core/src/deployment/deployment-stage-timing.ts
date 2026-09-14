/** Optional fixed-field timings for the existing synchronous deployment stages. */
import { performance } from "node:perf_hooks";
import { debuglog } from "node:util";

const trace = debuglog("oaam-deployment");
type DeploymentStage = "publication" | "verification" | "commit" | "finalization" | "journal_cleanup";

export function measureDeploymentStage<T>(stage: DeploymentStage, action: () => T): T {
    if (!trace.enabled) return action();
    const started = performance.now();
    try {
        return action();
    } finally {
        const ended = performance.now();
        try {
            trace(
                "stage=%s start_ms=%s end_ms=%s duration_ms=%s",
                stage,
                started.toFixed(3),
                ended.toFixed(3),
                (ended - started).toFixed(3),
            );
        } catch {
            // Optional diagnostics must preserve the stage's original result or exception.
        }
    }
}
