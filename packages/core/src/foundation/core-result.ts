/** Exact runtime-neutral constructors for Core operation result envelopes. */
import type { CoreResult } from "../contracts/core-service";

export function completeResult<T>(value: T): CoreResult<T> {
    return { status: "complete", value, diagnostics: [] };
}
