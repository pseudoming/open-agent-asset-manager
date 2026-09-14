export const DESKTOP_DIALOG_IDS = [
    "catalog_search",
    "about",
    "project_lifecycle",
    "discovery_project_registration",
    "deployment_replacement",
] as const;

export type DesktopDialogId = (typeof DESKTOP_DIALOG_IDS)[number];
