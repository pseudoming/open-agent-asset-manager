import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { launchProductionHost } from "../src";

describe("production bootstrap State lifecycle", () => {
    it("closes the process State database before normal Host shutdown completes", async () => {
        const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-bootstrap-state-lifecycle-"));
        const oaamRoot = path.join(sandbox, "oaam");
        const databasePath = path.join(oaamRoot, "index.db");
        let runtime: ReturnType<typeof launchProductionHost> | undefined;
        try {
            runtime = launchProductionHost({
                oaamRoot,
                databasePath,
                platformContexts: [{ platform: "linux", platformInstanceId: "local", accessRootPath: "/" }],
            });
            expect(fs.existsSync(databasePath)).toBe(true);
            expect(fs.existsSync(`${databasePath}-wal`)).toBe(true);
            await runtime.shutdown();
            runtime = undefined;
            expect(fs.existsSync(`${databasePath}-wal`)).toBe(false);
            expect(fs.existsSync(`${databasePath}-shm`)).toBe(false);
        } finally {
            await runtime?.shutdown();
            fs.rmSync(sandbox, { recursive: true, force: true });
        }
    });
});
