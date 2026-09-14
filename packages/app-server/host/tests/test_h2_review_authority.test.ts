import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostPathSelectionStore } from "../src/path-selection-store";
import { decodeReviewRecord, encodeReviewRecord } from "../src/review-record-codec";
import {
    createOwnedReviewSpoolRoot,
    HostReviewRecordCapacityError,
    type HostReviewRecordInvalidationReason,
    HostReviewRecordStore,
} from "../src/review-record-store";

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-host-authority-test-"));
    temporaryRoots.push(root);
    return root;
}

function tokenSource(...values: string[]) {
    let index = 0;
    return () => values[index++] ?? `token-${index}`;
}

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe("strict Host review-record codec", () => {
    it("round-trips every supported value including Uint8Array without ordinary JSON loss", () => {
        const payload = Object.create(null) as Record<string, unknown>;
        Object.assign(payload, {
            nil: null,
            truth: true,
            count: 3.5,
            text: "hello",
            bytes: new Uint8Array([0, 1, 254, 255]),
            nested: [{ value: "ok" }, false],
        });
        const encoded = encodeReviewRecord("read", payload);
        const decoded = decodeReviewRecord(encoded, "read") as typeof payload;

        expect(decoded).toEqual({
            bytes: new Uint8Array([0, 1, 254, 255]),
            count: 3.5,
            nested: [{ value: "ok" }, false],
            nil: null,
            text: "hello",
            truth: true,
        });
        expect(decoded.bytes).toBeInstanceOf(Uint8Array);
    });

    it("rejects unsupported values and non-plain objects before publication", () => {
        expect(() => encodeReviewRecord("probe", { value: Number.NaN })).toThrow(/finite/u);
        expect(() => encodeReviewRecord("probe", { value: undefined })).toThrow(/unsupported/u);
        expect(() => encodeReviewRecord("probe", { value: new Date() })).toThrow(/plain prototype/u);
    });

    it("rejects malformed UTF-8, wrong kind, fingerprint changes, and non-canonical nodes", () => {
        expect(() => decodeReviewRecord(new Uint8Array([0xff]), "probe")).toThrow(/UTF-8 JSON/u);
        const encoded = encodeReviewRecord("probe", { ok: true });
        expect(() => decodeReviewRecord(encoded, "read")).toThrow(/envelope/u);

        const parsed = JSON.parse(new TextDecoder().decode(encoded)) as Record<string, unknown>;
        parsed.payloadFingerprint = "0".repeat(64);
        expect(() => decodeReviewRecord(new TextEncoder().encode(JSON.stringify(parsed)), "probe")).toThrow(/envelope/u);

        const invalidNode = {
            schemaVersion: 1,
            recordKind: "probe",
            payloadFingerprint: "",
            payload: { type: "wat" },
        };
        const payloadJson = JSON.stringify(invalidNode.payload);
        invalidNode.payloadFingerprint = awaitSha(payloadJson);
        expect(() => decodeReviewRecord(new TextEncoder().encode(JSON.stringify(invalidNode)), "probe")).toThrow(/node type/u);
    });

    it("rejects every malformed tagged-node branch rather than partially decoding it", () => {
        const invalidNodes: readonly [unknown, RegExp][] = [
            [null, /node is invalid/u],
            [{}, /node is invalid/u],
            [{ type: "null", value: null }, /null node/u],
            [{ type: "boolean" }, /boolean node/u],
            [{ type: "boolean", value: "true" }, /boolean node/u],
            [{ type: "number" }, /number node/u],
            [{ type: "number", value: Number.POSITIVE_INFINITY }, /number node/u],
            [{ type: "string" }, /string node/u],
            [{ type: "string", value: 1 }, /string node/u],
            [{ type: "bytes" }, /byte node/u],
            [{ type: "bytes", value: 1 }, /byte node/u],
            [{ type: "bytes", value: "AA=" }, /canonical base64/u],
            [{ type: "array" }, /array node/u],
            [{ type: "array", value: null }, /array node/u],
            [{ type: "object" }, /object node/u],
            [{ type: "object", value: null }, /object node/u],
            [{ type: "object", value: [null] }, /object entry/u],
            [{ type: "object", value: [["key"]] }, /object entry/u],
            [{ type: "object", value: [[1, { type: "null" }]] }, /object entry/u],
            [
                {
                    type: "object",
                    value: [
                        ["b", { type: "null" }],
                        ["a", { type: "null" }],
                    ],
                },
                /sorted and unique/u,
            ],
            [{ type: "unknown" }, /type is unknown/u],
        ];
        for (const [node, expected] of invalidNodes) {
            expect(() => decodeReviewRecord(encodedNode(node), "probe")).toThrow(expected);
        }
    });

    it("rejects every malformed envelope field before decoding its payload", () => {
        const validPayload = { type: "null" };
        const validFingerprint = awaitSha(JSON.stringify(validPayload));
        const invalidEnvelopes: unknown[] = [
            [],
            { schemaVersion: 1, recordKind: "probe", payloadFingerprint: validFingerprint },
            {
                schemaVersion: 2,
                recordKind: "probe",
                payloadFingerprint: validFingerprint,
                payload: validPayload,
            },
            {
                schemaVersion: 1,
                recordKind: "read",
                payloadFingerprint: validFingerprint,
                payload: validPayload,
            },
            { schemaVersion: 1, recordKind: "probe", payloadFingerprint: 1, payload: validPayload },
            { schemaVersion: 1, recordKind: "probe", payloadFingerprint: "bad", payload: validPayload },
            {
                schemaVersion: 1,
                recordKind: "probe",
                payloadFingerprint: "0".repeat(64),
                payload: validPayload,
            },
        ];
        for (const envelope of invalidEnvelopes) {
            expect(() => decodeReviewRecord(new TextEncoder().encode(JSON.stringify(envelope)), "probe")).toThrow(/envelope/u);
        }
    });
});

function awaitSha(value: string): string {
    return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function encodedNode(node: unknown, overrides: Record<string, unknown> = {}): Uint8Array {
    return new TextEncoder().encode(
        JSON.stringify({
            schemaVersion: 1,
            recordKind: "probe",
            payloadFingerprint: awaitSha(JSON.stringify(node)),
            payload: node,
            ...overrides,
        }),
    );
}

describe("bounded Host review-record store", () => {
    it("replaces a parent with all descendants and reports exact invalidations", () => {
        const invalidated: [string, string, string, HostReviewRecordInvalidationReason][] = [];
        const root = temporaryRoot();
        const store = new HostReviewRecordStore({
            rootPath: root,
            createToken: tokenSource("probe-1", "read-1", "preview-1", "probe-2"),
            onInvalidated: (...event) => invalidated.push(event),
        });
        const probe = store.put({
            kind: "probe",
            ownerConnectionId: "connection",
            replacementKey: "probe",
            payload: { value: 1 },
        });
        const read = store.put({
            kind: "read",
            ownerConnectionId: "connection",
            replacementKey: "read",
            parentTokens: [probe],
            payload: { value: 2 },
        });
        store.put({
            kind: "import_preview",
            ownerConnectionId: "connection",
            replacementKey: "preview",
            parentTokens: [read],
            payload: { value: 3 },
        });
        const probeFile = path.join(root, `${awaitSha(probe)}.record`);
        const readFile = path.join(root, `${awaitSha(read)}.record`);
        expect(fs.existsSync(probeFile)).toBe(true);
        expect(fs.existsSync(readFile)).toBe(true);
        expect(
            store.put({
                kind: "probe",
                ownerConnectionId: "connection",
                replacementKey: "probe",
                payload: { value: 4 },
            }),
        ).toBe("probe-2");
        expect(invalidated).toEqual([
            ["connection", "import_preview", "preview-1", "replaced"],
            ["connection", "read", "read-1", "replaced"],
            ["connection", "probe", "probe-1", "replaced"],
        ]);
        expect(store.get(probe, "probe", (value): value is object => typeof value === "object")).toBeNull();
        expect(store.get("probe-2", "probe", (value): value is object => typeof value === "object")).toEqual({ value: 4 });
        expect(fs.existsSync(probeFile)).toBe(true);
        expect(fs.existsSync(path.join(root, `${awaitSha("probe-2")}.record`))).toBe(false);
        expect(fs.existsSync(readFile)).toBe(false);
        store.close();
    });

    it("expires, evicts, removes, and rejects unavailable parents or oversized records", () => {
        let now = 10;
        const invalidated = vi.fn();
        const store = new HostReviewRecordStore({
            rootPath: temporaryRoot(),
            createToken: tokenSource("one", "two", "three"),
            now: () => now,
            maximumAgeMs: 5,
            maximumRecords: 1,
            maximumBytes: 300,
            onInvalidated: invalidated,
        });
        const one = store.put({
            kind: "probe",
            ownerConnectionId: "c",
            replacementKey: "a",
            payload: { value: "one" },
        });
        const two = store.put({
            kind: "read",
            ownerConnectionId: "c",
            replacementKey: "b",
            payload: { value: "two" },
        });
        expect(invalidated).toHaveBeenCalledWith("c", "probe", one, "evicted");
        expect(store.remove("missing", "cancelled")).toBe(false);
        expect(store.remove(two, "cancelled")).toBe(true);
        expect(() =>
            store.put({
                kind: "read",
                ownerConnectionId: "c",
                replacementKey: "child",
                parentTokens: ["missing"],
                payload: {},
            }),
        ).toThrow(/parent/u);
        expect(() =>
            store.put({
                kind: "probe",
                ownerConnectionId: "c",
                replacementKey: "large",
                payload: { value: "x".repeat(1_000) },
            }),
        ).toThrow(HostReviewRecordCapacityError);

        const expiring = store.put({
            kind: "probe",
            ownerConnectionId: "c",
            replacementKey: "expiring",
            payload: { value: 1 },
        });
        now = 15;
        store.expire();
        expect(invalidated).toHaveBeenCalledWith("c", "probe", expiring, "expired");
        store.close();
        store.close();
        store.expire();
        expect(() =>
            store.put({
                kind: "probe",
                ownerConnectionId: "c",
                replacementKey: "closed",
                payload: {},
            }),
        ).toThrow(/closed/u);
    });

    it("deletes truncated, corrupt, or validator-rejected records as a whole", () => {
        const root = temporaryRoot();
        const invalidated = vi.fn();
        const store = new HostReviewRecordStore({
            rootPath: root,
            createToken: tokenSource("truncated", "child", "invalid", "missing-file"),
            onInvalidated: invalidated,
        });
        const truncated = store.put({
            kind: "probe",
            ownerConnectionId: "c",
            replacementKey: "first",
            payload: { ok: true },
        });
        const child = store.put({
            kind: "read",
            ownerConnectionId: "c",
            replacementKey: "child",
            parentTokens: [truncated],
            payload: { ok: true },
        });
        const recordPath = path.join(root, `${crypto.createHash("sha256").update(truncated).digest("hex")}.record`);
        fs.truncateSync(recordPath, 1);
        expect(store.get(truncated, "probe", (value): value is object => typeof value === "object")).toBeNull();
        expect(fs.existsSync(recordPath)).toBe(false);
        expect(store.get(child, "read", (value): value is object => typeof value === "object")).toBeNull();
        expect(invalidated.mock.calls).toEqual([
            ["c", "read", "child", "evicted"],
            ["c", "probe", "truncated", "evicted"],
        ]);

        const invalid = store.put({
            kind: "read",
            ownerConnectionId: "c",
            replacementKey: "second",
            payload: { ok: true },
        });
        expect(store.get(invalid, "probe", (): boolean => true)).toBeNull();
        expect(store.get(invalid, "read", (): boolean => false)).toBeNull();

        const missingFile = store.put({
            kind: "probe",
            ownerConnectionId: "c",
            replacementKey: "missing-file",
            payload: { ok: true },
        });
        fs.unlinkSync(path.join(root, `${crypto.createHash("sha256").update(missingFile).digest("hex")}.record`));
        expect(store.remove(missingFile, "cancelled")).toBe(true);
        store.close();
    });

    it("rejects same-length spool tampering using the process-memory publication hash", () => {
        const root = temporaryRoot();
        const store = new HostReviewRecordStore({
            rootPath: root,
            createToken: tokenSource("tampered"),
        });
        const token = store.put({
            kind: "probe",
            ownerConnectionId: "c",
            replacementKey: "probe",
            payload: { value: "alpha" },
        });
        const recordPath = path.join(root, fs.readdirSync(root).find((entry) => entry.endsWith(".record")) as string);
        const bytes = fs.readFileSync(recordPath);
        const index = bytes.indexOf("a".charCodeAt(0));
        expect(index).toBeGreaterThanOrEqual(0);
        bytes[index] = "b".charCodeAt(0);
        fs.writeFileSync(recordPath, bytes);

        expect(store.get(token, "probe", (value): value is object => typeof value === "object")).toBeNull();
        expect(fs.existsSync(recordPath)).toBe(false);
        store.close();
    });

    it("does not adopt or remove the retired caller-owned temporary-file convention", () => {
        const root = temporaryRoot();
        const token = "write-failure";
        const store = new HostReviewRecordStore({
            rootPath: root,
            createToken: tokenSource(token),
        });
        const recordPath = path.join(root, `${crypto.createHash("sha256").update(token).digest("hex")}.record`);
        fs.writeFileSync(`${recordPath}.tmp`, "occupied", { flag: "wx" });
        expect(
            store.put({
                kind: "probe",
                ownerConnectionId: "c",
                replacementKey: "probe",
                payload: {},
            }),
        ).toBe(token);
        expect(fs.readFileSync(`${recordPath}.tmp`, "utf8")).toBe("occupied");
        expect(store.get(token, "probe", (value): value is object => typeof value === "object")).toEqual({});
        store.close();

        const missingRoot = temporaryRoot();
        const missingStore = new HostReviewRecordStore({
            rootPath: missingRoot,
            createToken: tokenSource("missing-root"),
        });
        fs.rmSync(missingRoot, { force: true, recursive: true });
        expect(() =>
            missingStore.put({
                kind: "probe",
                ownerConnectionId: "c",
                replacementKey: "probe",
                payload: {},
            }),
        ).toThrow();
        missingStore.close();
    });

    it("allocates only a newly created Shared-owned spool root and rejects a symlink root", () => {
        const parent = temporaryRoot();
        const owned = createOwnedReviewSpoolRoot(parent, tokenSource("owned"));
        expect(owned).toBe(path.join(parent, "owned"));
        expect(fs.statSync(owned).isDirectory()).toBe(true);

        const occupied = path.join(parent, "occupied");
        fs.mkdirSync(occupied);
        expect(() => createOwnedReviewSpoolRoot(parent, () => "occupied")).toThrow(/allocate/u);

        const actual = path.join(parent, "actual");
        const linked = path.join(parent, "linked");
        fs.mkdirSync(actual);
        fs.symlinkSync(actual, linked);
        expect(
            () =>
                new HostReviewRecordStore({
                    rootPath: linked,
                    createToken: tokenSource("never"),
                }),
        ).toThrow(/symbolic|symlink/u);
    });

    it("uses token ordering to evict deterministically when records have the same creation time", () => {
        const invalidated = vi.fn();
        const store = new HostReviewRecordStore({
            rootPath: temporaryRoot(),
            createToken: tokenSource("b", "a", "c", "d"),
            now: () => 1,
            maximumRecords: 3,
            onInvalidated: invalidated,
        });
        store.put({ kind: "probe", ownerConnectionId: "c", replacementKey: "b", payload: { value: "b" } });
        store.put({ kind: "read", ownerConnectionId: "c", replacementKey: "a", payload: { value: "a" } });
        store.put({ kind: "import_preview", ownerConnectionId: "c", replacementKey: "c", payload: { value: "c" } });
        store.put({ kind: "rendered_inspection", ownerConnectionId: "c", replacementKey: "d", payload: { value: "d" } });
        expect(invalidated).toHaveBeenCalledWith("c", "read", "a", "evicted");
        store.close();
    });

    it("rejects invalid limits and repeated unusable tokens", () => {
        expect(
            () =>
                new HostReviewRecordStore({
                    rootPath: temporaryRoot(),
                    createToken: () => "token",
                    maximumRecords: 0,
                }),
        ).toThrow(/positive/u);
        const store = new HostReviewRecordStore({
            rootPath: temporaryRoot(),
            createToken: () => "",
        });
        expect(() =>
            store.put({
                kind: "probe",
                ownerConnectionId: "c",
                replacementKey: "probe",
                payload: {},
            }),
        ).toThrow(/allocate/u);
        store.close();

        const whitespace = new HostReviewRecordStore({
            rootPath: temporaryRoot(),
            createToken: () => " token ",
        });
        expect(() =>
            whitespace.put({
                kind: "probe",
                ownerConnectionId: "c",
                replacementKey: "probe",
                payload: {},
            }),
        ).toThrow(/allocate/u);
        whitespace.close();

        const repeated = new HostReviewRecordStore({
            rootPath: temporaryRoot(),
            createToken: () => "same",
        });
        const first = repeated.put({
            kind: "probe",
            ownerConnectionId: "c",
            replacementKey: "probe",
            payload: {},
        });
        expect(() =>
            repeated.put({
                kind: "probe",
                ownerConnectionId: "c",
                replacementKey: "probe",
                payload: {},
            }),
        ).toThrow(/allocate/u);
        expect(repeated.get(first, "probe", (value): value is object => typeof value === "object")).toEqual({});
        repeated.close();
    });
});

describe("connection-scoped one-shot local-path selections", () => {
    it("accepts an absolute trusted path once and consumes wrong-kind attempts", () => {
        const store = new HostPathSelectionStore({ createToken: tokenSource("project", "source") });
        const project = store.register("project_root", "/project");
        expect(store.consume(project, "project_root")).toBe("/project");
        expect(store.consume(project, "project_root")).toBeNull();
        const source = store.register("source_root", "/source");
        expect(store.consume(source, "project_root")).toBeNull();
        expect(store.consume(source, "source_root")).toBeNull();
        store.clear();
    });

    it("replaces the live token for one kind while bounding distinct kinds and rejecting malformed paths", () => {
        let now = 1;
        const store = new HostPathSelectionStore({
            createToken: tokenSource("one", "replacement"),
            now: () => now,
            maximumSelections: 1,
            maximumAgeMs: 2,
        });
        expect(() => store.register("source_root", "relative")).toThrow(/absolute/u);
        expect(() => store.register("source_root", " /root")).toThrow(/absolute/u);
        expect(() => store.register("source_root", "/root\0bad")).toThrow(/absolute/u);
        const token = store.register("source_root", "/root");
        const replacement = store.register("source_root", "/other");
        expect(store.consume(token, "source_root")).toBeNull();
        expect(() => store.register("project_root", "/project")).toThrow(/capacity/u);
        now = 3;
        store.expire();
        expect(store.consume(replacement, "source_root")).toBeNull();
        expect(
            () =>
                new HostPathSelectionStore({
                    createToken: () => "x",
                    maximumAgeMs: 0,
                }),
        ).toThrow(/positive/u);
    });

    it("fails after repeated empty or duplicate token candidates", () => {
        const empty = new HostPathSelectionStore({ createToken: () => "" });
        expect(() => empty.register("source_root", "/root")).toThrow(/allocate/u);
        const whitespace = new HostPathSelectionStore({ createToken: () => " token " });
        expect(() => whitespace.register("source_root", "/root")).toThrow(/allocate/u);

        const duplicate = new HostPathSelectionStore({ createToken: () => "same", maximumSelections: 2 });
        duplicate.register("source_root", "/one");
        expect(() => duplicate.register("source_root", "/two")).toThrow(/allocate/u);
    });
});
