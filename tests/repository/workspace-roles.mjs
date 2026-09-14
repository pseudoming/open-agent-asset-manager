export const WORKSPACE_ROLES = Object.freeze([
    "adapter",
    "adapter_framework",
    "app_server_bootstrap",
    "app_server_host",
    "app_server_protocol",
    "client_framework",
    "client_headless",
    "client_desktop",
    "core",
    "shared",
]);

export function classifyWorkspaceRole(workspace) {
    if (workspace.name === "@oaam/core" && workspace.relativePath === "packages/core") return "core";
    if (workspace.name === "@oaam/adapter-framework" && workspace.relativePath === "packages/adapter/framework") {
        return "adapter_framework";
    }
    if (workspace.name === "@oaam/app-server-protocol" && workspace.relativePath === "packages/app-server/protocol") {
        return "app_server_protocol";
    }
    if (workspace.name === "@oaam/app-server-host" && workspace.relativePath === "packages/app-server/host") {
        return "app_server_host";
    }
    if (workspace.name === "@oaam/app-server-bootstrap" && workspace.relativePath === "packages/app-server/bootstrap") {
        return "app_server_bootstrap";
    }
    if (workspace.name === "@oaam/client-framework" && workspace.relativePath === "packages/client/framework") {
        return "client_framework";
    }
    if (workspace.name === "@oaam/client-headless" && workspace.relativePath === "packages/client/headless") {
        return "client_headless";
    }
    if (workspace.name === "@oaam/client-desktop" && workspace.relativePath === "packages/client/desktop") {
        return "client_desktop";
    }
    if (workspace.name === "@oaam/shared" && workspace.relativePath === "packages/shared") {
        return "shared";
    }
    if (workspace.name.startsWith("@oaam/adapter-") && /^packages\/adapter\/providers\/[^/]+$/u.test(workspace.relativePath)) {
        return "adapter";
    }
    throw new Error(`${workspace.relativePath} (${workspace.name}): live workspace has no reviewed architecture layer`);
}

export function tryClassifyWorkspaceRole(workspace) {
    try {
        return classifyWorkspaceRole(workspace);
    } catch {
        return null;
    }
}
