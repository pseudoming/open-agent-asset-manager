import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeCodexForSelectedWslHost } from "../../../adapter/providers/codex/src/codex-probe";
import { stableCodexId } from "../../../adapter/providers/codex/src/codex-probe-foundation";
import { parseOpenCodeProjectList } from "../../../adapter/providers/opencode/src/opencode-probe-project-payload";
import {
    classifyDiscoverySources,
    type ProbeReviewView,
    type WatchedScanIntentView,
} from "../src/renderer/features/discovery/discovery-model";

let root = "";
afterEach(() => {
    if (root !== "") fs.rmSync(root, { recursive: true, force: true });
    root = "";
});

describe("restricted probe preserves saved source decisions", () => {
    it.each([
        "included",
        "excluded",
    ] as const)("retains %s Codex/OpenCode sources when fresh snapshot IDs change", async (disposition) => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-probe-watch-identity-"));
        const home = path.join(root, "home"),
            project = path.join(root, "project"),
            config = path.join(home, ".codex", "config.toml");
        fs.mkdirSync(path.dirname(config), { recursive: true });
        fs.mkdirSync(project);
        fs.writeFileSync(config, `[projects.'${project}']\ntrust_level = 'trusted'\n`);
        const environment = { platform: "wsl" as const, platformInstanceId: "Ubuntu" };
        const hostPath = (local: string) => `\\\\wsl.localhost\\Ubuntu${local.replaceAll("/", "\\")}`;
        const result = await probeCodexForSelectedWslHost(
            { authorizationScope: "global", platformContext: { ...environment, accessRootPath: root } },
            { ...environment, accessRootPath: hostPath(root) },
            { PATH: "" },
            home,
            "linux",
        );
        const resource = result.observation.agentRuntimeResources.find((value) => value.roles.includes("project_registry"))!;
        const codexRoot = result.observation.sourceRoots.find(
            (value) => value.sourceRootId === result.observation.observedProjects[0]!.workspaces[0]!.sourceRootId,
        )!;
        const oldCodexRegistry = stableCodexId("resource", `${resource.roles.join(",")}\0${hostPath(config)}`);
        const oldCodexLocator = stableCodexId("project-registry-entry", `${oldCodexRegistry}\0${project}`);
        const openCodeRecord = parseOpenCodeProjectList(
            Buffer.from(JSON.stringify([{ id: "project-key", worktree: project, sandboxes: [] }])),
            "profile_debug_scrap",
        )[0]!;
        for (const [adapterId, oldLocator, freshLocator] of [
            ["CODEX", oldCodexLocator, codexRoot.locatorEvidence[0]!.locatorKey],
            ["OPENCODE", "stopped_debug_scrap:project-key", openCodeRecord.locatorKey],
        ] as const) {
            const agentRuntimeId = `${adapterId}_CLI`;
            const selectorBase = {
                agentRuntimeIds: [agentRuntimeId] as const,
                source: {
                    adapterId,
                    rootRole: "project_actual" as const,
                    sourceDomain: "project_root" as const,
                    canonicalPath: hostPath(project),
                    locatorIdentities: [{ locatorKind: "project_registry_entry", locatorKey: oldLocator }] as const,
                },
                selectorFingerprint: "a".repeat(64),
            };
            const selector =
                disposition === "included"
                    ? { ...selectorBase, disposition, binding: { assetScope: "global" as const } }
                    : { ...selectorBase, disposition };
            const watched: WatchedScanIntentView = {
                configVersion: 1,
                settingId: "watched_scan_intent_v1",
                revision: 1,
                environments: [{ environment, sourceSelectors: [selector] }],
                userActionEvidenceId: "user-1",
                updatedAt: 1,
                settingFingerprint: "b".repeat(64),
            };
            const fresh: ProbeReviewView = {
                probeToken: "fresh-probe",
                results: [
                    {
                        rowId: "fresh-result",
                        adapterId,
                        environment,
                        status: "complete",
                        runtimes: [
                            {
                                rowId: "fresh-runtime",
                                agentRuntimeId,
                                versionText: "",
                                installationStatus: "available",
                                projectDiscoveryStatus: "complete",
                                sourceRootRowIds: ["fresh-row"],
                                diagnostics: [],
                            },
                        ],
                        sources: [
                            {
                                rowId: "fresh-row",
                                displayPath: hostPath(project),
                                accessStatus: "available",
                                diagnostics: [],
                                sourceRootId: "different-snapshot-id",
                                rootRole: "project_actual",
                                sourceDomain: "project_root",
                                locatorIdentities: [{ locatorKind: "project_registry_entry", locatorKey: freshLocator }],
                            },
                        ],
                        projects: [],
                        targets: [],
                        diagnostics: [],
                    },
                ],
            };
            const current = classifyDiscoverySources(watched, fresh);
            expect(current).toHaveLength(1);
            expect(current[0]).toMatchObject({
                status: "current",
                watchAvailability: { status: "selectable", prior: { disposition } },
                displayPath: hostPath(project),
            });
            const changed: ProbeReviewView = {
                ...fresh,
                results: fresh.results.map((result) => ({
                    ...result,
                    sources: result.sources.map((source) => ({
                        ...source,
                        locatorIdentities: [
                            {
                                ...source.locatorIdentities[0],
                                locatorKey: `${source.locatorIdentities[0].locatorKey}-changed`,
                            },
                            ...source.locatorIdentities.slice(1),
                        ] as const,
                    })),
                })),
            };
            expect(classifyDiscoverySources(watched, changed).some((source) => source.status === "current")).toBe(false);
        }
    });
});
