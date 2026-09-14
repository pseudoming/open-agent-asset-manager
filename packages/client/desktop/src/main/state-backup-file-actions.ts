export type DesktopStateBackupTrashRoute = "host_identity_bound" | "electron_shell";

export function desktopStateBackupTrashRoute(platform: NodeJS.Platform): DesktopStateBackupTrashRoute {
    return platform === "win32" ? "host_identity_bound" : "electron_shell";
}
