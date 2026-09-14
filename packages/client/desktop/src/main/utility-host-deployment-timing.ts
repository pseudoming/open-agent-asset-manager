/** Receive only the optional fixed-field Core deployment timings from the utility Host pipe. */
import { debuglog } from "node:util";

const trace = debuglog("oaam-deployment");
const TIMING_LINE =
    /^OAAM-DEPLOYMENT \d+: stage=(?:publication|verification|commit|finalization|journal_cleanup) start_ms=\d+\.\d{3} end_ms=\d+\.\d{3} duration_ms=\d+\.\d{3}$/u;

export function forwardUtilityDeploymentTiming(
    stderr: NodeJS.ReadableStream | null,
    write: (line: string) => void = (line) => {
        process.stderr.write(line);
    },
): () => void {
    if (!trace.enabled || stderr === null) return () => {};
    let pending = "",
        dropping = false;
    const onData = (chunk: Buffer) => {
        const parts = chunk.toString("utf8").split("\n");
        for (let index = 0; index < parts.length; index += 1) {
            const part = parts[index]!;
            if (!dropping) {
                if (pending.length + part.length > 512) {
                    pending = "";
                    dropping = true;
                } else pending += part;
            }
            if (index === parts.length - 1) continue;
            if (!dropping && TIMING_LINE.test(pending)) {
                try {
                    write(pending + "\n");
                } catch {
                    /* Optional diagnostics cannot change Host supervision. */
                }
            }
            pending = "";
            dropping = false;
        }
    };
    stderr.on("data", onData);
    return () => {
        stderr.off("data", onData);
        pending = "";
    };
}
