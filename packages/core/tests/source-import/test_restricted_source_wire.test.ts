/** Real original source reads over serialized private messages, including large payloads and interrupted grants. */
import * as fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireAllLocks } from "../../src/foundation/physical-path-locks";
import { sha256Bytes } from "../../src/foundation/crypto-bytes";
import { encodeRestrictedSourceReadResult } from "../../src/source-import/restricted-source-result-codec";
import { restrictedReadAuthorityKeys } from "../../src/source-import/restricted-source-read-operation";
import { RESTRICTED_SOURCE_MAX_FRAME_BYTES } from "../../src/source-import/restricted-source-protocol";
import { validateAdapterReadResultSnapshot } from "../../src/source-import/source-read-snapshot-validator";
import { sourceFile } from "./fixtures/source-contract-test-fixtures";
import { sourceWireFixture } from "./fixtures/restricted-source-wire-fixtures";

afterEach(() => vi.restoreAllMocks());

function keys(h: ReturnType<typeof sourceWireFixture>) {
    return restrictedReadAuthorityKeys(
        { platform: "wsl", sourceRoots: h.readRequest.preparation.roots },
        {
            phase: "access",
            targets: [{ sourceRootId: "root-1", relativePath: "", entryKind: "file" }],
        },
    );
}

describe("restricted source channel and service", () => {
    it("preserves an explicit source-entry subset through JSON and the original Host authority", async () => {
        const h = sourceWireFixture({ explicitAgentRuntimeSelection: true });
        try {
            const result = await h.channel.read(h.readRequest);
            expect(result.status).toBe("complete");
            expect(result.value.readTarget.agentRuntimeIds).toEqual(h.readRequest.target.agentRuntimeIds);
            expect(result.value.readAuthorityFingerprint).toBe(h.readRequest.preparation.readAuthorityFingerprint);
            expect(validateAdapterReadResultSnapshot(result.value)).toEqual([]);
            expect(h.providerCalls()).toBe(1);
            const begin = h.requests.find((request) => request.operation.kind === "begin");
            expect(begin?.operation).toMatchObject({ target: { agentRuntimeIds: h.readRequest.target.agentRuntimeIds } });
        } finally {
            await h.channel.close();
        }
    });

    it("rejects loss of the explicit subset on the wire instead of accepting broader read authority", async () => {
        const h = sourceWireFixture({
            explicitAgentRuntimeSelection: true,
            beforeRequest(request) {
                if (request.operation.kind === "begin") delete request.operation.target.agentRuntimeIds;
            },
        });
        try {
            await expect(h.channel.read(h.readRequest)).rejects.toThrow("exact Host read authority");
            expect(h.channel.available).toBe(false);
        } finally {
            await h.channel.close();
        }
    });

    it("rejects a foreign source-entry subset at wire admission before Provider I/O", async () => {
        const h = sourceWireFixture({
            explicitAgentRuntimeSelection: true,
            beforeRequest(request) {
                if (request.operation.kind === "begin") request.operation.target.agentRuntimeIds = ["FOREIGN_CLI"];
            },
        });
        try {
            await expect(h.channel.read(h.readRequest)).rejects.toThrow();
            expect(h.providerCalls()).toBe(0);
        } finally {
            await h.channel.close();
        }
    });

    it("preserves a normal partial result through the same decoded source contract", async () => {
        const h = sourceWireFixture({ partial: true });
        try {
            const result = await h.channel.read(h.readRequest);
            expect(result.status).toBe("partial");
            expect(result.value.sourceReports.map((report) => report.status)).toEqual(["scanned", "malformed_source"]);
            expect(result.value.observedReadEntries.filter((entry) => entry.entryKind === "file")).toHaveLength(2);
            expect(validateAdapterReadResultSnapshot(result.value)).toEqual([]);
            expect(h.channel.available).toBe(true);
        } finally {
            await h.channel.close();
        }
    });

    it.each([
        "failure_null",
        "read_null",
        "candidate_extra",
        "outcome_enum",
        "parse_status",
    ])("retires hash-consistent %s result corruption", async (kind) => {
        let corrupt: Buffer | undefined;
        const h = sourceWireFixture({
            afterResponse(response) {
                if (corrupt === undefined) return;
                if (response.result.kind === "read_step" && response.result.step.kind === "result")
                    response.result.step.descriptor = {
                        ...response.result.step.descriptor,
                        byteLength: corrupt.byteLength,
                        contentHash: sha256Bytes(corrupt),
                    };
                if (response.result.kind === "result_chunk")
                    response.result.chunk = {
                        offset: 0,
                        byteLength: corrupt.byteLength,
                        bytesBase64: corrupt.toString("base64"),
                        contentHash: sha256Bytes(corrupt),
                    };
            },
        });
        const baseline = await h.channel.read(h.readRequest);
        const value = JSON.parse(encodeRestrictedSourceReadResult(baseline).toString("utf8"));
        if (kind === "read_null") value.diagnostics = [null];
        if (kind === "parse_status") value.sourceParseReports[0].status = "partial";
        if (kind === "candidate_extra") value.candidates[0].diagnostics = [{ severity: "error", unexpected: true }];
        if (kind === "outcome_enum")
            value.readAccessOutcomes[0].diagnostics = [
                {
                    severity: "error",
                    code: "read.failed",
                    message: "bad enum",
                    path: "",
                    traceId: "",
                    operation: "read",
                    causeKind: "forged",
                    retryable: false,
                    suggestedActions: [],
                    rawSummary: "",
                },
            ];
        corrupt = Buffer.from(JSON.stringify(kind === "failure_null" ? { failure: [null] } : value));
        await expect(h.channel.read(h.readRequest)).rejects.toThrow(/diagnostics|report status/);
        expect(h.channel.available).toBe(false);
        expect(h.providerCalls()).toBe(2);
        expect(h.aborts()).toBe(1);
    });
    it("returns fresh original results, keeps Host State paths off the wire and reuses the acknowledged peer", async () => {
        const h = sourceWireFixture();
        try {
            const first = await h.channel.read(h.readRequest);
            expect(first.status, JSON.stringify(first.diagnostics)).toBe("complete");
            expect(validateAdapterReadResultSnapshot(first.value)).toEqual([]);
            fs.writeFileSync(sourceFile, "# New source read\n");
            const second = await h.channel.read(h.readRequest);
            expect(second.status).toBe("complete");
            expect(second.value.readSnapshotFingerprint).not.toBe(first.value.readSnapshotFingerprint);
            expect(second.value.candidates[0]?.files[0]).toMatchObject({ text: "# New source read\n" });
            expect(h.providerCalls()).toBe(2);
            expect(h.aborts()).toBe(0);
            expect(h.requests.filter((request) => request.operation.kind === "acknowledge")).toHaveLength(2);
            expect(h.requests.some((request) => JSON.stringify(request).includes(h.readRequest.authority.transactionsRoot))).toBe(
                false,
            );
            expect(h.channel.available).toBe(true);
        } finally {
            await h.channel.close();
        }
    });

    it("transfers an actual 64 MiB source at the original read budget through individually bounded frames", async () => {
        const text = "g".repeat(64 * 1024 * 1024);
        fs.writeFileSync(sourceFile, text);
        const h = sourceWireFixture();
        try {
            const result = await h.channel.read(h.readRequest);
            expect(result.status, JSON.stringify(result.diagnostics)).toBe("complete");
            const file = result.value.candidates[0]!.files[0]!;
            expect(file.contentKind).toBe("text");
            if (file.contentKind !== "text") throw new Error("source text was not preserved");
            expect(file.text === text).toBe(true);
            expect(h.requests.filter((request) => request.operation.kind === "result_chunk").length).toBeGreaterThan(64);
            expect(h.maximumObservedFrameBytes()).toBeLessThan(RESTRICTED_SOURCE_MAX_FRAME_BYTES);
            expect(h.providerCalls()).toBe(1);
        } finally {
            await h.channel.close();
        }
    }, 60_000);

    it("returns a normal bounded consumer-capacity failure and succeeds after a smaller fresh source on the same peer", async () => {
        fs.writeFileSync(sourceFile, "g".repeat(48_000));
        const h = sourceWireFixture({ maximumResultBytes: 32_768 });
        try {
            const first = await h.channel.read(h.readRequest);
            expect(first.status).toBe("failed");
            expect(first.value).toBeUndefined();
            expect(first.diagnostics[0]?.code).toBe("read.restricted_result_capacity");
            fs.writeFileSync(sourceFile, "# Fits consumer capacity\n");
            expect((await h.channel.read(h.readRequest)).status).toBe("complete");
            expect(h.channel.available).toBe(true);
        } finally {
            await h.channel.close();
        }
    });

    it("preserves the original diagnosed authority refusal and its no-lock release acknowledgement", async () => {
        const h = sourceWireFixture({ revalidate: () => false });
        try {
            expect((await h.channel.read(h.readRequest)).status).toBe("failed");
            expect(h.requests.filter((request) => request.operation.kind === "continue")).toHaveLength(2);
            expect(h.channel.available).toBe(true);
        } finally {
            await h.channel.close();
        }
    });

    it("preserves a real late source edit as an original stale final-validation result", async () => {
        const h = sourceWireFixture({
            afterResponse(response) {
                if (
                    response.result.kind === "read_step" &&
                    response.result.step.kind === "acquire_authority" &&
                    response.result.step.intent.phase === "final_validate"
                )
                    fs.writeFileSync(sourceFile, "# Changed after parse\n");
            },
        });
        try {
            const result = await h.channel.read(h.readRequest);
            expect(result.status).toBe("failed");
            expect(result.value.readAccessOutcomes).toContainEqual(
                expect.objectContaining({ operation: "final_validate", status: "stale" }),
            );
            expect(h.channel.available).toBe(true);
        } finally {
            await h.channel.close();
        }
    });

    it.each([
        "session",
        "chunk_offset",
        "chunk_hash",
        "chunk_truncation",
        "extra_chunk_field",
    ])("retires %s corruption with no Provider replay", async (kind) => {
        const h = sourceWireFixture({
            afterResponse(response) {
                if (kind === "session") response.sessionId = "wrong-session";
                if (response.result.kind !== "result_chunk") return;
                if (kind === "chunk_offset") response.result.chunk.offset++;
                if (kind === "chunk_hash") response.result.chunk.contentHash = `sha256:${"0".repeat(64)}`;
                if (kind === "chunk_truncation")
                    response.result.chunk.bytesBase64 = response.result.chunk.bytesBase64.slice(0, -4);
                if (kind === "extra_chunk_field") Object.assign(response.result.chunk, { state: "override" });
            },
        });
        await expect(h.channel.read(h.readRequest)).rejects.toThrow(/source/);
        expect(h.channel.available).toBe(false);
        expect(h.providerCalls()).toBe(1);
        await expect(h.channel.read(h.readRequest)).rejects.toThrow(/closed/);
        expect(h.providerCalls()).toBe(1);
    });

    it("keeps the exact physical locks until a lost granted-read response is followed by confirmed service cancellation", async () => {
        let h: ReturnType<typeof sourceWireFixture>;
        h = sourceWireFixture({
            afterResponse(_response, request) {
                if (request.operation.kind === "continue" && "permission" in request.operation.continuation)
                    throw new Error("lost source response after granted physical access");
            },
            beforeAbort() {
                expect(acquireAllLocks(h.readRequest.authority.transactionsRoot, keys(h))).toBeNull();
            },
        });
        await expect(h.channel.read(h.readRequest)).rejects.toThrow(/lost source response/);
        const held = acquireAllLocks(h.readRequest.authority.transactionsRoot, keys(h));
        expect(held).not.toBeNull();
        held!.release();
        expect(h.providerCalls()).toBe(1);
    });

    it("retains locks when cleanup is uncertain and releases them after the same channel confirms a later close", async () => {
        let uncertain = true;
        const h = sourceWireFixture({
            afterResponse(_response, request) {
                if (request.operation.kind === "continue" && "permission" in request.operation.continuation)
                    throw new Error("response lost");
            },
            beforeAbort() {
                if (uncertain) throw new Error("service cleanup unconfirmed");
            },
        });
        try {
            await expect(h.channel.read(h.readRequest)).rejects.toThrow(/cleanup is unconfirmed/);
            expect(acquireAllLocks(h.readRequest.authority.transactionsRoot, keys(h))).toBeNull();
            uncertain = false;
            await h.channel.close();
            const held = acquireAllLocks(h.readRequest.authority.transactionsRoot, keys(h));
            expect(held).not.toBeNull();
            held!.release();
            expect(h.providerCalls()).toBe(1);
        } finally {
            uncertain = false;
            await h.channel.close();
        }
    });

    it("rejects forged source roots before a Provider is invoked", async () => {
        const h = sourceWireFixture({
            beforeRequest(request) {
                if (request.operation.kind === "begin" && request.operation.target.sourceSelector.selectorKind === "probe_roots")
                    request.operation.target.sourceSelector.observation.sourceRoots[0]!.path = "\\\\wsl.localhost\\foreign\\file";
            },
        });
        await expect(h.channel.read(h.readRequest)).rejects.toThrow(/outside/);
        expect(h.providerCalls()).toBe(0);
    });
});
