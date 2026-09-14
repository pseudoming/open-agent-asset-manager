import { describe, expect, it } from "vitest";
import { countIncludedSourceLocations } from "../src/renderer/features/source-library/source-library-model";
import {
    buildSourceLibrary,
    filterSourceLibrary,
    findSourceEnvironment,
    findSourceLocation,
    sourceEnvironmentKey,
    sourceLocationKey,
} from "../src/renderer/features/source-library";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const ENVIRONMENT = { platform: "win32" as const, platformInstanceId: "desktop-local" };

function sourceSelector(
    adapterId: string,
    fingerprint: string,
    binding: { readonly assetScope: "global" } | { readonly assetScope: "project"; readonly projectId: string },
) {
    return {
        disposition: "included" as const,
        source: {
            adapterId,
            rootRole: "source" as const,
            sourceDomain: "family_shared" as const,
            canonicalPath: "C:\\Users\\person\\.claude",
            locatorIdentities: [{ locatorKind: "runtime_known_rule" as const, locatorKey: "user-config" }] as const,
        },
        agentRuntimeIds: adapterId === "CLAUDECODE" ? ["CLAUDE_CODE_CLI"] : ["OPENCODE_CLI"],
        binding,
        selectorFingerprint: fingerprint,
    };
}

describe("Import source library model", () => {
    it("counts included physical locations separately per Environment without counting exclusions or tool duplicates", () => {
        const included = sourceSelector("CLAUDECODE", DIGEST_A, { assetScope: "global" });
        const excluded = { ...included, disposition: "excluded" as const };
        const base = {
            configVersion: 1 as const,
            settingId: "watched_scan_intent_v1" as const,
            revision: 1,
            updatedAt: 1,
            userActionEvidenceId: "action",
            settingFingerprint: DIGEST_A,
        };
        expect(
            countIncludedSourceLocations({ ...base, environments: [{ environment: ENVIRONMENT, sourceSelectors: [excluded] }] }),
        ).toBe(0);
        expect(
            countIncludedSourceLocations({
                ...base,
                environments: [
                    {
                        environment: ENVIRONMENT,
                        sourceSelectors: [included, excluded, sourceSelector("OPENCODE", DIGEST_B, { assetScope: "global" })],
                    },
                    { environment: { platform: "wsl" as const, platformInstanceId: "Ubuntu" }, sourceSelectors: [included] },
                ],
            }),
        ).toBe(2);
    });
    it("groups exact Environment and canonical-path identities without inventing Asset membership", () => {
        const environments = buildSourceLibrary(
            [
                { adapterId: "CLAUDECODE", displayName: "Claude Code", agentRuntimes: [], capabilities: [] },
                { adapterId: "OPENCODE", displayName: "OpenCode", agentRuntimes: [], capabilities: [] },
            ],
            {
                configVersion: 1,
                settingId: "watched_scan_intent_v1",
                revision: 1,
                environments: [
                    {
                        environment: ENVIRONMENT,
                        sourceSelectors: [
                            sourceSelector("CLAUDECODE", DIGEST_A, { assetScope: "global" }),
                            sourceSelector("OPENCODE", DIGEST_B, { assetScope: "project", projectId: PROJECT_ID }),
                            {
                                ...sourceSelector("OPENCODE", "c".repeat(64), { assetScope: "global" }),
                                disposition: "excluded" as const,
                            },
                        ],
                    },
                ],
                userActionEvidenceId: "action-1",
                updatedAt: 1,
                settingFingerprint: "d".repeat(64),
            },
            [
                {
                    projectId: PROJECT_ID,
                    displayName: "OAAM",
                    rootPath: "C:\\work\\oaam",
                    deleted: false,
                    createdAt: 1,
                    updatedAt: 1,
                },
            ],
        );

        expect(environments).toHaveLength(1);
        expect(environments[0]?.key).toBe(sourceEnvironmentKey(ENVIRONMENT));
        expect(environments[0]?.sources).toHaveLength(1);
        const source = environments[0]?.sources[0];
        expect(source?.key).toBe(sourceLocationKey(ENVIRONMENT, "C:\\Users\\person\\.claude"));
        expect(source?.tools.map((tool) => tool.displayName)).toEqual(["Claude Code", "OpenCode"]);
        expect(source?.destinations).toEqual([
            { scope: "global" },
            { scope: "project", projectId: PROJECT_ID, projectName: "OAAM" },
        ]);
        expect(source?.claims).toHaveLength(2);
        expect(source === undefined ? true : "assets" in source).toBe(false);
        expect(findSourceEnvironment(environments, ENVIRONMENT)).toBe(environments[0]);
        expect(findSourceLocation(environments, ENVIRONMENT, source?.canonicalPath ?? "")).toBe(source);
        expect(filterSourceLibrary(environments, "opencode")).toEqual(environments);
        expect(filterSourceLibrary(environments, "not-present")).toEqual([]);
    });
});
