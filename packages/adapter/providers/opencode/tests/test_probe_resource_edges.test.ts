import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    fixtureDirectoryProbeContext as directoryContext,
    fixtureGlobalProbeContext as globalContext,
    fixtureProjectProbeContext as projectContext,
} from "../../../test-support";
import { probeOpencode } from "../src/opencode-probe";

let sandbox = "";
let home = "";
let bin = "";

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-opencode-probe-edges-"));
    home = path.join(sandbox, "home");
    bin = path.join(sandbox, "bin");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
});

afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("OpenCode probe resource edges", () => {
    it("reports source/resource kind mismatches and symlinks without widening access", async () => {
        fs.mkdirSync(path.join(home, ".config"), { recursive: true });
        fs.writeFileSync(path.join(home, ".config", "opencode"), "not a directory");
        fs.mkdirSync(path.join(home, ".local", "share", "opencode", "opencode.db"), { recursive: true });
        fs.mkdirSync(path.join(home, ".agents"), { recursive: true });
        const sharedTarget = path.join(sandbox, "shared-target");
        fs.mkdirSync(sharedTarget);
        fs.symlinkSync(sharedTarget, path.join(home, ".agents", "skills"));

        const result = await probeOpencode(globalContext(), { PATH: "" }, home);
        expect(result.diagnostics.map((item) => item.code)).toEqual(
            expect.arrayContaining(["opencode_probe_resource_kind_mismatch", "opencode_probe_symlink_untrusted"]),
        );
        expect(result.observation.sourceRoots).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    path: path.join(home, ".config", "opencode"),
                    accessStatus: "unknown",
                }),
                expect.objectContaining({
                    path: path.join(home, ".agents", "skills"),
                    accessStatus: "unknown",
                }),
            ]),
        );
        expect(result.observation.agentRuntimeResources.find((item) => item.roles.includes("project_registry"))).toMatchObject({
            accessStatus: "unknown",
        });
    });

    it("keeps missing project roots and invalid external roots as partial discovery", async () => {
        const missingProject = path.join(sandbox, "missing-project");
        writeNative(path.join(bin, "opencode"));
        const project = await probeOpencode(projectContext(missingProject), { PATH: bin }, home);
        expect(project.status).toBe("partial");
        expect(project.observation.observedAgentRuntimes[0]?.projectDiscoveryStatus).toBe("partial");
        expect(project.observation.sourceRoots.find((root) => root.path === missingProject)?.accessStatus).toBe("not_found");
        expect(project.observation.targetCandidates[0]?.entryApplicabilities[0]).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "opencode_target_project_authority_incomplete" })],
        });

        const external = await probeOpencode(directoryContext("relative"), { PATH: "" }, home);
        expect(external.status).toBe("partial");
        expect(external.diagnostics).toContainEqual(expect.objectContaining({ code: "opencode_external_root_invalid" }));
    });
});

function writeNative(target: string): void {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0]), { mode: 0o755 });
}
