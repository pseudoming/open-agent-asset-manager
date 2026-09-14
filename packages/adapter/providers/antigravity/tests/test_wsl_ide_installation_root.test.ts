import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findAntigravityIdeInstallation, planAntigravityIdeInstallation } from "../src/antigravity-probe-installation";

let home: string;
let officialRoot: string;
const context = () => ({ platform: "wsl" as const, platformInstanceId: "Ubuntu", accessRootPath: home });
beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-antigravity-local-wsl-ide-"));
    officialRoot = path.join(home, ".local", "share", "antigravity-ide");
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
function install() {
    fs.mkdirSync(path.join(officialRoot, "resources", "app", "extensions"), { recursive: true });
    fs.writeFileSync(path.join(officialRoot, "antigravity-ide"), Buffer.from([0x7f, 0x45, 0x4c, 0x46]), { mode: 0o755 });
    fs.writeFileSync(
        path.join(officialRoot, "resources", "app", "product.json"),
        JSON.stringify({ applicationName: "antigravity-ide", version: "2.1.1" }),
    );
    fs.writeFileSync(path.join(officialRoot, "resources", "app", "package.json"), "{}");
}

describe("Antigravity official IDE root observed inside Linux WSL", () => {
    it("discovers the exact root without PATH or sibling installation evidence", async () => {
        install();
        expect(planAntigravityIdeInstallation({}, home, context())?.roots).toContain(officialRoot);
        expect(await findAntigravityIdeInstallation({}, home, context())).toMatchObject({
            status: "available",
            versionText: "2.1.1",
            evidence: [
                expect.objectContaining({ kind: "install_root", path: officialRoot }),
                expect.objectContaining({ kind: "executable", path: path.join(officialRoot, "antigravity-ide") }),
            ],
        });
    });
    it("rejects an unselected root and distinguishes an absent root", async () => {
        expect(await findAntigravityIdeInstallation({}, home, context(), path.dirname(home))).toMatchObject({
            status: "unknown",
        });
        expect(await findAntigravityIdeInstallation({}, home, context(), officialRoot)).toMatchObject({ status: "not_found" });
    });
    it.each([
        "wrong_product",
        "insufficient_resources",
        "non_executable",
        "symlink",
    ] as const)("rejects a real %s installation", async (failure) => {
        install();
        if (failure === "wrong_product")
            fs.writeFileSync(path.join(officialRoot, "resources", "app", "product.json"), '{"applicationName":"other"}');
        if (failure === "insufficient_resources") fs.unlinkSync(path.join(officialRoot, "resources", "app", "package.json"));
        if (failure === "non_executable") fs.chmodSync(path.join(officialRoot, "antigravity-ide"), 0o644);
        if (failure === "symlink") {
            const actual = `${officialRoot}-actual`;
            fs.renameSync(officialRoot, actual);
            fs.symlinkSync(actual, officialRoot);
        }
        expect(await findAntigravityIdeInstallation({}, home, context(), officialRoot)).toMatchObject({ status: "not_found" });
    });
});
