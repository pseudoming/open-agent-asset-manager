export { PACKAGED_SETTINGS_OPERATIONS_UI_SMOKE_SWITCH } from "./packaged-proof-launch-authority";
export const PACKAGED_SETTINGS_OPERATIONS_UI_LINE =
    "OAAM_DESKTOP_SETTINGS_OPERATIONS_UI_SMOKE state=reviewed+created+restore-reviewed diagnostics=healthy+support-reviewed maintenance=reviewed";
export const PACKAGED_SETTINGS_OPERATIONS_SCREENSHOT_DIRECTORY = "oaam-phase51-installed-settings-operations";
export const PACKAGED_SETTINGS_OPERATIONS_SCREENSHOT_STAGES = [
    "state-inventory",
    "state-backup-review",
    "state-backup-created",
    "state-restore-review",
    "diagnostics-health",
    "diagnostics-support-review",
    "maintenance-overview",
] as const;

export type PackagedSettingsOperationsScreenshotStage = (typeof PACKAGED_SETTINGS_OPERATIONS_SCREENSHOT_STAGES)[number];

export interface PackagedSettingsOperationsUiWebContents {
    executeJavaScript(script: string): Promise<unknown>;
}

export interface PackagedSettingsOperationsUiProof {
    readonly status: "complete";
    readonly ordinarySettingsEntry: true;
    readonly state: {
        readonly inventoryBefore: number;
        readonly availableBefore: number;
        readonly backupReviewed: true;
        readonly backupCreated: true;
        readonly inventoryAfter: number;
        readonly restoreReviewed: true;
        readonly restoreActivationGuarded: true;
    };
    readonly diagnostics: {
        readonly healthStatus: "healthy";
        readonly supportReviewed: true;
        readonly supportEntryCount: number;
        readonly maintenanceLocationCount: number;
    };
}

interface PackagedSettingsOperationsUiOptions {
    readonly capture: (stage: PackagedSettingsOperationsScreenshotStage) => Promise<void>;
}

const OPEN_SETTINGS_CATEGORY_SCRIPT = `(async (category) => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        const onboarding = document.querySelector(
            'main[data-oaam-route="onboarding"][data-oaam-state="ready"][data-oaam-step="welcome"]'
        );
        if (onboarding instanceof HTMLElement) {
            const later = onboarding.querySelector(".onboarding-actions .library-secondary-button");
            if (!(later instanceof HTMLButtonElement) || later.disabled) {
                throw new Error("onboarding Set up later is unavailable before ordinary Settings");
            }
            later.focus();
            later.click();
        }
        let shell = document.querySelector('main[data-oaam-route="settings"][data-oaam-state="ready"]');
        if (!(shell instanceof HTMLElement)) {
            const settings = document.querySelector(".library-settings-button");
            if (settings instanceof HTMLButtonElement && !settings.disabled) {
                settings.focus();
                settings.click();
            }
        } else {
            if (shell.dataset.settingsCategory !== category) {
                const categoryButton = shell.querySelector(
                    '[data-oaam-settings-category="' + category + '"]'
                );
                if (!(categoryButton instanceof HTMLButtonElement) || categoryButton.disabled) {
                    throw new Error("Settings category " + category + " is unavailable");
                }
                categoryButton.focus();
                categoryButton.click();
            } else {
                const scrollOwner = shell.querySelector(
                    '[data-oaam-settings-scroll-owner="' + category + '"]'
                );
                if (scrollOwner instanceof HTMLElement) scrollOwner.scrollTo({ top: 0 });
                return true;
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("timed out opening Settings category " + category);
})`;

const WAIT_FOR_STATE_INVENTORY_SCRIPT = `(async () => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        const root = document.querySelector(
            '.state-resilience-workspace[data-oaam-state-resilience-state="ready"]'
        );
        if (root instanceof HTMLElement) {
            const inventoryBefore = Number.parseInt(root.dataset.oaamBackupCount ?? "", 10);
            const entries = [...root.querySelectorAll("[data-oaam-backup-entry]")];
            const availableBefore = entries.filter(
                (entry) => entry instanceof HTMLElement && entry.dataset.oaamBackupObservation === "available"
            ).length;
            if (
                Number.isSafeInteger(inventoryBefore) &&
                inventoryBefore >= 1 &&
                entries.length === inventoryBefore &&
                availableBefore >= 1
            ) {
                root.querySelector("#state-backup-inventory-title")?.scrollIntoView({ block: "start" });
                return { inventoryBefore, availableBefore };
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("State inventory did not expose one available backup");
})`;

const INSPECT_STATE_BACKUP_SCRIPT = `(async () => {
    const action = document.querySelector('[data-oaam-state-action="backup.inspect"]');
    if (!(action instanceof HTMLButtonElement) || action.disabled) {
        throw new Error("State backup review action is unavailable");
    }
    action.focus();
    action.click();
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        const root = document.querySelector(
            '.state-resilience-workspace[data-oaam-state-resilience-state="ready"][data-oaam-backup-review="ready"]'
        );
        const review = root?.querySelector(".state-resilience-review");
        if (root instanceof HTMLElement && review instanceof HTMLElement) {
            review.scrollIntoView({ block: "center" });
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("State backup did not reach reviewed state");
})`;

const CREATE_STATE_BACKUP_SCRIPT = `(async (inventoryBefore) => {
    const action = document.querySelector('[data-oaam-state-action="backup.create"]');
    if (!(action instanceof HTMLButtonElement) || action.disabled) {
        throw new Error("State backup create action is unavailable");
    }
    action.focus();
    action.click();
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
        const root = document.querySelector(
            '.state-resilience-workspace[data-oaam-state-resilience-state="ready"][data-oaam-backup-created="true"]'
        );
        if (root instanceof HTMLElement) {
            const inventoryAfter = Number.parseInt(root.dataset.oaamBackupCount ?? "", 10);
            const output = root.querySelector("[data-oaam-created-backup-output]");
            if (Number.isSafeInteger(inventoryAfter) && inventoryAfter > inventoryBefore && output instanceof HTMLElement) {
                output.scrollIntoView({ block: "center" });
                return inventoryAfter;
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("State backup did not create a new inventoried artifact");
})`;

const REVIEW_STATE_RESTORE_SCRIPT = `(async () => {
    const root = document.querySelector(
        '.state-resilience-workspace[data-oaam-state-resilience-state="ready"]'
    );
    const useBackup = root?.querySelector(
        '[data-oaam-backup-entry][data-oaam-backup-observation="available"] [data-oaam-state-action="restore.use"]'
    );
    if (!(useBackup instanceof HTMLButtonElement) || useBackup.disabled) {
        throw new Error("available State backup cannot be selected for restore");
    }
    useBackup.focus();
    useBackup.click();
    const sourceDeadline = Date.now() + 10000;
    let inspect;
    while (Date.now() < sourceDeadline) {
        const selected = document.querySelector(
            '.state-resilience-workspace[data-oaam-restore-source="inventory_backup"]'
        );
        inspect = selected?.querySelector('[data-oaam-state-action="restore.inspect"]');
        if (inspect instanceof HTMLButtonElement && !inspect.disabled) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!(inspect instanceof HTMLButtonElement) || inspect.disabled) {
        throw new Error("State restore review action is unavailable");
    }
    inspect.focus();
    inspect.click();
    const reviewDeadline = Date.now() + 30000;
    while (Date.now() < reviewDeadline) {
        const selected = document.querySelector(
            '.state-resilience-workspace[data-oaam-state-resilience-state="ready"][data-oaam-restore-review="ready"]'
        );
        const restoreSection = selected?.querySelector('[aria-labelledby="state-restore-title"]');
        const review = restoreSection?.querySelector(".state-resilience-review");
        const confirmation = review?.querySelector(".workbench-confirmation");
        const activate = review?.querySelector("button:last-child");
        if (
            restoreSection instanceof HTMLElement &&
            review instanceof HTMLElement &&
            confirmation instanceof HTMLElement &&
            activate instanceof HTMLButtonElement &&
            activate.disabled
        ) {
            restoreSection.scrollIntoView({ block: "start" });
            return { restoreReviewed: true, restoreActivationGuarded: true };
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("State restore did not reach guarded review");
})`;

const WAIT_FOR_DIAGNOSTICS_SCRIPT = `(async () => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        const root = document.querySelector(
            '.diagnostics-workspace[data-oaam-diagnostics-state="ready"]'
        );
        if (root instanceof HTMLElement && root.dataset.oaamHealthStatus === "healthy") {
            root.querySelector(".diagnostics-group")?.scrollIntoView({ block: "start" });
            return root.dataset.oaamHealthStatus;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Diagnostics did not reach healthy ready state");
})`;

const INSPECT_SUPPORT_BUNDLE_SCRIPT = `(async () => {
    const action = document.querySelector('[data-oaam-diagnostics-action="support.inspect"]');
    if (!(action instanceof HTMLButtonElement) || action.disabled) {
        throw new Error("support-bundle review action is unavailable");
    }
    action.focus();
    action.click();
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        const root = document.querySelector(
            '.diagnostics-workspace[data-oaam-diagnostics-state="ready"][data-oaam-support-review="ready"]'
        );
        const review = root?.querySelector(".diagnostics-support-review");
        const entries = review?.querySelectorAll("li");
        if (review instanceof HTMLElement && entries !== undefined && entries.length >= 1) {
            review.scrollIntoView({ block: "center" });
            return entries.length;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("support bundle did not reach reviewed state");
})`;

const WAIT_FOR_MAINTENANCE_SCRIPT = `(async () => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        const root = document.querySelector(
            '.desktop-maintenance[data-oaam-maintenance-state="ready"]'
        );
        if (root instanceof HTMLElement) {
            const locationCount = Number.parseInt(root.dataset.oaamMaintenanceLocationCount ?? "", 10);
            if (Number.isSafeInteger(locationCount) && locationCount >= 1) {
                root.scrollIntoView({ block: "start" });
                return locationCount;
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Desktop maintenance did not expose its bounded location inventory");
})`;

function exactRecord(value: unknown, expected: Readonly<Record<string, number | boolean>>, label: string): void {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError(`invalid packaged ${label} proof`);
    }
    const record = value as Record<string, unknown>;
    if (Object.entries(expected).some(([key, expectedValue]) => record[key] !== expectedValue)) {
        throw new TypeError(`invalid packaged ${label} proof`);
    }
}

export async function proveWindowsPackagedSettingsOperationsUi(
    webContents: PackagedSettingsOperationsUiWebContents,
    options: PackagedSettingsOperationsUiOptions,
): Promise<PackagedSettingsOperationsUiProof> {
    const execute = (script: string, ...inputs: readonly unknown[]): Promise<unknown> =>
        webContents.executeJavaScript(`(${script})(${inputs.map((value) => JSON.stringify(value)).join(",")})`);

    if ((await execute(OPEN_SETTINGS_CATEGORY_SCRIPT, "backup_recovery")) !== true) {
        throw new TypeError("invalid packaged ordinary Settings entry proof");
    }
    const inventory = await execute(WAIT_FOR_STATE_INVENTORY_SCRIPT);
    if (typeof inventory !== "object" || inventory === null || Array.isArray(inventory)) {
        throw new TypeError("invalid packaged State inventory proof");
    }
    const inventoryBefore = (inventory as Record<string, unknown>).inventoryBefore;
    const availableBefore = (inventory as Record<string, unknown>).availableBefore;
    if (
        !Number.isSafeInteger(inventoryBefore) ||
        (inventoryBefore as number) < 1 ||
        !Number.isSafeInteger(availableBefore) ||
        (availableBefore as number) < 1
    ) {
        throw new TypeError("invalid packaged State inventory proof");
    }
    await options.capture("state-inventory");

    if ((await execute(INSPECT_STATE_BACKUP_SCRIPT)) !== true) {
        throw new TypeError("invalid packaged State backup review proof");
    }
    await options.capture("state-backup-review");

    const inventoryAfter = await execute(CREATE_STATE_BACKUP_SCRIPT, inventoryBefore);
    if (!Number.isSafeInteger(inventoryAfter) || (inventoryAfter as number) <= (inventoryBefore as number)) {
        throw new TypeError("invalid packaged State backup creation proof");
    }
    await options.capture("state-backup-created");

    const restore = await execute(REVIEW_STATE_RESTORE_SCRIPT);
    exactRecord(restore, { restoreReviewed: true, restoreActivationGuarded: true }, "State restore review");
    await options.capture("state-restore-review");

    if ((await execute(OPEN_SETTINGS_CATEGORY_SCRIPT, "diagnostics")) !== true) {
        throw new TypeError("invalid packaged Diagnostics Settings entry proof");
    }
    const healthStatus = await execute(WAIT_FOR_DIAGNOSTICS_SCRIPT);
    if (healthStatus !== "healthy") throw new TypeError("invalid packaged Diagnostics health proof");
    await options.capture("diagnostics-health");

    const supportEntryCount = await execute(INSPECT_SUPPORT_BUNDLE_SCRIPT);
    if (!Number.isSafeInteger(supportEntryCount) || (supportEntryCount as number) < 1) {
        throw new TypeError("invalid packaged support-bundle review proof");
    }
    await options.capture("diagnostics-support-review");

    if ((await execute(OPEN_SETTINGS_CATEGORY_SCRIPT, "maintenance")) !== true) {
        throw new TypeError("invalid packaged Maintenance Settings entry proof");
    }
    const maintenanceLocationCount = await execute(WAIT_FOR_MAINTENANCE_SCRIPT);
    if (!Number.isSafeInteger(maintenanceLocationCount) || (maintenanceLocationCount as number) < 1) {
        throw new TypeError("invalid packaged Maintenance proof");
    }
    await options.capture("maintenance-overview");

    return Object.freeze({
        status: "complete",
        ordinarySettingsEntry: true,
        state: Object.freeze({
            inventoryBefore: inventoryBefore as number,
            availableBefore: availableBefore as number,
            backupReviewed: true,
            backupCreated: true,
            inventoryAfter: inventoryAfter as number,
            restoreReviewed: true,
            restoreActivationGuarded: true,
        }),
        diagnostics: Object.freeze({
            healthStatus: "healthy",
            supportReviewed: true,
            supportEntryCount: supportEntryCount as number,
            maintenanceLocationCount: maintenanceLocationCount as number,
        }),
    });
}
