import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureGlobalProbeContext as globalContext } from "../../../test-support";
import { probeOpencode } from "../src/opencode-probe";
import { probeDiagnostic } from "@oaam/adapter-framework";

let sandbox = "";

afterEach(() => {
    if (sandbox !== "") fs.rmSync(sandbox, { recursive: true, force: true });
    sandbox = "";
});

describe("OpenCode probe scheduling", () => {
    it.each([
        "info",
        "warning",
    ] as const)("retains %s visibility facts without changing a completed profile query", async (severity) => {
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-opencode-profile-status-"));
        const home = path.join(sandbox, "home");
        const bin = path.join(sandbox, "bin");
        fs.mkdirSync(home, { recursive: true });
        fs.mkdirSync(bin);
        fs.writeFileSync(path.join(bin, "opencode"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0]), { mode: 0o755 });
        const fact = probeDiagnostic(
            "opencode_process_observation_eacces",
            "Profile query completed; process visibility is limited",
            "partial",
            severity,
        );
        const result = await probeOpencode(globalContext(), { PATH: bin }, home, "linux", {
            observeCliVersion: async (installation) => ({ ...installation, versionText: "1.18.11" }),
            discoverProjects: async () => ({
                status: "complete",
                projects: [],
                diagnostics: [fact],
                evidenceLevel: "agent_runtime_verified",
            }),
        });
        expect(result.status).toBe(severity === "info" ? "complete" : "partial");
        expect(
            result.observation.observedAgentRuntimes.find((item) => item.agentRuntimeId === "OPENCODE_CLI")
                ?.projectDiscoveryStatus,
        ).toBe("complete");
        expect(result.diagnostics).toEqual([fact]);
    });

    it("starts exact CLI version and Project discovery observations before awaiting either", async () => {
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-opencode-probe-concurrency-"));
        const home = path.join(sandbox, "home");
        const bin = path.join(sandbox, "bin");
        const executablePath = path.join(bin, "opencode");
        fs.mkdirSync(home, { recursive: true });
        fs.mkdirSync(bin, { recursive: true });
        fs.writeFileSync(executablePath, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0]), { mode: 0o755 });

        let finishVersion: (() => void) | undefined;
        let finishProjects: (() => void) | undefined;
        const observeCliVersion = vi.fn(
            (installation: Parameters<NonNullable<Parameters<typeof probeOpencode>[4]["observeCliVersion"]>>[0]) =>
                new Promise<Awaited<ReturnType<NonNullable<Parameters<typeof probeOpencode>[4]["observeCliVersion"]>>>>(
                    (resolve) => {
                        finishVersion = () =>
                            resolve({
                                ...installation,
                                versionText: "1.18.11",
                                buildIdentity: `sha256:${"1".repeat(64)}`,
                                platform: "linux",
                            });
                    },
                ),
        );
        const discoverProjects = vi.fn(
            () =>
                new Promise<Awaited<ReturnType<NonNullable<Parameters<typeof probeOpencode>[4]["discoverProjects"]>>>>(
                    (resolve) => {
                        finishProjects = () =>
                            resolve({ status: "complete", projects: [], diagnostics: [], evidenceLevel: "local_artifact" });
                    },
                ),
        );

        const pending = probeOpencode(globalContext(), { PATH: bin }, home, "linux", {
            observeCliVersion,
            discoverProjects,
        });
        await Promise.resolve();
        expect(observeCliVersion).toHaveBeenCalledOnce();
        expect(discoverProjects).toHaveBeenCalledOnce();

        finishProjects?.();
        finishVersion?.();
        await expect(pending).resolves.toMatchObject({ status: "complete" });
    });
});
