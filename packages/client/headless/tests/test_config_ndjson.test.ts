import * as path from "node:path";
import type { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { HeadlessConfigurationError, parseHeadlessArguments, parseHeadlessArgumentsWithHostPathForTest } from "../src/config";
import { HeadlessNdjsonError, readBoundedNdjsonLines, SerializedProtocolWriter } from "../src/ndjson";

const POSIX_ARGUMENTS = Object.freeze([
    "--oaam-root",
    "/tmp/oaam-state",
    "--database-path",
    "/tmp/oaam-state/oaam.sqlite",
    "--platform",
    "linux",
    "--platform-instance-id",
    "local-linux",
    "--access-root",
    "/tmp/project",
]);
const WSL_ACCESS_ROOT = `${String.raw`\\wsl.localhost\Ubuntu`}\\`;
const WINDOWS_ARGUMENTS = Object.freeze([
    "--oaam-root",
    String.raw`C:\oaam\state`,
    "--database-path",
    String.raw`C:\oaam\state\oaam.sqlite`,
    "--platform",
    "win32",
    "--platform-instance-id",
    "desktop-local",
    "--access-root",
    "C:\\",
]);

function replaceArgument(arguments_: readonly string[], option: string, value: string): string[] {
    const next = [...arguments_];
    const index = next.indexOf(option);
    next[index + 1] = value;
    return next;
}

async function collectLines(input: AsyncIterable<Uint8Array | string>, maximum?: number): Promise<string[]> {
    const lines: string[] = [];
    for await (const line of readBoundedNdjsonLines(input, maximum)) lines.push(line);
    return lines;
}

function fakeWritable(write: (text: string, encoding: string, callback: (error?: Error | null) => void) => boolean): Writable {
    return { write } as unknown as Writable;
}

describe("Headless launch configuration", () => {
    it("requires explicit canonical state, database, platform identity, and access roots", () => {
        expect(parseHeadlessArguments(POSIX_ARGUMENTS)).toEqual({
            oaamRoot: "/tmp/oaam-state",
            databasePath: "/tmp/oaam-state/oaam.sqlite",
            platformContexts: [
                {
                    platform: "linux",
                    platformInstanceId: "local-linux",
                    accessRootPath: "/tmp/project",
                },
            ],
        });
        expect(
            parseHeadlessArgumentsWithHostPathForTest(
                replaceArgument(WINDOWS_ARGUMENTS, "--access-root", String.raw`C:\Users\tester\project`),
                path.win32,
            ).platformContexts[0],
        ).toEqual({
            platform: "win32",
            platformInstanceId: "desktop-local",
            accessRootPath: String.raw`C:\Users\tester\project`,
        });
        expect(
            parseHeadlessArgumentsWithHostPathForTest(
                replaceArgument(replaceArgument(WINDOWS_ARGUMENTS, "--platform", "wsl"), "--access-root", WSL_ACCESS_ROOT),
                path.win32,
            ).platformContexts[0],
        ).toEqual({
            platform: "wsl",
            platformInstanceId: "desktop-local",
            accessRootPath: WSL_ACCESS_ROOT,
        });
        expect(() => parseHeadlessArguments(replaceArgument(POSIX_ARGUMENTS, "--access-root", WSL_ACCESS_ROOT))).toThrow(
            HeadlessConfigurationError,
        );
        for (const selectedPlatform of ["darwin", "wsl"] as const) {
            expect(
                parseHeadlessArguments(replaceArgument(POSIX_ARGUMENTS, "--platform", selectedPlatform)).platformContexts[0]
                    .platform,
            ).toBe(selectedPlatform);
        }
    });

    it.each([
        ["unknown option", ["--unknown", "value"]],
        ["missing value", [...POSIX_ARGUMENTS.slice(0, -1)]],
        ["option-like value", replaceArgument(POSIX_ARGUMENTS, "--access-root", "--other")],
        ["duplicate option", [...POSIX_ARGUMENTS, "--platform", "linux"]],
        ["missing required option", POSIX_ARGUMENTS.slice(0, -2)],
    ])("rejects %s", (_label, arguments_) => {
        expect(() => parseHeadlessArguments(arguments_)).toThrow(HeadlessConfigurationError);
    });

    it.each([
        ["empty", ""],
        ["surrounding whitespace", " /tmp/oaam "],
        ["NUL", "/tmp/oaam\0bad"],
        ["relative", "tmp/oaam"],
        ["non-canonical", "/tmp/parent/../oaam"],
        ["filesystem root", path.parse("/").root],
        ["Win32 drive root", "C:\\"],
        ["Win32 share root", "\\\\server\\share\\"],
        ["trailing separator", "/tmp/oaam/"],
    ])("rejects a %s Host-owned path", (_label, value) => {
        expect(() => parseHeadlessArguments(replaceArgument(POSIX_ARGUMENTS, "--oaam-root", value))).toThrow(
            HeadlessConfigurationError,
        );
    });

    it.each([
        ["empty", ""],
        ["surrounding whitespace", " /tmp/project "],
        ["NUL", "/tmp/project\0bad"],
        ["relative", "tmp/project"],
        ["non-canonical", "/tmp/parent/../project"],
        ["Win32 root-relative", String.raw`\project`],
        ["Win32 device namespace", String.raw`\\?\C:\project`],
    ])("rejects a %s target access root", (_label, value) => {
        expect(() => parseHeadlessArguments(replaceArgument(POSIX_ARGUMENTS, "--access-root", value))).toThrow(
            HeadlessConfigurationError,
        );
    });

    it.each([
        ["unsupported platform", "--platform", "freebsd"],
        ["empty instance", "--platform-instance-id", ""],
        ["whitespace instance", "--platform-instance-id", " local "],
        ["NUL instance", "--platform-instance-id", "local\0bad"],
    ])("rejects %s", (_label, option, value) => {
        expect(() => parseHeadlessArguments(replaceArgument(POSIX_ARGUMENTS, option, value))).toThrow(HeadlessConfigurationError);
    });
});

describe("Headless bounded NDJSON", () => {
    it("decodes split UTF-8, CRLF, string chunks, and a final unterminated line", async () => {
        const utf8 = Buffer.from('{"value":"雪"}\r\n{"value":2}\n{"value":3}', "utf8");
        const chunks = [utf8.subarray(0, 12), utf8.subarray(12, 16), utf8.subarray(16, 25), utf8.subarray(25)];
        expect(await collectLines(chunks)).toEqual(['{"value":"雪"}', '{"value":2}', '{"value":3}']);
        expect(
            await collectLines(
                (async function* () {
                    yield '{"value":1}\n';
                })(),
            ),
        ).toEqual(['{"value":1}']);
    });

    it.each([
        ["blank line", [Buffer.from("\n")], undefined],
        ["invalid UTF-8", [Buffer.from([0xff, 0x0a])], undefined],
        ["line over bound before newline", [Buffer.from("12345\n")], 4],
        ["unterminated line over bound", [Buffer.from("12345")], 4],
    ])("rejects %s", async (_label, chunks, maximum) => {
        await expect(
            collectLines(
                (async function* () {
                    yield* chunks;
                })(),
                maximum,
            ),
        ).rejects.toBeInstanceOf(HeadlessNdjsonError);
    });

    it.each([0, 1.5])("rejects invalid line bound %s", async (maximum) => {
        await expect(
            collectLines(
                (async function* () {
                    yield "x";
                })(),
                maximum,
            ),
        ).rejects.toBeInstanceOf(RangeError);
    });
});

describe("serialized Protocol writer", () => {
    it("serializes writes and waits for their callbacks", async () => {
        const writes: string[] = [];
        const callbacks: Array<() => void> = [];
        const writer = new SerializedProtocolWriter(
            fakeWritable((text, encoding, callback) => {
                expect(encoding).toBe("utf8");
                writes.push(text);
                callbacks.push(() => callback(null));
                return true;
            }),
        );
        writer.enqueue({ first: 1 });
        writer.enqueue({ second: 2 });
        await Promise.resolve();
        expect(writes).toEqual(['{"first":1}\n']);
        callbacks.shift()?.();
        await new Promise<void>((resolve) => {
            setImmediate(resolve);
        });
        expect(writes).toEqual(['{"first":1}\n', '{"second":2}\n']);
        callbacks.shift()?.();
        await expect(writer.finish()).resolves.toBeUndefined();
    });

    it("retains callback and synchronous write failures", async () => {
        const callbackFailure = new Error("callback failed");
        const callbackWriter = new SerializedProtocolWriter(
            fakeWritable((_text, _encoding, callback) => {
                callback(callbackFailure);
                return false;
            }),
        );
        callbackWriter.enqueue({ value: 1 });
        callbackWriter.enqueue({ value: 2 });
        await expect(callbackWriter.finish()).rejects.toBe(callbackFailure);

        const synchronousFailure = new Error("write threw");
        const throwingWriter = new SerializedProtocolWriter(
            fakeWritable(() => {
                throw synchronousFailure;
            }),
        );
        throwingWriter.enqueue({ value: 1 });
        await expect(throwingWriter.finish()).rejects.toBe(synchronousFailure);
    });
});
