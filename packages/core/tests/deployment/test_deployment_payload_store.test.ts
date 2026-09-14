import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    publishDeploymentPayloads,
    publishDeploymentPayloadsForTest,
    readDeploymentPayload,
} from "../../src/deployment/deployment-payload-store";
import { shaBytes } from "./fixtures/deployment-authority-fixtures";

const DEPLOYMENT_ID = "11111111-1111-4111-8111-111111111111";
const TXN_ID = "22222222-2222-4222-8222-222222222222";

describe("Deployment-owned payload publication", () => {
    let root: string;
    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-deployment-payload-"));
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    function payload(text: string, contentKind: "text" | "binary" = "text") {
        const bytes = new Uint8Array(Buffer.from(text));
        return { contentKind, contentHash: shaBytes(bytes), bytes };
    }

    it("stages, verifies and reopens exact owner-local bytes", () => {
        const value = payload("hello\r\n");
        publishDeploymentPayloads({
            deploymentsRoot: root,
            deploymentId: DEPLOYMENT_ID,
            transactionId: TXN_ID,
            payloads: [value],
        });
        expect(
            Buffer.from(
                readDeploymentPayload({
                    deploymentsRoot: root,
                    deploymentId: DEPLOYMENT_ID,
                    contentHash: value.contentHash,
                    expectedByteSize: value.bytes.length,
                }),
            ).toString(),
        ).toBe("hello\r\n");
        expect(fs.existsSync(path.join(root, DEPLOYMENT_ID, ".staging", TXN_ID))).toBe(false);
    });

    it("deduplicates identical bytes across ref content kinds and rejects contradictory bytes", () => {
        const value = payload("same");
        publishDeploymentPayloads({
            deploymentsRoot: root,
            deploymentId: DEPLOYMENT_ID,
            transactionId: TXN_ID,
            payloads: [value, { ...value, contentKind: "binary", bytes: new Uint8Array(value.bytes) }],
        });
        expect(fs.readdirSync(path.join(root, DEPLOYMENT_ID, "payloads"))).toHaveLength(1);
        expect(() =>
            publishDeploymentPayloads({
                deploymentsRoot: root,
                deploymentId: DEPLOYMENT_ID,
                transactionId: "33333333-3333-4333-8333-333333333333",
                payloads: [value, { ...value, bytes: new Uint8Array(Buffer.from("different")) }],
            }),
        ).toThrow(/same deployment payload hash/);
    });

    it("sorts multiple payloads by digest before publication", () => {
        const values = [payload("z"), payload("a"), payload("m")];
        const seen: string[] = [];
        publishDeploymentPayloadsForTest(
            {
                deploymentsRoot: root,
                deploymentId: DEPLOYMENT_ID,
                transactionId: TXN_ID,
                payloads: [values[2]!, values[0]!, values[1]!],
            },
            {
                beforePublish: (value) => seen.push(value.contentHash),
            },
        );
        expect(seen).toEqual(values.map((value) => value.contentHash).sort());
    });

    it("rejects invalid IDs, hashes, byte sizes and declared bytes", () => {
        const value = payload("truth");
        for (const invalidRoot of [
            "",
            `${root}/bad\0root`,
            "relative/root",
            `${root}/../other`,
            `${root}${path.sep}`,
            path.parse(root).root,
        ]) {
            expect(() =>
                publishDeploymentPayloads({
                    deploymentsRoot: invalidRoot,
                    deploymentId: DEPLOYMENT_ID,
                    transactionId: TXN_ID,
                    payloads: [value],
                }),
            ).toThrow(/canonical absolute/);
            expect(() =>
                readDeploymentPayload({
                    deploymentsRoot: invalidRoot,
                    deploymentId: DEPLOYMENT_ID,
                    contentHash: value.contentHash,
                    expectedByteSize: value.bytes.length,
                }),
            ).toThrow(/canonical absolute/);
        }
        for (const invalid of [
            { deploymentId: "bad", transactionId: TXN_ID },
            { deploymentId: DEPLOYMENT_ID, transactionId: "bad" },
        ]) {
            expect(() =>
                publishDeploymentPayloads({
                    deploymentsRoot: root,
                    ...invalid,
                    payloads: [value],
                } as never),
            ).toThrow(/UUID v4/);
        }
        expect(() =>
            publishDeploymentPayloads({
                deploymentsRoot: root,
                deploymentId: DEPLOYMENT_ID,
                transactionId: TXN_ID,
                payloads: [{ ...value, contentHash: `sha256:${"f".repeat(64)}` }],
            }),
        ).toThrow(/declared hash/);
        expect(() =>
            publishDeploymentPayloads({
                deploymentsRoot: root,
                deploymentId: DEPLOYMENT_ID,
                transactionId: TXN_ID,
                payloads: [{ ...value, contentKind: "other" as never }],
            }),
        ).toThrow(/contentKind/);
        expect(() =>
            publishDeploymentPayloads({
                deploymentsRoot: root,
                deploymentId: DEPLOYMENT_ID,
                transactionId: TXN_ID,
                payloads: [{ ...value, contentHash: "bad" as never }],
            }),
        ).toThrow(/contentHash/);
        expect(() =>
            readDeploymentPayload({
                deploymentsRoot: root,
                deploymentId: "bad" as never,
                contentHash: value.contentHash,
                expectedByteSize: value.bytes.length,
            }),
        ).toThrow(/UUID v4/);
        expect(() =>
            readDeploymentPayload({
                deploymentsRoot: root,
                deploymentId: DEPLOYMENT_ID,
                contentHash: "bad" as never,
                expectedByteSize: 1,
            }),
        ).toThrow(/contentHash/);
        expect(() =>
            readDeploymentPayload({
                deploymentsRoot: root,
                deploymentId: DEPLOYMENT_ID,
                contentHash: value.contentHash,
                expectedByteSize: -1,
            }),
        ).toThrow(/non-negative/);
    });

    it("a kill after staging publishes no final payload authority", () => {
        const value = payload("staged only");
        expect(() =>
            publishDeploymentPayloadsForTest(
                {
                    deploymentsRoot: root,
                    deploymentId: DEPLOYMENT_ID,
                    transactionId: TXN_ID,
                    payloads: [value],
                },
                {
                    afterStaging: () => {
                        throw new Error("kill after staging");
                    },
                },
            ),
        ).toThrow(/kill after staging/);
        expect(() =>
            readDeploymentPayload({
                deploymentsRoot: root,
                deploymentId: DEPLOYMENT_ID,
                contentHash: value.contentHash,
                expectedByteSize: value.bytes.length,
            }),
        ).toThrow();
        expect(fs.existsSync(path.join(root, DEPLOYMENT_ID, ".staging", TXN_ID))).toBe(true);
    });

    it("reports a staging-root disappearance at the exact cleanup boundary", () => {
        const value = payload("published before cleanup");
        const stagingRoot = path.join(root, DEPLOYMENT_ID, ".staging", TXN_ID);
        expect(() =>
            publishDeploymentPayloadsForTest(
                {
                    deploymentsRoot: root,
                    deploymentId: DEPLOYMENT_ID,
                    transactionId: TXN_ID,
                    payloads: [value],
                },
                {
                    beforeCleanup: () => fs.rmSync(stagingRoot, { recursive: true }),
                },
            ),
        ).toThrow(/staging root disappeared/);
        expect(
            Buffer.from(
                readDeploymentPayload({
                    deploymentsRoot: root,
                    deploymentId: DEPLOYMENT_ID,
                    contentHash: value.contentHash,
                    expectedByteSize: value.bytes.length,
                }),
            ).toString(),
        ).toBe("published before cleanup");
    });

    it("rejects tampered and symlinked final payloads", () => {
        const value = payload("safe");
        publishDeploymentPayloads({
            deploymentsRoot: root,
            deploymentId: DEPLOYMENT_ID,
            transactionId: TXN_ID,
            payloads: [value],
        });
        const payloadPath = path.join(root, DEPLOYMENT_ID, "payloads", value.contentHash.slice(7));
        fs.writeFileSync(payloadPath, "evil");
        expect(() =>
            readDeploymentPayload({
                deploymentsRoot: root,
                deploymentId: DEPLOYMENT_ID,
                contentHash: value.contentHash,
                expectedByteSize: value.bytes.length,
            }),
        ).toThrow(/hash mismatch|byteSize mismatch/);

        fs.rmSync(payloadPath);
        const real = path.join(root, "outside");
        fs.writeFileSync(real, value.bytes);
        fs.symlinkSync(real, payloadPath);
        expect(() =>
            readDeploymentPayload({
                deploymentsRoot: root,
                deploymentId: DEPLOYMENT_ID,
                contentHash: value.contentHash,
                expectedByteSize: value.bytes.length,
            }),
        ).toThrow(/symbolic|link/i);
    });
});
