/** Real Core-port source isolation cases shared by Provider-owned suites. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixtureProbeRootTarget, fixtureSourceRoot } from "./test-support";
import { executeAdapterReadWithAuthority } from "../core/src/source-import/source-read-execution";
import type {
    AdapterProvider,
    AdapterReadTarget,
    AgentRuntimeId,
    AssetKind,
    ManagedTargetReadGuard,
    Sha256Digest,
} from "../core/src/types";

export const MANAGED_SOURCE_DIGEST: Sha256Digest = `sha256:${"a".repeat(64)}`;
export const MANAGED_SOURCE_DEPLOYMENT = "00000000-0000-4000-8000-000000000911";
const DIGEST = MANAGED_SOURCE_DIGEST;
const DEPLOYMENT = MANAGED_SOURCE_DEPLOYMENT;
export interface ManagedSourceSpec {
    provider: AdapterProvider;
    agentRuntimeId: AgentRuntimeId;
    base: string;
    sourceSelection?: "user_selected";
}
export function createManagedSourceFixture(sandbox: string, spec: ManagedSourceSpec) {
    const rootPath = path.join(sandbox, "project");
    fs.mkdirSync(rootPath);
    fs.mkdirSync(path.join(sandbox, "transactions"));
    for (const name of ["managed", "managed-neighbor"]) {
        const folder = path.join(rootPath, spec.base, name);
        fs.mkdirSync(path.join(folder, "empty", "nested"), { recursive: true });
        fs.mkdirSync(path.join(folder, "resources"));
        fs.writeFileSync(
            path.join(folder, "SKILL.md"),
            `---\nname: ${name}\ndescription: Review local documentation.\n---\nKeep the complete resource graph.\n`,
        );
        fs.writeFileSync(path.join(folder, "resources", "check.sh"), "#!/bin/sh\nprintf 'review\\n'\n", { mode: 0o755 });
    }
    fs.writeFileSync(path.join(rootPath, "AGENTS.md"), "# Project guidance\nKeep each independent source complete.\n");
    const sourceRoot = fixtureSourceRoot({
        sourceRootId: "source",
        path: rootPath,
        rootRole: spec.sourceSelection === "user_selected" ? "source" : "project_actual",
        sourceDomain: spec.sourceSelection === "user_selected" ? "external_managed" : "project_root",
        locatorKind: "user_provided_path",
        locatorKey: "probe_project_root",
        evidenceLevel: "user_provided",
    });
    const target: AdapterReadTarget =
        spec.sourceSelection === "user_selected"
            ? {
                  adapterId: spec.provider.adapterId,
                  allowedKinds: ["Skill"],
                  sourceSelector: {
                      selectorKind: "user_selected_root",
                      platformContext: { platform: "linux", platformInstanceId: "fixture", accessRootPath: sandbox },
                      binding: { sourceRoot, assetScope: "project", projectRootPath: rootPath },
                  },
              }
            : fixtureProbeRootTarget({
                  adapterId: spec.provider.adapterId,
                  agentRuntimeId: spec.agentRuntimeId,
                  versionText: "fixture",
                  sourceRoots: [sourceRoot],
                  allowedKinds: ["Skill"],
                  installationEvidence: [],
                  installationStatus: "available",
                  projectDiscoveryStatus: "complete",
              });
    const guard: ManagedTargetReadGuard = {
        sourceRootId: "source",
        matchKind: "directory_prefix",
        relativePath: `${spec.base}/managed`,
        managementState: "active_managed",
        deploymentId: DEPLOYMENT,
        outputUnitFingerprint: DIGEST,
    };
    return {
        rootPath,
        target,
        guard,
        async read(
            guards: ManagedTargetReadGuard[] = [guard],
            kinds: AssetKind[] = ["Skill"],
            provider: AdapterProvider = spec.provider,
            current = () => true,
        ) {
            return executeAdapterReadWithAuthority(
                provider,
                { ...target, allowedKinds: kinds },
                {
                    managedTargetGuards: guards,
                    reservationIdentityFingerprints: guards.some((g) => g.managementState === "in_flight_managed")
                        ? [DIGEST]
                        : [],
                    transactionsRoot: path.join(sandbox, "transactions"),
                },
                current,
            );
        },
    };
}

export function registerManagedSourceNeighborConformance(spec: ManagedSourceSpec): void {
    describe(`${spec.agentRuntimeId} independent managed source exclusion`, () => {
        let sandbox = "";
        beforeEach(() => {
            sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-managed-source-neighbor-"));
        });
        afterEach(() => {
            fs.rmSync(sandbox, { recursive: true, force: true });
        });
        it.each([
            "active_managed",
            "residual_managed",
        ] as const)("retains the complete neighboring Skill beside a %s leaf", async (state) => {
            const f = createManagedSourceFixture(sandbox, spec),
                result = await f.read([{ ...f.guard, managementState: state }]);
            expect(result.status, JSON.stringify(result.diagnostics)).toBe("complete");
            expect(result.value.candidates.map((c) => c.displayName)).toEqual(["managed-neighbor"]);
            const candidate = result.value.candidates[0];
            expect(candidate?.assetCandidateStatus).toBe("importable");
            expect(candidate?.nativeRepresentation).toMatchObject({
                representationSource: "separate_file_graph",
                files: [
                    expect.objectContaining({ relativePath: `${spec.base}/managed-neighbor/SKILL.md` }),
                    expect.objectContaining({
                        relativePath: `${spec.base}/managed-neighbor/resources/check.sh`,
                        executable: true,
                    }),
                ],
                directories: ["", "/empty", "/empty/nested", "/resources"].map((suffix) => ({
                    relativePath: `${spec.base}/managed-neighbor${suffix}`,
                })),
            });
            expect(
                result.value.observedReadEntries.some(
                    (e) => e.relativePath === `${spec.base}/managed` || e.relativePath.startsWith(`${spec.base}/managed/`),
                ),
            ).toBe(false);
            expect(result.value.sourceParseReports.flatMap((r) => r.readEntryDispositions)).toContainEqual(
                expect.objectContaining({ disposition: "ignored", reasonCode: "oaam_managed_source_entry" }),
            );
            expect(result.value.readAccessOutcomes.every((o) => o.status === "succeeded")).toBe(true);
        });
        it("excludes an independently managed SKILL.md file beside a complete new Skill", async () => {
            const f = createManagedSourceFixture(sandbox, spec);
            const result = await f.read([
                {
                    sourceRootId: "source",
                    matchKind: "exact_file",
                    relativePath: `${spec.base}/managed/SKILL.md`,
                    managementState: "active_managed",
                    deploymentId: DEPLOYMENT,
                    appliedContentHash: DIGEST,
                },
            ]);
            expect(result.status, JSON.stringify(result.diagnostics)).toBe("complete");
            expect(result.value.candidates.map((c) => c.displayName)).toEqual(["managed-neighbor"]);
            expect(
                result.value.readAccessOutcomes.some(
                    (o) => o.relativePath === `${spec.base}/managed/SKILL.md` && o.operation === "read_file",
                ),
            ).toBe(false);
            expect(result.value.candidates[0]?.nativeRepresentation).toMatchObject({
                files: [
                    expect.objectContaining({ relativePath: `${spec.base}/managed-neighbor/SKILL.md` }),
                    expect.objectContaining({
                        relativePath: `${spec.base}/managed-neighbor/resources/check.sh`,
                        executable: true,
                    }),
                ],
            });
        });

        it("does not hide a guarded nested SKILL.md from its enclosing source graph", async () => {
            const f = createManagedSourceFixture(sandbox, spec),
                relativePath = `${spec.base}/managed-neighbor/resources/SKILL.md`;
            fs.writeFileSync(
                path.join(f.rootPath, relativePath),
                "---\nname: nested\ndescription: Nested source\n---\nKeep the enclosing graph.\n",
            );
            const result = await f.read([
                {
                    sourceRootId: "source",
                    matchKind: "exact_file",
                    relativePath,
                    managementState: "active_managed",
                    deploymentId: DEPLOYMENT,
                    appliedContentHash: DIGEST,
                },
            ]);
            expect(result.status).not.toBe("complete");
            expect(result.value.readAccessOutcomes).toContainEqual(
                expect.objectContaining({ status: "blocked_managed_target", relativePath }),
            );
        });

        it("keeps a managed resource inside an unmanaged Skill as a real read failure", async () => {
            const f = createManagedSourceFixture(sandbox, spec);
            const result = await f.read([
                {
                    sourceRootId: "source",
                    matchKind: "exact_file",
                    relativePath: `${spec.base}/managed-neighbor/resources/check.sh`,
                    managementState: "active_managed",
                    deploymentId: DEPLOYMENT,
                    appliedContentHash: DIGEST,
                },
            ]);
            expect(result.status).not.toBe("complete");
            expect(result.value.readAccessOutcomes).toContainEqual(
                expect.objectContaining({
                    status: "blocked_managed_target",
                    relativePath: `${spec.base}/managed-neighbor/resources/check.sh`,
                }),
            );
        });
    });
}
