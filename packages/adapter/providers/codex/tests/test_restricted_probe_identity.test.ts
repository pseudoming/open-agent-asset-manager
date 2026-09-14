import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureGlobalProbeContext } from "../../../test-support";
import { probeCodex, probeCodexForSelectedWslHost } from "../src/codex-probe";
import { stableCodexId } from "../src/codex-probe-foundation";
import { createCodexProviderForRestrictedProbe } from "../src/restricted-probe";
import { codexProvider } from "../src/codex-provider";
import { validateAdapterProviderRegistration } from "../../../../core/src/adapters/adapter-contract-validator";
import { isAdapterFrameworkProvider } from "@oaam/adapter-framework";

let root = "";
afterEach(() => {
    if (root !== "") fs.rmSync(root, { recursive: true, force: true });
    root = "";
});
function globalContext(accessRootPath: string) {
    const context = fixtureGlobalProbeContext("wsl");
    return { ...context, platformContext: { ...context.platformContext, accessRootPath } };
}

describe("Codex restricted probe persistent locator identity", () => {
    it("retains Windows registry locator bytes while every physical read and snapshot ID stays local", async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-codex-probe-identity-"));
        const home = path.join(root, "home"),
            project = path.join(root, "project");
        const codexHome = path.join(home, ".codex");
        fs.mkdirSync(codexHome, { recursive: true });
        fs.mkdirSync(project);
        const config = path.join(codexHome, "config.toml");
        const contents = `[projects.'${project}']\ntrust_level = 'trusted'\n`;
        fs.writeFileSync(config, contents);
        const context = globalContext(root);
        const host = {
            ...context.platformContext,
            accessRootPath: `\\\\wsl.localhost\\${context.platformContext.platformInstanceId}${root.replaceAll("/", "\\")}`,
        };
        const local = await probeCodex(context, { PATH: "" }, home, "linux");
        const projected = await probeCodexForSelectedWslHost(context, host, { PATH: "" }, home, "linux");
        const resource = projected.observation.agentRuntimeResources.find((value) => value.roles.includes("project_registry"))!;
        expect(resource.path).toBe(config);
        expect(projected.observation.agentRuntimeResources).toEqual(local.observation.agentRuntimeResources);
        const registryHostPath = `\\\\wsl.localhost\\${host.platformInstanceId}${config.replaceAll("/", "\\")}`;
        const legacyRegistryId = stableCodexId("resource", `${resource.roles.join(",")}\0${registryHostPath}`);
        const legacyLocator = stableCodexId("project-registry-entry", `${legacyRegistryId}\0${project}`);
        const observed = projected.observation.observedProjects[0]!;
        expect(projected.observation.observedProjects).toHaveLength(1);
        expect(observed.evidence[0]).toMatchObject({
            agentRuntimeResourceId: resource.agentRuntimeResourceId,
            locatorKey: legacyLocator,
        });
        const workspace = projected.observation.sourceRoots.find(
            (value) => value.sourceRootId === observed.workspaces[0]!.sourceRootId,
        )!;
        expect(workspace).toMatchObject({ path: project, locatorEvidence: [{ locatorKey: legacyLocator }] });
        expect(observed.observedProjectId).toBe(local.observation.observedProjects[0]?.observedProjectId);
        expect(observed.evidence[0]?.locatorKey).not.toBe(local.observation.observedProjects[0]?.evidence[0]?.locatorKey);
        expect(fs.readFileSync(config, "utf8")).toBe(contents);
    });

    it.each([
        "foreign-distro",
        "foreign-root",
        "logical-linux",
        "physical-win32",
    ] as const)("rejects %s coordinate bindings before a probe", async (fault) => {
        const context = globalContext("/selected");
        const host = {
            ...context.platformContext,
            accessRootPath: `\\\\wsl.localhost\\${context.platformContext.platformInstanceId}\\selected`,
        };
        const changed = {
            ...context,
            platformContext: {
                ...context.platformContext,
                ...(fault === "foreign-distro" ? { platformInstanceId: "Other" } : {}),
                ...(fault === "foreign-root" ? { accessRootPath: "/elsewhere" } : {}),
                ...(fault === "logical-linux" ? { platform: "linux" as const } : {}),
            },
        };
        await expect(
            probeCodexForSelectedWslHost(
                changed,
                host,
                { PATH: "" },
                "/selected",
                fault === "physical-win32" ? "win32" : "linux",
            ),
        ).rejects.toThrow(/exact selected WSL/u);
    });

    it("binds only the private probe factory and preserves the existing capability surfaces", async () => {
        const context = globalContext("/selected");
        const host = {
            ...context.platformContext,
            accessRootPath: `\\\\wsl.localhost\\${context.platformContext.platformInstanceId}\\selected`,
        };
        const provider = createCodexProviderForRestrictedProbe(host);
        host.platformInstanceId = "Changed-after-construction";
        expect(provider.adapterId).toBe(codexProvider.adapterId);
        expect(provider.assetSourceCapabilities).toEqual(codexProvider.assetSourceCapabilities);
        expect(provider.assetTargetCapabilities).toEqual(codexProvider.assetTargetCapabilities);
        expect(validateAdapterProviderRegistration(provider, [])).toEqual([]);
        expect(isAdapterFrameworkProvider(provider)).toBe(true);
        expect(isAdapterFrameworkProvider({ ...provider })).toBe(false);
        await expect(
            provider.probe({
                ...context,
                platformContext: { ...context.platformContext, platformInstanceId: "Changed-after-construction" },
            }),
        ).rejects.toThrow(/exact selected WSL/u);
    });
});
