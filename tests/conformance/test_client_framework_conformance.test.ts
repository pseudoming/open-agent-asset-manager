import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Client Framework package boundary", () => {
    it("declares Protocol as its only production dependency", () => {
        const manifest = JSON.parse(
            fs.readFileSync(path.resolve(__dirname, "../../packages/client/framework/package.json"), "utf8"),
        ) as Record<string, unknown>;
        expect(manifest.dependencies).toEqual({ "@oaam/app-server-protocol": "^0.1.0" });
        expect(manifest.peerDependencies).toBeUndefined();
        expect(manifest.optionalDependencies).toBeUndefined();
    });
});
