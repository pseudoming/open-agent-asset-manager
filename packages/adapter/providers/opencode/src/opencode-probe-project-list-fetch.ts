import type { OpenCodeBoundedInvocationResult } from "./opencode-probe-local-invocation";

export async function fetchOpenCodeProjectsBounded(
    endpoint: string,
    options: {
        readonly authorizationHeader: string | undefined;
        readonly timeoutMilliseconds: number;
        readonly maximumOutputBytes: number;
    },
    fetchImplementation: typeof fetch = fetch,
): Promise<OpenCodeBoundedInvocationResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMilliseconds);
    try {
        const response = await fetchImplementation(endpoint, {
            method: "GET",
            headers: {
                Accept: "application/json",
                ...(options.authorizationHeader === undefined ? {} : { Authorization: options.authorizationHeader }),
            },
            redirect: "error",
            signal: controller.signal,
        });
        if (!response.ok) {
            return {
                status: response.status === 429 || response.status >= 500 ? "transient" : "failed",
                stdout: new Uint8Array(),
                failureCode: `http_${response.status}`,
            };
        }
        if (response.body === null) return { status: "failed", stdout: new Uint8Array(), failureCode: "empty_body" };
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > options.maximumOutputBytes) {
                await reader.cancel();
                return { status: "failed", stdout: new Uint8Array(), failureCode: "output_limit" };
            }
            chunks.push(next.value);
        }
        const stdout = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            stdout.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return { status: "complete", stdout, failureCode: "" };
    } catch {
        return { status: "transient", stdout: new Uint8Array(), failureCode: "network" };
    } finally {
        clearTimeout(timer);
    }
}
