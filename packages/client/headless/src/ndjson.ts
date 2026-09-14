import type { Writable } from "node:stream";
import { stringifyProtocolJson } from "@oaam/app-server-protocol";

const DEFAULT_MAXIMUM_LINE_BYTES = 1024 * 1024;

export class HeadlessNdjsonError extends Error {
    public constructor() {
        super("Headless input is not bounded UTF-8 NDJSON");
        this.name = "HeadlessNdjsonError";
    }
}

function decodeLine(chunks: readonly Uint8Array[], byteLength: number): string {
    const bytes = Buffer.concat(
        chunks.map((chunk) => Buffer.from(chunk)),
        byteLength,
    );
    const content = bytes.byteLength > 0 && bytes[bytes.byteLength - 1] === 0x0d ? bytes.subarray(0, -1) : bytes;
    if (content.byteLength === 0) throw new HeadlessNdjsonError();
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
        throw new HeadlessNdjsonError();
    }
}

export async function* readBoundedNdjsonLines(
    input: AsyncIterable<Uint8Array | string>,
    maximumLineBytes = DEFAULT_MAXIMUM_LINE_BYTES,
): AsyncGenerator<string> {
    if (!Number.isSafeInteger(maximumLineBytes) || maximumLineBytes < 1)
        throw new RangeError("NDJSON line bound must be positive");
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    for await (const rawChunk of input) {
        const chunk = typeof rawChunk === "string" ? Buffer.from(rawChunk, "utf8") : rawChunk;
        let start = 0;
        for (let index = 0; index < chunk.byteLength; index += 1) {
            if (chunk[index] !== 0x0a) continue;
            const segment = chunk.subarray(start, index);
            if (pendingBytes + segment.byteLength > maximumLineBytes) throw new HeadlessNdjsonError();
            pending.push(segment);
            yield decodeLine(pending, pendingBytes + segment.byteLength);
            pending = [];
            pendingBytes = 0;
            start = index + 1;
        }
        const remainder = chunk.subarray(start);
        if (pendingBytes + remainder.byteLength > maximumLineBytes) throw new HeadlessNdjsonError();
        if (remainder.byteLength > 0) pending.push(remainder);
        pendingBytes += remainder.byteLength;
    }
    if (pendingBytes > 0) yield decodeLine(pending, pendingBytes);
}

export class SerializedProtocolWriter {
    readonly #output: Writable;
    #tail: Promise<void> = Promise.resolve();
    #failure: unknown;

    public constructor(output: Writable) {
        this.#output = output;
    }

    public enqueue(record: unknown): void {
        this.#tail = this.#tail
            .then(() => this.#write(`${stringifyProtocolJson(record)}\n`))
            .catch((error: unknown) => {
                this.#failure ??= error;
            });
    }

    public async finish(): Promise<void> {
        await this.#tail;
        if (this.#failure !== undefined) throw this.#failure;
    }

    #write(text: string): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                this.#output.write(text, "utf8", (error) => {
                    if (error === null || error === undefined) resolve();
                    else reject(error);
                });
            } catch (error) {
                reject(error);
            }
        });
    }
}
