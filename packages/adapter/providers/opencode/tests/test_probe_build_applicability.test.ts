import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateAdapterProbeResult } from "../../../core/src/adapters/adapter-contract-validator";
import { fixtureProjectProbeContext as projectContext } from "../../../test-support";
import { probeOpencode } from "../src/opencode-probe";
import type { OpenCodeCliInstallationObservation, OpenCodeCliVersionedInstallation } from "../src/opencode-probe-cli-version";
import { opencodeProvider } from "../src/opencode-provider";

let sandbox = "";
let home = "";
let bin = "";

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-opencode-probe-build-"));
    home = path.join(sandbox, "home");
    bin = path.join(sandbox, "bin");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
});

afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("OpenCode probe build applicability", () => {
    it("offers a project Guidance target only with current project and build-bearing CLI evidence", async () => {
        const project = path.join(sandbox, "project");
        fs.mkdirSync(project);
        writeNative(path.join(bin, "opencode"));

        const context = projectContext(project, "wsl");
        const ready = await probeOpencode(context, { PATH: bin }, home, "linux", {
            observeCliVersion: fixtureVersionObservation,
        });
        expect(ready.observation.targetCandidates).toEqual([
            expect.objectContaining({
                targetRootPath: project,
                entryApplicabilities: [
                    expect.objectContaining({
                        agentRuntimeId: "OPENCODE_CLI",
                        status: "ready_for_plan",
                        diagnostics: [expect.objectContaining({ code: "opencode_target_build_compatibility_inferred" })],
                    }),
                    expect.objectContaining({
                        agentRuntimeId: "OPENCODE_APP",
                        status: "invalid",
                        diagnostics: [expect.objectContaining({ code: "opencode_app_target_installation_not_found" })],
                    }),
                ],
            }),
        ]);
        expect(validateAdapterProbeResult(opencodeProvider, ready, context.platformContext)).toEqual([]);

        const missing = await probeOpencode(context, { PATH: "" }, home, "linux", {
            observeCliVersion: fixtureVersionObservation,
        });
        expect(missing.observation.targetCandidates[0]?.entryApplicabilities[0]).toMatchObject({
            status: "invalid",
            diagnostics: [expect.objectContaining({ code: "opencode_target_installation_not_found" })],
        });

        fs.writeFileSync(path.join(bin, "opencode"), "#!/bin/sh\n", { mode: 0o755 });
        const untrusted = await probeOpencode(context, { PATH: bin }, home, "linux", {
            observeCliVersion: fixtureVersionObservation,
        });
        expect(untrusted.observation.targetCandidates[0]?.entryApplicabilities[0]).toMatchObject({
            status: "unknown",
            diagnostics: [expect.objectContaining({ code: "opencode_target_build_evidence_unavailable" })],
        });
    });
});

function writeNative(target: string): void {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0]), { mode: 0o755 });
}

async function fixtureVersionObservation(
    installation: OpenCodeCliInstallationObservation,
    platformContext: Parameters<typeof probeOpencode>[0]["platformContext"],
): Promise<OpenCodeCliVersionedInstallation> {
    return {
        ...installation,
        versionText: "1.18.11",
        buildIdentity: "sha256:8eb15fe87080dd11aa095cc0391eb3536d55a46fa9e4427c6a8b664d390ac089",
        platform: platformContext.platform,
    };
}
