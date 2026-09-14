import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { snapshotPlatformContextRegularFileNoFollowBounded } from "@oaam/shared/paths";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retainCodexCliCurrentBuildObservation } from "../src/codex-probe-installation";
import { CODEX_CURRENT_BUILDS } from "../src/codex-runtime-builds";

let root: string;
let executable: string;
const bytes = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from("local build observation fixture")]);

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-codex-local-build-"));
    executable = path.join(root, "codex-0.142.5");
    fs.writeFileSync(executable, bytes, { mode: 0o700 });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function installation() {
    return {
        status: "available" as const,
        evidence: [{ kind: "executable" as const, path: executable, evidenceLevel: "local_artifact" as const, diagnostics: [] }],
        diagnostics: [],
        versionText: "",
    };
}
function context() {
    return { platform: "wsl" as const, platformInstanceId: "Ubuntu", accessRootPath: root };
}

describe("Codex build facts in a WSL-local process", () => {
    it("retains actual complete file hash and native identity without inferring a version from the filename", async () => {
        const result = await retainCodexCliCurrentBuildObservation(installation(), context(), "linux");
        expect(result).toMatchObject({
            status: "available",
            versionText: "",
            evidence: [
                {
                    currentBuildObservation: {
                        buildIdentity: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
                        byteSize: bytes.length,
                        executable: true,
                        identity: { entryKind: "file" },
                    },
                },
            ],
        });
    });

    it("recognizes only the existing exact WSL build anchor supplied by a fresh snapshot", async () => {
        const snapshotLocalExecutable = vi.fn(
            async (...args: Parameters<typeof snapshotPlatformContextRegularFileNoFollowBounded>) => ({
                ...(await snapshotPlatformContextRegularFileNoFollowBounded(...args)),
                sha256Hex: CODEX_CURRENT_BUILDS.CODEX_CLI.buildIdentity.slice(7),
            }),
        );
        const result = await retainCodexCliCurrentBuildObservation(installation(), context(), "linux", {
            snapshotLocalExecutable,
        });
        expect(result.versionText).toBe("0.142.5");
        expect(snapshotLocalExecutable).toHaveBeenCalledTimes(1);
        expect(snapshotLocalExecutable).toHaveBeenCalledWith(
            { ...context(), filePath: executable, maximumBytes: 512 * 1024 * 1024 },
            5_000,
        );
    });

    it("rejects file replacement between the snapshot and final native observation", async () => {
        const snapshotLocalExecutable = async (...args: Parameters<typeof snapshotPlatformContextRegularFileNoFollowBounded>) => {
            const observed = await snapshotPlatformContextRegularFileNoFollowBounded(...args);
            const replacement = path.join(root, "replacement");
            fs.writeFileSync(replacement, bytes, { mode: 0o700 });
            fs.renameSync(replacement, executable);
            return observed;
        };
        const result = await retainCodexCliCurrentBuildObservation(installation(), context(), "linux", {
            snapshotLocalExecutable,
        });
        expect(result.status).toBe("unknown");
        expect(result.evidence[0]?.currentBuildObservation).toBeUndefined();
    });

    it("rejects an executable permission change after the full snapshot", async () => {
        const snapshotLocalExecutable = async (...args: Parameters<typeof snapshotPlatformContextRegularFileNoFollowBounded>) => {
            const observed = await snapshotPlatformContextRegularFileNoFollowBounded(...args);
            fs.chmodSync(executable, 0o600);
            return observed;
        };
        expect(
            (await retainCodexCliCurrentBuildObservation(installation(), context(), "linux", { snapshotLocalExecutable })).status,
        ).toBe("unknown");
    });

    it("refuses a symlink inserted after installation discovery", async () => {
        fs.renameSync(executable, path.join(root, "actual"));
        fs.symlinkSync(path.join(root, "actual"), executable);
        expect((await retainCodexCliCurrentBuildObservation(installation(), context(), "linux")).status).toBe("unknown");
    });

    it("does not read an executable outside the exact selected access root", async () => {
        const snapshotLocalExecutable = vi.fn(snapshotPlatformContextRegularFileNoFollowBounded);
        const result = await retainCodexCliCurrentBuildObservation(
            installation(),
            { ...context(), accessRootPath: path.join(root, "other") },
            "linux",
            { snapshotLocalExecutable },
        );
        expect(result.status).toBe("unknown");
        expect(snapshotLocalExecutable).not.toHaveBeenCalled();
    });

    it("keeps snapshot failure visible without exposing its private exception", async () => {
        const result = await retainCodexCliCurrentBuildObservation(installation(), context(), "linux", {
            snapshotLocalExecutable: async () => {
                throw new Error("PRIVATE_SNAPSHOT_DETAIL");
            },
        });
        expect(result).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "codex_cli_build_observation_failed" })],
        });
        expect(JSON.stringify(result)).not.toContain("PRIVATE_SNAPSHOT_DETAIL");
    });

    it("does not borrow the WSL branch for a distinct local Linux Environment", async () => {
        const snapshotLocalExecutable = vi.fn(snapshotPlatformContextRegularFileNoFollowBounded);
        const input = installation();
        expect(
            await retainCodexCliCurrentBuildObservation(input, { ...context(), platform: "linux" }, "linux", {
                snapshotLocalExecutable,
            }),
        ).toBe(input);
        expect(snapshotLocalExecutable).not.toHaveBeenCalled();
    });
});
