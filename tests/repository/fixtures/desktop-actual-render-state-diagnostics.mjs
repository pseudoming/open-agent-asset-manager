import { ordinaryLanguageRendererArguments } from "./desktop-actual-render-language.mjs";
import { operationRendererArguments } from "./desktop-actual-render-operation-layout.mjs";

export async function inspectStateDiagnosticsOperationsCase(webContents, entry) {
    return webContents.executeJavaScript(
        `(${async function inspectStateDiagnosticsOperations(
            entryValue,
            assertOrdinarySurfaceLanguage,
            ordinarySurfaceLanguageLexicon,
            formatOperationMessage,
            assertOperationLayout,
        ) {
            const waitFor = async (predicate, label, timeoutMs = 10_000) => {
                const deadline = performance.now() + timeoutMs;
                while (performance.now() < deadline) {
                    const value = predicate();
                    if (value) return value;
                    await new Promise((resolve) => setTimeout(resolve, 25));
                }
                throw new Error(
                    `${entryValue.id}: timed out waiting for ${label}; support inspections=${
                        document.documentElement.dataset.oaamSupportInspectionCount ?? "0"
                    }; State tail=${JSON.stringify(
                        (document.querySelector(".state-resilience-workspace")?.textContent ?? "").slice(-1_200),
                    )}; State headings=${JSON.stringify(
                        [...document.querySelectorAll(".state-resilience-workspace h4")].map((element) =>
                            element.textContent?.trim(),
                        ),
                    )}; diagnostics tail=${JSON.stringify(
                        (document.querySelector(".diagnostics-workspace")?.textContent ?? "").slice(-800),
                    )}; tones=${JSON.stringify(
                        [...document.querySelectorAll(".diagnostics-workspace [data-oaam-tone]")].map((element) =>
                            element.getAttribute("data-oaam-tone"),
                        ),
                    )}`,
                );
            };
            const assert = (condition, message) => {
                if (!condition) throw new Error(`${entryValue.id}: ${message}`);
            };
            const ordinaryText = (root) => {
                const copy = root.cloneNode(true);
                for (const hidden of copy.querySelectorAll("[hidden], [data-oaam-technical-detail]")) hidden.remove();
                return copy.textContent ?? "";
            };
            const assertOrdinaryLanguage = (root, label) =>
                assertOrdinarySurfaceLanguage(root, label, entryValue.id, ordinarySurfaceLanguageLexicon);
            const operationMessageTemplates = JSON.parse(document.documentElement.dataset.oaamOperationMessageTemplates ?? "{}");
            const message = (messageId, values) => formatOperationMessage(operationMessageTemplates, messageId, values);
            const assertLayout = (root, label) => assertOperationLayout(root, label, entryValue.id);
            const click = (element, label) => {
                assert(element instanceof HTMLButtonElement, `${label} is not a button`);
                assert(!element.disabled, `${label} is disabled`);
                element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
            };
            const buttonNamed = (root, label) =>
                [...root.querySelectorAll("button")].find((button) => button.textContent?.trim() === label);
            const chooseSettingsCategory = async (label, expectedCategory) => {
                const settingsShell = await waitFor(
                    () => document.querySelector(".settings-workbench-shell"),
                    "Settings workbench",
                );
                assert(settingsShell instanceof HTMLElement, "Settings workbench has the wrong element type");
                click(buttonNamed(settingsShell, label), `${label} Settings category`);
                await waitFor(
                    () => settingsShell.getAttribute("data-settings-category") === expectedCategory,
                    `${label} Settings category`,
                );
                return settingsShell;
            };
            const observedJourneyStates = [];

            const settingsNavigation = await waitFor(
                () => document.querySelector(".library-settings-button"),
                "Settings navigation",
            );
            click(settingsNavigation, "Settings navigation");

            const settingsShell = await chooseSettingsCategory(message("state_resilience.title"), "backup_recovery");
            const stateWorkspace = await waitFor(
                () => document.querySelector(".state-resilience-workspace"),
                "State resilience workspace",
            );
            assert(stateWorkspace instanceof HTMLElement, "State resilience workspace has the wrong element type");
            await waitFor(
                () => ordinaryText(stateWorkspace).includes("C:\\OAAM\\backups\\reviewed-state.zip"),
                "State backup inventory",
            );
            assertOrdinaryLanguage(stateWorkspace, "State backup initial state");
            assertLayout(stateWorkspace, "State backup initial state");

            click(buttonNamed(stateWorkspace, message("state_resilience.backup.inspect")), "backup review");
            const inspectProgress = await waitFor(
                () => stateWorkspace.querySelector(".state-resilience-progress"),
                "backup inspection progress",
            );
            assert(inspectProgress instanceof HTMLElement, "backup inspection progress has the wrong element type");
            assert(
                inspectProgress.closest("section")?.getAttribute("aria-labelledby") === "state-backup-create-title",
                "backup progress is detached from the backup action",
            );
            assert(stateWorkspace.getAttribute("aria-busy") === "true", "backup inspection is not exposed as busy");
            assert(
                ordinaryText(inspectProgress).includes(message("state_resilience.stage.inventory")),
                `backup inspection stage is not localized: ${JSON.stringify(ordinaryText(inspectProgress))}`,
            );
            assertLayout(stateWorkspace, "backup inspection progress");
            observedJourneyStates.push("state_backup_and_recovery:inspecting");
            document.dispatchEvent(new Event("oaam-fixture-release-backup-inspect"));

            const backupReview = await waitFor(
                () =>
                    [...stateWorkspace.querySelectorAll("h4")].find(
                        (heading) => heading.textContent?.trim() === message("state_resilience.backup.review_title"),
                    ),
                "backup review",
            );
            assert(backupReview instanceof HTMLElement, "backup review has the wrong element type");
            assert(
                buttonNamed(stateWorkspace, message("state_resilience.backup.inspect")) === undefined,
                "completed review still presents the previous inspect action",
            );
            assert(
                document.documentElement.dataset.oaamStateBackupInspectionCount === "1",
                "backup review did not invoke the fixture operation",
            );
            observedJourneyStates.push("state_backup_and_recovery:review_ready");
            assertLayout(stateWorkspace, "backup review");

            click(buttonNamed(stateWorkspace, message("state_resilience.backup.create")), "backup creation");
            const createProgress = await waitFor(
                () => stateWorkspace.querySelector(".state-resilience-progress"),
                "backup creation progress",
            );
            assert(createProgress instanceof HTMLElement, "backup creation progress has the wrong element type");
            assert(
                createProgress.closest("section")?.getAttribute("aria-labelledby") === "state-backup-create-title",
                "create progress is detached from the backup action",
            );
            assert(
                ordinaryText(createProgress).includes(message("state_resilience.stage.verification")),
                `backup creation stage is not localized: ${JSON.stringify(ordinaryText(createProgress))}`,
            );
            assertLayout(stateWorkspace, "backup creation progress");
            observedJourneyStates.push("state_backup_and_recovery:creating");
            document.dispatchEvent(new Event("oaam-fixture-release-backup-create"));
            await waitFor(
                () => ordinaryText(stateWorkspace).includes("C:\\OAAM\\backups\\created-state.zip"),
                "created backup result",
            );
            assert(
                document.documentElement.dataset.oaamStateBackupCreateCount === "1",
                "backup creation did not invoke the fixture operation",
            );
            observedJourneyStates.push("state_backup_and_recovery:created");

            const enterRestoreReview = async () => {
                const restoreButton = [...stateWorkspace.querySelectorAll("button")].find(
                    (button) => button.textContent?.trim() === message("state_resilience.restore.use"),
                );
                click(restoreButton, "known backup restore");
                const restoreSection = stateWorkspace.querySelector(
                    ".state-resilience-block[aria-labelledby='state-restore-title']",
                );
                assert(restoreSection instanceof HTMLElement, "restore section is missing");
                const inspectButton = await waitFor(
                    () => buttonNamed(restoreSection, message("state_resilience.restore.inspect")),
                    "restore inspection action",
                );
                click(inspectButton, "restore inspection");
                return waitFor(
                    () =>
                        [...stateWorkspace.querySelectorAll("h4")].find(
                            (heading) => heading.textContent?.trim() === message("state_resilience.restore.review_title"),
                        ),
                    "restore review",
                );
            };
            let restoreReview = await enterRestoreReview();
            assert(restoreReview instanceof HTMLElement, "restore review has the wrong element type");
            observedJourneyStates.push("state_backup_and_recovery:restore_review");
            let restoreConfirmation = restoreReview.closest(".state-resilience-review")?.querySelector("input[type='checkbox']");
            assert(restoreConfirmation instanceof HTMLInputElement, "restore confirmation is missing");
            restoreConfirmation.click();
            click(buttonNamed(stateWorkspace, message("state_resilience.restore.activate")), "failing State restore");
            const stateFailure = await waitFor(
                () => stateWorkspace.querySelector(".workbench-notice-danger"),
                "State restore failure",
            );
            assert(stateFailure instanceof HTMLElement, "State restore failure has the wrong element type");
            assert(
                !ordinaryText(stateWorkspace).includes("fixture raw State activation failure"),
                "State failure leaks raw diagnostics into ordinary copy",
            );
            assert(
                stateWorkspace.textContent?.includes("fixture raw State activation failure") === true,
                "State failure discarded its attributed technical evidence",
            );
            assertOrdinaryLanguage(stateWorkspace, "State restore failure");
            assertLayout(stateWorkspace, "State restore failure");
            observedJourneyStates.push("state_backup_and_recovery:failed");

            restoreReview = await enterRestoreReview();
            restoreConfirmation = restoreReview.closest(".state-resilience-review")?.querySelector("input[type='checkbox']");
            assert(restoreConfirmation instanceof HTMLInputElement, "fresh restore confirmation is missing");
            assert(!restoreConfirmation.checked, "fresh restore review reused prior consent");
            restoreConfirmation.click();
            click(buttonNamed(stateWorkspace, message("state_resilience.restore.activate")), "State restore");
            await waitFor(
                () =>
                    ordinaryText(stateWorkspace).includes(
                        message("state_resilience.restore.restarting", {
                            path: "C:\\OAAM\\displaced-state",
                        }),
                    ),
                "restored State result",
            );
            assert(stateWorkspace.querySelector("button") === null, "restored State exposes another request before restart");
            assert(document.documentElement.dataset.oaamStateRestoreActivationCount === "2", "restore dispatch count changed");
            assertOrdinaryLanguage(stateWorkspace, "restored State result");
            assertLayout(stateWorkspace, "restored State result");
            observedJourneyStates.push("state_backup_and_recovery:restored");

            await chooseSettingsCategory(message("diagnostics.title"), "diagnostics");
            const diagnostics = await waitFor(() => document.querySelector(".diagnostics-workspace"), "Diagnostics workspace");
            assert(diagnostics instanceof HTMLElement, "Diagnostics workspace has the wrong element type");
            await waitFor(
                () => ordinaryText(diagnostics).includes(message("diagnostics.health.healthy")),
                "Diagnostics ready state",
            );
            assert(diagnostics.getAttribute("aria-busy") === "false", "ready Diagnostics remains busy");
            assertOrdinaryLanguage(diagnostics, "Diagnostics idle state");
            observedJourneyStates.push("diagnostics_and_maintenance:idle");

            click(buttonNamed(diagnostics, message("diagnostics.support.inspect")), "support-bundle review");
            await waitFor(() => diagnostics.getAttribute("aria-busy") === "true", "running support-bundle inspection");
            assert(
                document.documentElement.dataset.oaamSupportInspectionCount === "1",
                "support-bundle review did not invoke the fixture operation",
            );
            observedJourneyStates.push("diagnostics_and_maintenance:running");
            document.dispatchEvent(new Event("oaam-fixture-release-support-inspect"));
            const supportReview = await waitFor(
                () => diagnostics.querySelector(".diagnostics-support-review"),
                "support-bundle review",
            );
            assert(supportReview instanceof HTMLElement, "support-bundle review has the wrong element type");
            assert(
                ordinaryText(supportReview).includes(
                    message("diagnostics.support.review", {
                        count: 2,
                        size: "",
                    }).trim(),
                ),
                "support review omits its bounded inventory",
            );
            assert(
                supportReview.querySelector("[data-oaam-support-archive-hash]")?.textContent === "a".repeat(64),
                "support review omits the exact archive hash",
            );
            assert(
                supportReview.querySelector("[data-oaam-support-ordinary-log]")?.textContent?.trim().length > 0,
                "support review omits ordinary-log inclusion",
            );
            assert(
                [...supportReview.querySelectorAll("li strong")].every((entry) => entry.textContent?.trim()),
                "support review omits an entry category",
            );
            assertLayout(diagnostics, "support-bundle review");
            observedJourneyStates.push("diagnostics_and_maintenance:review_ready");

            click(buttonNamed(diagnostics, message("diagnostics.support.export")), "support-bundle export");
            await waitFor(
                () => document.documentElement.dataset.oaamSupportExportCount === "1",
                "support-bundle export operation",
            );
            await waitFor(
                () => ordinaryText(diagnostics).includes("C:\\OAAM\\support\\reviewed-support.zip"),
                "support-bundle completion",
            );
            observedJourneyStates.push("diagnostics_and_maintenance:complete");

            click(buttonNamed(diagnostics, message("diagnostics.support.inspect")), "failing support-bundle review");
            await waitFor(
                () => document.documentElement.dataset.oaamSupportInspectionCount === "2",
                "second support-bundle operation",
            );
            const diagnosticsFailure = await waitFor(
                () => diagnostics.querySelector(".workbench-notice-danger"),
                "support-bundle failure",
            );
            assert(diagnosticsFailure instanceof HTMLElement, "support-bundle failure has the wrong element type");
            assert(
                !ordinaryText(diagnostics).includes("fixture raw support-bundle failure"),
                "Diagnostics failure leaks raw diagnostics into ordinary copy",
            );
            assert(
                diagnostics.textContent?.includes("fixture raw support-bundle failure") === true,
                "Diagnostics failure discarded its attributed technical evidence",
            );
            assertOrdinaryLanguage(diagnostics, "Diagnostics failure");
            assertLayout(diagnostics, "Diagnostics failure");
            observedJourneyStates.push("diagnostics_and_maintenance:failed");

            await chooseSettingsCategory(message("settings.maintenance.title"), "maintenance");
            const maintenance = await waitFor(() => document.querySelector(".desktop-maintenance"), "Maintenance workspace");
            assert(maintenance instanceof HTMLElement, "Maintenance workspace has the wrong element type");
            await waitFor(() => ordinaryText(maintenance).includes("2 KiB"), "Maintenance inspection");
            const locationList = maintenance.querySelector(".desktop-maintenance-locations ul");
            const firstLocationActions = locationList?.querySelector(".desktop-maintenance-actions");
            const locationListRect = locationList?.getBoundingClientRect();
            const firstLocationActionsRect = firstLocationActions?.getBoundingClientRect();
            assert(
                locationList instanceof HTMLElement &&
                    firstLocationActions instanceof HTMLElement &&
                    Math.abs(firstLocationActionsRect.right - locationListRect.right) <= 1,
                "Maintenance data-location actions do not use the row's trailing edge",
            );
            const clearCache = buttonNamed(maintenance, message("settings.maintenance.cache.clear"));
            click(clearCache, "interface-cache clear");
            await waitFor(
                () => ordinaryText(maintenance).includes(message("settings.maintenance.cache.complete")),
                "successful interface-cache clear",
            );
            click(buttonNamed(maintenance, message("settings.maintenance.cache.clear")), "failing interface-cache clear");
            await waitFor(
                () => ordinaryText(maintenance).includes(message("settings.maintenance.cache.failed")),
                "failed interface-cache clear",
            );
            assert(
                document.documentElement.dataset.oaamMaintenanceCacheClearCount === "2",
                "Maintenance did not invoke both bounded cache-clear operations",
            );
            assertOrdinaryLanguage(settingsShell, "State, Diagnostics and Maintenance Settings");
            assertLayout(settingsShell, "State, Diagnostics and Maintenance Settings");

            return {
                innerWidth,
                innerHeight,
                resolvedTheme: document.documentElement.dataset.oaamTheme,
                resolvedLocale: document.documentElement.lang,
                dialogInventory: JSON.parse(document.documentElement.dataset.oaamDialogInventory ?? "[]"),
                dialogStates: [],
                journeyStates: observedJourneyStates,
                routeStates: ["library:ready", "settings:ready"],
                surfaceInventory: JSON.parse(document.documentElement.dataset.oaamSurfaceInventory ?? "[]"),
            };
        }.toString()})(${JSON.stringify(entry)}, ${ordinaryLanguageRendererArguments()}, ${operationRendererArguments()})`,
        true,
    );
}
