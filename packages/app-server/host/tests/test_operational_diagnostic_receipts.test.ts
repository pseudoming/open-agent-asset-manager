import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostOperationalDiagnostics } from "../src/operational-diagnostics";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Host operational diagnostic receipts", () => {
    it("persists canonical terminal and privacy-bounded Renderer receipts without message bodies", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-operational-receipt-"));
        roots.push(root);
        const logger = new HostOperationalDiagnostics(root, {
            now: () => 10,
            createSegmentId: () => "0123456789abcdef0123456789abcdef",
        });
        logger.record({
            source: "protocol",
            code: "protocol.request.terminal",
            operation: "asset.list",
            status: "partial",
            diagnosticCodes: ["asset.warning", "asset.warning", "asset.partial"],
        });
        logger.record({
            source: "desktop",
            code: "desktop.renderer.event",
            event: "failure",
            failureKind: "render",
            surface: "library",
            componentTrail: ["AssetVersionPanel", "ProjectLibraryWorkspace"],
        });

        const [segmentName] = fs.readdirSync(path.join(root, "logs", "ordinary"));
        expect(segmentName).toBeDefined();
        const text = fs.readFileSync(path.join(root, "logs", "ordinary", segmentName as string), "utf8");
        expect(
            text
                .trimEnd()
                .split("\n")
                .map((line) => JSON.parse(line) as unknown),
        ).toEqual([
            {
                schemaVersion: 1,
                occurredAt: 10,
                source: "protocol",
                code: "protocol.request.terminal",
                operation: "asset.list",
                status: "partial",
                diagnosticCodes: ["asset.partial", "asset.warning"],
            },
            {
                schemaVersion: 1,
                occurredAt: 10,
                source: "desktop",
                code: "desktop.renderer.event",
                event: "failure",
                failureKind: "render",
                surface: "library",
                componentTrail: ["AssetVersionPanel", "ProjectLibraryWorkspace"],
            },
        ]);
        expect(text).not.toContain("message");
        expect(text).not.toContain("path");
    });
});
