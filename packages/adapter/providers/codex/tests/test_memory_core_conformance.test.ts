import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SourceRoot, UuidV4 } from "@oaam/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readVersionAuthority } from "../../../core/src/catalog/version-authority";
import {
    clearRegistry,
    disableAdapter,
    enableAdapter,
    freezeRegistry,
    getRegisteredVersionDialectRegistry,
    registerAdapterProvider,
} from "../../../core/src/orchestration/adapter-registry";
import { executeAdapterReadWithAuthority } from "../../../core/src/source-import/source-read-execution";
import {
    bindAcceptFixtureCandidate,
    bindFixtureImportService,
    bindFixtureProbeRootTarget,
    fixtureSourceRoot,
} from "../../../test-support";
import { codexProvider } from "../src/codex-provider";

const PROJECT_ID = "00000000-0000-4000-8000-000000000159" as UuidV4;
const MEMORY = "# Codex Memory\n\nKeep exact current-build evidence.\n";
const SUMMARY = "v1\n\n## What's in Memory\n- exact current-build evidence\n";
const target = bindFixtureProbeRootTarget({
    adapterId: "CODEX",
    agentRuntimeId: "CODEX_CLI",
    versionText: "0.142.5-fixture",
    installationEvidence: [],
    installationStatus: "available",
    projectDiscoveryStatus: "complete",
});
const acceptCandidate = bindAcceptFixtureCandidate("codex-memory-core-conformance");

let sandbox = "";
let config = "";
let project = "";
let transactions = "";
let assets = "";
let oaam = "";
let locks = "";

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-codex-memory-conformance-"));
    config = path.join(sandbox, ".codex");
    project = path.join(sandbox, "project");
    transactions = path.join(sandbox, "transactions");
    assets = path.join(sandbox, "assets");
    oaam = path.join(sandbox, "oaam");
    locks = path.join(sandbox, "locks");
    for (const directory of [path.join(config, "memories"), project, transactions]) {
        fs.mkdirSync(directory, { recursive: true });
    }
    clearRegistry();
});

afterEach(() => {
    clearRegistry();
    fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("Codex Memory Core import conformance", () => {
    it("imports the runtime final pair and reopens its exact native graph after the Provider is disabled", async () => {
        fs.writeFileSync(path.join(config, "memories", "MEMORY.md"), MEMORY);
        fs.writeFileSync(path.join(config, "memories", "memory_summary.md"), SUMMARY);
        fs.writeFileSync(path.join(config, "memories", "raw_memories.md"), "runtime-private\n");
        const root = configRoot();
        const readTarget = target([root], ["Memory"]);
        const readAgain = async () => {
            const result = await executeAdapterReadWithAuthority(codexProvider, readTarget, {
                managedTargetGuards: [],
                reservationIdentityFingerprints: [],
                transactionsRoot: transactions,
            });
            if (result.status !== "complete") throw new Error(JSON.stringify(result.diagnostics, null, 2));
            return result.value;
        };
        const read = await readAgain();
        expect(read.candidates).toEqual([
            expect.objectContaining({
                kind: "Memory",
                scope: "global",
                status: "complete",
                nativeRepresentation: expect.objectContaining({ dialectId: "codex-consolidated-memory-v1" }),
            }),
        ]);
        expect(JSON.stringify(read.candidates)).not.toContain("runtime-private");

        const service = bindFixtureImportService({
            provider: codexProvider,
            assetsRoot: () => assets,
            oaamRoot: () => oaam,
            authorityLocksRoot: () => locks,
            projectRootPath: () => project,
            projectId: PROJECT_ID,
        })(readAgain);
        const candidate = read.candidates[0];
        if (candidate === undefined) throw new Error("missing Codex Memory candidate");
        const accepted = await acceptCandidate(service, read, candidate.candidateId);
        expect(accepted.status, JSON.stringify(accepted.diagnostics, null, 2)).toBe("complete");

        expect(registerAdapterProvider(codexProvider).status).toBe("complete");
        expect(enableAdapter("CODEX").status).toBe("complete");
        expect(freezeRegistry().status).toBe("complete");
        expect(disableAdapter("CODEX").status).toBe("complete");
        const closure = readVersionAuthority(
            assets,
            accepted.value.assetId,
            accepted.value.versionId,
            getRegisteredVersionDialectRegistry(),
        );
        expect(closure?.manifest.kind).toBe("Memory");
        expect(closure?.files).toEqual([expect.objectContaining({ text: MEMORY })]);
        expect(closure?.manifest.nativeRepresentations).toEqual([
            expect.objectContaining({
                dialectId: "codex-consolidated-memory-v1",
                files: [
                    expect.objectContaining({ relativePath: "memories/MEMORY.md" }),
                    expect.objectContaining({ relativePath: "memories/memory_summary.md" }),
                ],
            }),
        ]);
        expect(closure?.nativePayloads[0]?.files).toEqual([
            expect.objectContaining({ relativePath: "memories/MEMORY.md", bytes: Buffer.from(MEMORY) }),
            expect.objectContaining({ relativePath: "memories/memory_summary.md", bytes: Buffer.from(SUMMARY) }),
        ]);
    });
});

function configRoot(): SourceRoot {
    return fixtureSourceRoot({
        sourceRootId: "codex-memory-config",
        path: config,
        rootRole: "config",
        sourceDomain: "family_shared",
        locatorKind: "runtime_known_rule",
        locatorKey: "codex_home_default",
        evidenceLevel: "agent_runtime_verified",
    });
}
