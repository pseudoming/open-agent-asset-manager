import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { HostOperationalDiagnostics } from "../src/operational-diagnostics";

const HEX_ID = "0123456789abcdef0123456789abcdef";

describe("Host adapter probe timing diagnostics", () => {
    it("persists privacy-bounded adapter owner and concurrency timing across reopen", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-probe-timing-log-"));
        const logger = new HostOperationalDiagnostics(root, {
            now: () => 20,
            createSegmentId: () => HEX_ID,
        });
        logger.record({
            source: "protocol",
            code: "protocol.adapter_probe.owner_timing",
            operationId: "operation-1",
            stage: "provider_probe",
            adapterId: "CLAUDECODE",
            environment: { platform: "wsl", platformInstanceId: "Ubuntu" },
            status: "failed",
            startedOffsetMilliseconds: 5,
            endedOffsetMilliseconds: 30,
            elapsedMilliseconds: 25,
        });
        logger.record({
            source: "protocol",
            code: "protocol.adapter_probe.summary_timing",
            operationId: "operation-1",
            stage: "provider_probe",
            status: "partial",
            ownerCount: 2,
            elapsedMilliseconds: 60,
            maximumOwnerElapsedMilliseconds: 40,
            overheadMilliseconds: 20,
        });

        const before = recordLines(root);
        expect(before).toEqual([
            expect.objectContaining({
                code: "protocol.adapter_probe.owner_timing",
                adapterId: "CLAUDECODE",
                environment: { platform: "wsl", platformInstanceId: "Ubuntu" },
                status: "failed",
                elapsedMilliseconds: 25,
            }),
            expect.objectContaining({
                code: "protocol.adapter_probe.summary_timing",
                status: "partial",
                elapsedMilliseconds: 60,
                maximumOwnerElapsedMilliseconds: 40,
                overheadMilliseconds: 20,
            }),
        ]);
        const reopened = new HostOperationalDiagnostics(root, {
            now: () => 21,
            createSegmentId: () => "fedcba9876543210fedcba9876543210",
        });
        expect(reopened.health("ready", { mode: "normal" }).ordinaryLog).toMatchObject({
            state: "active",
            segmentCount: 1,
        });
        expect(recordLines(root)).toEqual(before);
    });
});

function recordLines(root: string): unknown[] {
    const ordinaryRoot = path.join(root, "logs", "ordinary");
    return fs.readdirSync(ordinaryRoot).flatMap((name) => {
        const text = fs.readFileSync(path.join(ordinaryRoot, name), "utf8");
        return text
            .trimEnd()
            .split("\n")
            .map((line) => JSON.parse(line) as unknown);
    });
}
