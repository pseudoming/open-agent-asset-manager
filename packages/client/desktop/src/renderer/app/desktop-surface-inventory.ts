export const DESKTOP_SURFACE_IDS = [
    "startup",
    "onboarding",
    "recovery_settings",
    "library",
    "sources",
    "deployment",
    "guided_import",
    "settings",
] as const;

export type DesktopSurfaceId = (typeof DESKTOP_SURFACE_IDS)[number];

export const WORKBENCH_ROUTE_SURFACES = [
    "library",
    "sources",
    "deployment",
    "guided_import",
    "settings",
] as const satisfies readonly DesktopSurfaceId[];

export type WorkbenchRouteSurface = (typeof WORKBENCH_ROUTE_SURFACES)[number];
