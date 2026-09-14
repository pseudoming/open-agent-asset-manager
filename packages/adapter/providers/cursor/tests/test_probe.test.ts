import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CURSOR_PROBE_FOR_TEST, probeCursor } from "../src/cursor-probe";

describe("Cursor probe", () => {
    it("discovers Cursor Agent from PATH and restricts a user-selected probe to that exact folder", async () => {
        const root = mkdtempSync(join(tmpdir(), "oaam-cursor-installation-root-"));
        try {
            const home = join(root, "home");
            const pathRoot = join(root, "path-bin");
            const selectedRoot = join(root, "selected-bin");
            const emptyRoot = join(root, "empty-bin");
            mkdirSync(home, { recursive: true });
            mkdirSync(pathRoot, { recursive: true });
            mkdirSync(selectedRoot, { recursive: true });
            mkdirSync(emptyRoot, { recursive: true });
            writeFileSync(join(pathRoot, "cursor-agent"), "PATH fixture");
            writeFileSync(join(selectedRoot, "cursor-agent"), "selected fixture");
            const context = { platform: "linux" as const, platformInstanceId: "fixture", accessRootPath: root };

            await expect(
                CURSOR_PROBE_FOR_TEST.findCursorAgentInstallation({ PATH: pathRoot }, home, context),
            ).resolves.toMatchObject({
                status: "available",
                evidence: [expect.objectContaining({ path: join(pathRoot, "cursor-agent") })],
            });
            await expect(
                CURSOR_PROBE_FOR_TEST.findCursorAgentInstallation({ PATH: pathRoot }, home, context, selectedRoot),
            ).resolves.toMatchObject({
                status: "available",
                evidence: [expect.objectContaining({ path: join(selectedRoot, "cursor-agent") })],
            });
            await expect(
                CURSOR_PROBE_FOR_TEST.findCursorAgentInstallation({ PATH: pathRoot }, home, context, emptyRoot),
            ).resolves.toMatchObject({
                status: "not_found",
                evidence: [expect.objectContaining({ path: join(emptyRoot, "cursor-agent") })],
            });
            await expect(
                CURSOR_PROBE_FOR_TEST.findCursorAgentInstallation({ PATH: "\\\\server\\share" }, home, context),
            ).resolves.toMatchObject({
                status: "unknown",
                diagnostics: [
                    expect.objectContaining({
                        code: "cursor_agent_install_discovery_incomplete",
                        message: "Cursor installation candidates could not all be checked in the selected environment",
                    }),
                ],
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("uses a selected Cursor App folder without borrowing an explicit executable", () => {
        const root = mkdtempSync(join(tmpdir(), "oaam-cursor-app-installation-root-"));
        try {
            const home = join(root, "home");
            const selectedRoot = join(root, "selected-app");
            const selectedExecutable = join(selectedRoot, "cursor");
            const unrelatedExecutable = join(root, "unrelated-app", "cursor");
            mkdirSync(home, { recursive: true });
            mkdirSync(join(selectedRoot, "resources", "app"), { recursive: true });
            mkdirSync(join(root, "unrelated-app"), { recursive: true });
            writeFileSync(selectedExecutable, "selected fixture");
            writeFileSync(join(selectedRoot, "resources", "app", "product.json"), JSON.stringify({ version: "3.13.25" }));
            writeFileSync(unrelatedExecutable, "unrelated fixture");
            const context = { platform: "linux" as const, platformInstanceId: "fixture", accessRootPath: root };

            expect(
                CURSOR_PROBE_FOR_TEST.findCursorAppInstallation(
                    { CURSOR_APP_EXECUTABLE: unrelatedExecutable },
                    home,
                    context,
                    selectedRoot,
                ),
            ).toMatchObject({
                status: "available",
                versionText: "3.13.25",
                evidence: [
                    expect.objectContaining({ kind: "executable", path: selectedExecutable }),
                    expect.objectContaining({ kind: "install_root", path: selectedRoot }),
                ],
            });
            expect(
                CURSOR_PROBE_FOR_TEST.findCursorAppInstallation(
                    { CURSOR_APP_EXECUTABLE: unrelatedExecutable },
                    home,
                    context,
                    join(root, "empty-app"),
                ),
            ).toMatchObject({
                status: "not_found",
                evidence: [expect.objectContaining({ path: join(root, "empty-app", "cursor") })],
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("binds the exact physical CLI launcher and one invocation Project without inventing a registry", async () => {
        const root = mkdtempSync(join(tmpdir(), "oaam-cursor-probe-"));
        const home = join(root, "home");
        const versionRoot = join(home, ".local", "share", "cursor-agent", "versions", "2026.07.23-e383d2b");
        const binRoot = join(home, ".local", "bin");
        const configRoot = join(home, ".cursor");
        const sharedSkillRoot = join(home, ".agents", "skills");
        const project = join(root, "project");
        mkdirSync(versionRoot, { recursive: true });
        mkdirSync(binRoot, { recursive: true });
        mkdirSync(configRoot, { recursive: true });
        mkdirSync(sharedSkillRoot, { recursive: true });
        mkdirSync(project, { recursive: true });
        const launcher = join(versionRoot, "cursor-agent");
        writeFileSync(launcher, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
        symlinkSync(launcher, join(binRoot, "cursor-agent"));
        const result = await probeCursor(
            {
                authorizationScope: "project",
                projectRootPath: project,
                platformContext: { platform: "wsl", platformInstanceId: "wsl:fixture", accessRootPath: root },
            },
            {},
            home,
            "linux",
        );
        expect(result.status).toBe("partial");
        expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "cursor_app_install_discovery_incomplete" }));
        expect(result.observation.observedAgentRuntimes).toEqual([
            expect.objectContaining({
                agentRuntimeId: "CURSOR_AGENT_CLI",
                versionText: "2026.07.23-e383d2b",
                installationStatus: "available",
                projectDiscoveryStatus: "complete",
                installationEvidence: [{ kind: "launcher", path: launcher, evidenceLevel: "local_artifact", diagnostics: [] }],
            }),
            expect.objectContaining({
                agentRuntimeId: "CURSOR_APP",
                installationStatus: "unknown",
                projectDiscoveryStatus: "complete",
            }),
        ]);
        expect(result.observation.observedProjects).toEqual([
            expect.objectContaining({
                runtimeProjectKey: project,
                displayName: "project",
                evidence: [expect.objectContaining({ evidenceKind: "invocation", locatorKey: "probe_project_root" })],
            }),
        ]);
        expect(result.observation.sourceRoots[0]?.locatorEvidence).toEqual([
            expect.objectContaining({ locatorKind: "user_provided_path", locatorKey: "probe_project_root" }),
        ]);
        expect(result.observation.sourceRoots[1]).toMatchObject({
            path: configRoot,
            rootRole: "config",
            sourceDomain: "agent_runtime_private",
            accessStatus: "available",
            locatorEvidence: [
                expect.objectContaining({ locatorKind: "runtime_known_rule", locatorKey: "cursor_user_config_root" }),
            ],
        });
        expect(result.observation.targetCandidates[0]).toMatchObject({
            targetRootPath: project,
            entryApplicabilities: [
                { agentRuntimeId: "CURSOR_AGENT_CLI", status: "ready_for_plan" },
                { agentRuntimeId: "CURSOR_APP", status: "unknown" },
            ],
        });
        expect(result.observation.targetCandidates[1]).toMatchObject({
            targetRootPath: configRoot,
            targetKind: "global",
            entryApplicabilities: [
                { agentRuntimeId: "CURSOR_AGENT_CLI", status: "ready_for_plan" },
                { agentRuntimeId: "CURSOR_APP", status: "unknown" },
            ],
        });
        expect(result.observation.sourceRoots[2]).toMatchObject({
            path: sharedSkillRoot,
            rootRole: "source",
            sourceDomain: "family_shared",
            accessStatus: "available",
        });
        expect(result.observation.targetCandidates[2]).toMatchObject({
            targetRootPath: sharedSkillRoot,
            targetKind: "directory",
            entryApplicabilities: [
                {
                    agentRuntimeId: "CURSOR_AGENT_CLI",
                    status: "ready_for_plan",
                    locatorEvidence: [
                        expect.objectContaining({
                            locatorKey: "cursor_shared_skill_root",
                            evidenceLevel: "local_artifact",
                        }),
                    ],
                },
                { agentRuntimeId: "CURSOR_APP", status: "unknown" },
            ],
        });
    });

    it("reports global absence honestly and fails closed for an out-of-root Project", async () => {
        const root = mkdtempSync(join(tmpdir(), "oaam-cursor-probe-edge-"));
        const home = join(root, "home");
        mkdirSync(home, { recursive: true });
        const global = await probeCursor(
            {
                authorizationScope: "global",
                platformContext: { platform: "linux", platformInstanceId: "linux:fixture", accessRootPath: root },
            },
            {},
            home,
            "linux",
        );
        expect(global.status).toBe("partial");
        expect(global.diagnostics).toContainEqual(expect.objectContaining({ code: "cursor_app_install_discovery_incomplete" }));
        expect(global.observation.observedProjects).toEqual([]);
        expect(global.observation.observedAgentRuntimes.every((row) => row.projectDiscoveryStatus === "not_found")).toBe(true);

        const invalid = await probeCursor(
            {
                authorizationScope: "project",
                projectRootPath: "/outside/project",
                platformContext: { platform: "linux", platformInstanceId: "linux:fixture", accessRootPath: root },
            },
            {},
            home,
            "linux",
        );
        expect(invalid.status).toBe("partial");
        expect(invalid.diagnostics).toContainEqual(expect.objectContaining({ code: "cursor_project_root_invalid" }));
        expect(invalid.observation.observedProjects).toEqual([]);
    });

    it("retains the checked launcher path without treating a dangling or out-of-root link as available", async () => {
        const root = mkdtempSync(join(tmpdir(), "oaam-cursor-probe-link-"));
        const home = join(root, "home");
        const binRoot = join(home, ".local", "bin");
        mkdirSync(binRoot, { recursive: true });
        symlinkSync("/outside/cursor-agent", join(binRoot, "cursor-agent"));
        const result = await probeCursor(
            {
                authorizationScope: "global",
                platformContext: { platform: "wsl", platformInstanceId: "wsl:fixture", accessRootPath: root },
            },
            {},
            home,
            "linux",
        );
        expect(result.observation.observedAgentRuntimes[0]).toMatchObject({ installationStatus: "not_found" });
        expect(result.observation.observedAgentRuntimes[0]?.installationEvidence).toEqual([
            expect.objectContaining({ kind: "executable", path: join(binRoot, "cursor-agent") }),
        ]);
    });

    it("binds a valid App package candidate and reports exact metadata failures", () => {
        const root = mkdtempSync(join(tmpdir(), "oaam-cursor-app-candidate-"));
        const installRoot = join(root, "Cursor");
        const executable = join(installRoot, "cursor");
        const productPath = join(installRoot, "resources", "app", "product.json");
        mkdirSync(join(installRoot, "resources", "app"), { recursive: true });
        writeFileSync(executable, "binary", { mode: 0o755 });
        writeFileSync(productPath, JSON.stringify({ version: "3.13.25" }));
        const context = { platform: "linux" as const, platformInstanceId: "linux:test", accessRootPath: root };

        expect(CURSOR_PROBE_FOR_TEST.inspectCursorAppCandidate(executable, context)).toMatchObject({
            status: "available",
            versionText: "3.13.25",
            evidence: [
                { kind: "executable", path: executable },
                { kind: "install_root", path: installRoot },
            ],
            diagnostics: [],
        });
        writeFileSync(productPath, "{not-json");
        expect(CURSOR_PROBE_FOR_TEST.inspectCursorAppCandidate(executable, context)).toMatchObject({
            status: "available",
            versionText: "",
            diagnostics: [{ code: "cursor_app_version_unavailable" }],
        });
        expect(CURSOR_PROBE_FOR_TEST.inspectCursorAppCandidate(join(root, "missing"), context)).toBeNull();
        expect(CURSOR_PROBE_FOR_TEST.inspectCursorAppCandidate("/outside/cursor", context)).toBeNull();
    });

    it("covers invalid versions, path kinds, missing roots, and unreachable platform selection", async () => {
        const root = mkdtempSync(join(tmpdir(), "oaam-cursor-probe-dispositions-"));
        const home = join(root, "home");
        const custom = join(root, "custom");
        const launcher = join(custom, "cursor-agent");
        const directory = join(root, "directory");
        mkdirSync(home, { recursive: true });
        mkdirSync(custom);
        mkdirSync(directory);
        writeFileSync(launcher, "launcher", { mode: 0o755 });
        const context = { platform: "linux" as const, platformInstanceId: "linux:test", accessRootPath: root };

        await expect(
            CURSOR_PROBE_FOR_TEST.findCursorAgentInstallation({ CURSOR_AGENT_EXECUTABLE: launcher }, home, context),
        ).resolves.toMatchObject({
            status: "available",
            versionText: "",
            diagnostics: [{ code: "cursor_agent_version_unavailable" }],
        });
        expect(CURSOR_PROBE_FOR_TEST.resolveRegularFile(join(root, "missing"), context)).toBeNull();
        expect(CURSOR_PROBE_FOR_TEST.inspectPath(directory, "directory")).toEqual({ status: "available", diagnostics: [] });
        expect(CURSOR_PROBE_FOR_TEST.inspectPath(launcher, "directory")).toMatchObject({
            status: "unknown",
            diagnostics: [{ code: "cursor_probe_path_kind_invalid" }],
        });
        expect(CURSOR_PROBE_FOR_TEST.inspectPath(join(root, "missing"), "directory")).toEqual({
            status: "not_found",
            diagnostics: [],
        });
        expect(CURSOR_PROBE_FOR_TEST.inspectPath("\0", "file")).toMatchObject({
            status: "unknown",
            diagnostics: [{ code: "cursor_probe_io_error" }],
        });
        expect(CURSOR_PROBE_FOR_TEST.statusForRoot({ accessStatus: "available" } as never)).toBe("complete");
        expect(CURSOR_PROBE_FOR_TEST.statusForRoot({ accessStatus: "not_found" } as never)).toBe("not_found");
        expect(CURSOR_PROBE_FOR_TEST.statusForRoot({ accessStatus: "needs_permission" } as never)).toBe("needs_permission");
        expect(CURSOR_PROBE_FOR_TEST.statusForRoot({ accessStatus: "unknown" } as never)).toBe("partial");

        const unreachable = await probeCursor(
            {
                authorizationScope: "global",
                platformContext: { platform: "win32", platformInstanceId: "win32:test", accessRootPath: "C:\\fixture" },
            },
            {},
            home,
            "linux",
        );
        expect(unreachable).toMatchObject({
            status: "partial",
            diagnostics: [{ code: "cursor_probe_platform_unreachable" }],
            observation: { sourceRoots: [], observedProjects: [], targetCandidates: [] },
        });

        const darwin = await probeCursor(
            {
                authorizationScope: "global",
                platformContext: { platform: "darwin", platformInstanceId: "darwin:test", accessRootPath: root },
            },
            {},
            home,
            "darwin",
        );
        expect(darwin.observation.observedAgentRuntimes.every((entry) => entry.installationStatus === "unknown")).toBe(true);
    });

    it("rejects malformed product metadata without following product symlinks", () => {
        const root = mkdtempSync(join(tmpdir(), "oaam-cursor-product-metadata-"));
        const product = join(root, "product.json");
        const target = join(root, "target.json");
        writeFileSync(product, JSON.stringify({ version: " 3.13.25 " }));
        expect(CURSOR_PROBE_FOR_TEST.readProductVersion(product)).toBeNull();
        writeFileSync(product, JSON.stringify({ name: "Cursor" }));
        expect(CURSOR_PROBE_FOR_TEST.readProductVersion(product)).toBeNull();
        writeFileSync(product, JSON.stringify({ version: "3.13.25" }));
        expect(CURSOR_PROBE_FOR_TEST.readProductVersion(product)).toBe("3.13.25");
        writeFileSync(target, JSON.stringify({ version: "3.13.25" }));
        symlinkSync(target, join(root, "linked.json"));
        expect(CURSOR_PROBE_FOR_TEST.readProductVersion(join(root, "linked.json"))).toBeNull();
        expect(CURSOR_PROBE_FOR_TEST.readProductVersion(join(root, "missing.json"))).toBeNull();
    });

    it("requires Linux execution for WSL and preserves native Windows App lookup", async () => {
        const selectedWsl = await probeCursor(
            {
                authorizationScope: "global",
                platformContext: {
                    platform: "wsl",
                    platformInstanceId: "Ubuntu",
                    accessRootPath: "\\\\wsl.localhost\\Ubuntu\\home\\example",
                },
            },
            { PATH: "C:\\foreign" },
            "C:\\Users\\agent",
            "win32",
        );
        expect(selectedWsl.status).toBe("partial");
        expect(selectedWsl.diagnostics).toContainEqual(expect.objectContaining({ code: "cursor_probe_platform_unreachable" }));
        expect(selectedWsl.observation.sourceRoots).toEqual([]);
        expect(selectedWsl.observation.observedAgentRuntimes.every((entry) => entry.installationStatus === "unknown")).toBe(true);

        expect(
            CURSOR_PROBE_FOR_TEST.findCursorAppInstallation({}, "\\\\wsl.localhost\\Ubuntu\\home\\example", {
                platform: "wsl",
                platformInstanceId: "Ubuntu",
                accessRootPath: "\\\\wsl.localhost\\Ubuntu\\",
            }),
        ).toMatchObject({
            status: "not_found",
            evidence: [
                {
                    kind: "executable",
                    path: "\\\\wsl.localhost\\Ubuntu\\usr\\share\\cursor\\cursor",
                    evidenceLevel: "local_artifact",
                },
                {
                    kind: "executable",
                    path: "\\\\wsl.localhost\\Ubuntu\\opt\\Cursor\\cursor",
                    evidenceLevel: "local_artifact",
                },
            ],
        });

        const nativeWindows = await probeCursor(
            {
                authorizationScope: "global",
                platformContext: {
                    platform: "win32",
                    platformInstanceId: "win32:test",
                    accessRootPath: "C:\\Users\\agent",
                },
            },
            { LOCALAPPDATA: "C:\\Users\\agent\\AppData\\Local" },
            "C:\\Users\\agent",
            "win32",
        );
        expect(nativeWindows.status).toBe("complete");
        expect(nativeWindows.observation.observedAgentRuntimes).toEqual([
            expect.objectContaining({
                agentRuntimeId: "CURSOR_AGENT_CLI",
                installationStatus: "not_found",
                installationEvidence: [expect.objectContaining({ path: "C:\\Users\\agent\\.local\\bin\\cursor-agent.exe" })],
            }),
            expect.objectContaining({ agentRuntimeId: "CURSOR_APP", installationStatus: "not_found" }),
        ]);
    });

    it("binds an explicitly selected extracted App executable without weakening access-root authority", async () => {
        const root = mkdtempSync(join(tmpdir(), "oaam-cursor-app-explicit-"));
        const home = join(root, "home");
        const project = join(root, "project");
        const executable = join(root, "cursor-package", "cursor");
        const product = join(root, "cursor-package", "resources", "app", "product.json");
        mkdirSync(join(root, "cursor-package", "resources", "app"), { recursive: true });
        mkdirSync(home);
        mkdirSync(project);
        writeFileSync(executable, "binary", { mode: 0o755 });
        writeFileSync(product, JSON.stringify({ version: "3.13.25" }));
        const context = {
            authorizationScope: "project" as const,
            projectRootPath: project,
            platformContext: { platform: "linux" as const, platformInstanceId: "linux:test", accessRootPath: root },
        };
        const result = await probeCursor(context, { CURSOR_APP_EXECUTABLE: executable }, home, "linux");
        const app = result.observation.observedAgentRuntimes.find((row) => row.agentRuntimeId === "CURSOR_APP");
        expect(app).toMatchObject({ installationStatus: "available", versionText: "3.13.25" });
        expect(app?.installationEvidence).toContainEqual(expect.objectContaining({ kind: "executable", path: executable }));

        const outside = await probeCursor(context, { CURSOR_APP_EXECUTABLE: "/outside/cursor" }, home, "linux");
        expect(outside.observation.observedAgentRuntimes.find((row) => row.agentRuntimeId === "CURSOR_APP")).toMatchObject({
            installationStatus: "unknown",
            diagnostics: [{ code: "cursor_app_install_discovery_incomplete" }],
        });
    });
});
