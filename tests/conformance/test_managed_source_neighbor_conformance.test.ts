/** Independent source leaves stay importable beside durable managed output, without reading that output. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { antigravityProvider } from "../../packages/adapter/providers/antigravity/src/antigravity-provider";
import { claudecodeProvider } from "../../packages/adapter/providers/claudecode/src/claudecode-provider";
import { codexProvider } from "../../packages/adapter/providers/codex/src/codex-provider";
import { cursorProvider } from "../../packages/adapter/providers/cursor/src/cursor-provider";
import { opencodeProvider } from "../../packages/adapter/providers/opencode/src/opencode-provider";
import { zcodeProvider } from "../../packages/adapter/providers/zcode/src/zcode-provider";
import {
    createManagedSourceFixture,
    MANAGED_SOURCE_DIGEST as DIGEST,
    MANAGED_SOURCE_DEPLOYMENT as DEPLOYMENT,
    type ManagedSourceSpec,
} from "../../packages/adapter/test-support-managed-source";
import type { AdapterProvider } from "../../packages/core/src/types";
const CASES = [
    { provider: claudecodeProvider, agentRuntimeId: "CLAUDE_CODE_CLI", base: ".claude/skills" },
    { provider: antigravityProvider, agentRuntimeId: "ANTIGRAVITY_CLI", base: ".agents/skills" },
    { provider: codexProvider, agentRuntimeId: "CODEX_CLI", base: ".agents/skills" },
    { provider: cursorProvider, agentRuntimeId: "CURSOR_AGENT_CLI", base: ".cursor/skills" },
    { provider: opencodeProvider, agentRuntimeId: "OPENCODE_CLI", base: ".opencode/skills" },
    { provider: zcodeProvider, agentRuntimeId: "ZCODE_APP", base: ".zcode/skills", sourceSelection: "user_selected" },
] as const;
let sandbox = "";
beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-managed-source-neighbor-"));
});
afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
});

function fixture(spec: ManagedSourceSpec) {
    return createManagedSourceFixture(sandbox, spec);
}

describe("managed exclusion keeps root, nested and changing authority failures", () => {
    const spec = CASES[2];
    it("still reads independent Codex Guidance without traversing the managed Skill subtree", async () => {
        const f = fixture(spec),
            result = await f.read([f.guard], ["Guidance", "Skill"]);
        expect(result.status, JSON.stringify(result.diagnostics)).toBe("complete");
        expect(result.value.candidates.map((c) => c.displayName).sort()).toEqual(["AGENTS.md", "managed-neighbor"]);
    });
    it("does not hide an in-flight child reservation beneath an active managed directory", async () => {
        const f = fixture(spec),
            result = await f.read([
                f.guard,
                {
                    sourceRootId: "source",
                    matchKind: "exact_file",
                    relativePath: `${spec.base}/managed/SKILL.md`,
                    managementState: "in_flight_managed",
                    deploymentId: DEPLOYMENT,
                    reservationIdentityFingerprint: DIGEST,
                },
            ]);
        expect(result.status).not.toBe("complete");
        expect(result.value.readAccessOutcomes.some((o) => o.status === "blocked_managed_target")).toBe(true);
    });
    it("keeps an explicitly selected managed root blocked", async () => {
        const f = fixture(spec),
            result = await f.read([
                {
                    sourceRootId: "source",
                    matchKind: "entire_root",
                    managementState: "active_managed",
                    deploymentId: DEPLOYMENT,
                    outputUnitFingerprint: DIGEST,
                },
            ]);
        expect(result.status).not.toBe("complete");
        expect(result.value.candidates).toEqual([]);
        expect(result.value.readAccessOutcomes).toContainEqual(
            expect.objectContaining({ operation: "resolve_root", status: "blocked_managed_target" }),
        );
    });
    it("does not drop a managed nested resource directory from an unmanaged complete Skill", async () => {
        const f = fixture(spec),
            result = await f.read([{ ...f.guard, relativePath: `${spec.base}/managed-neighbor/resources` }]);
        expect(result.status).not.toBe("complete");
        expect(result.value.readAccessOutcomes.some((o) => o.status === "blocked_managed_target")).toBe(true);
    });
    it("still fails stale when authority changes after Provider parsing", async () => {
        const f = fixture(spec);
        let current = true;
        const provider: AdapterProvider = {
            ...spec.provider,
            async read(input) {
                const parsed = await spec.provider.read(input);
                current = false;
                return parsed;
            },
        };
        const result = await f.read([f.guard], ["Skill"], provider, () => current);
        expect(result.status).not.toBe("complete");
        expect(result.value.readAccessOutcomes.some((o) => o.status === "stale")).toBe(true);
    });
    it("allows an OpenCode namespace leaf at depth without assuming all nested directories are independent Skills", async () => {
        const nested = { ...CASES[4], base: ".opencode/skills/team" };
        const f = fixture(nested),
            result = await f.read();
        expect(result.status, JSON.stringify(result.diagnostics)).toBe("complete");
        expect(result.value.candidates.map((c) => c.displayName)).toEqual(["managed-neighbor"]);
    });
    it("does not hide a guarded OpenCode resource below a parent SKILL.md", async () => {
        const f = fixture(CASES[4]);
        fs.writeFileSync(
            path.join(f.rootPath, ".opencode/skills/SKILL.md"),
            "---\nname: parent\ndescription: Parent Skill\n---\nKeep every resource.\n",
        );
        const result = await f.read();
        expect(result.status).not.toBe("complete");
        expect(result.value.readAccessOutcomes.some((o) => o.status === "blocked_managed_target")).toBe(true);
    });
});
