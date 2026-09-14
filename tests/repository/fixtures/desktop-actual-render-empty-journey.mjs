import { ordinaryLanguageRendererArguments } from "./desktop-actual-render-language.mjs";

export async function inspectEmptyJourneyCase(webContents, entry) {
    return webContents.executeJavaScript(
        `(${async function inspectEmptyJourney(entryValue, assertOrdinarySurfaceLanguage, ordinarySurfaceLanguageLexicon) {
            const waitFor = async (predicate, label, timeoutMs = 10_000) => {
                const deadline = performance.now() + timeoutMs;
                while (performance.now() < deadline) {
                    const value = predicate();
                    if (value) return value;
                    await new Promise((resolve) => setTimeout(resolve, 25));
                }
                const route = document.querySelector("[data-oaam-route]");
                throw new Error(
                    `${entryValue.id}: timed out waiting for ${label}; route=${route?.getAttribute("data-oaam-route")} ` +
                        `step=${route?.getAttribute("data-oaam-step")} completion=${route?.getAttribute("data-oaam-completion")} ` +
                        `completionCount=${document.documentElement.dataset.oaamOnboardingCompletionCount ?? "0"} ` +
                        `alert=${route?.querySelector("[role='alert']")?.textContent?.trim() ?? "none"}`,
                );
            };
            const assert = (condition, message) => {
                if (!condition) throw new Error(`${entryValue.id}: ${message}`);
            };
            const click = (element) => {
                assert(element instanceof HTMLButtonElement, "journey action is not a button");
                assert(!element.disabled, "journey action is disabled");
                element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
            };
            const assertOrdinaryLanguage = (root, label) =>
                assertOrdinarySurfaceLanguage(root, label, entryValue.id, ordinarySurfaceLanguageLexicon);
            const assertInsideViewport = (root, label) => {
                const rect = root.getBoundingClientRect();
                assert(
                    rect.left >= -1 &&
                        rect.top >= -1 &&
                        rect.right <= window.innerWidth + 1 &&
                        rect.bottom <= window.innerHeight + 1,
                    `${label} escapes the current viewport`,
                );
            };
            const routeStage = async (route, step) =>
                waitFor(
                    () => document.querySelector(`[data-oaam-route='${route}'][data-oaam-step='${step}']`),
                    `${route} ${step}`,
                );

            const welcome = await routeStage("onboarding", "welcome");
            assertInsideViewport(welcome, "empty onboarding welcome");
            assertOrdinaryLanguage(welcome, "empty onboarding welcome");
            click(welcome.querySelector("[data-oaam-onboarding-start]"));

            const locations = await routeStage("onboarding", "locations");
            assertInsideViewport(locations, "empty onboarding locations");
            assert(locations.querySelectorAll(".import-journey-steps > li").length === 6, "empty journey lost six stages");
            const environmentCards = [...locations.querySelectorAll(".environment-card")];
            const windowsCard = environmentCards.find(
                (card) =>
                    card.getAttribute("data-oaam-environment-platform") === "win32" &&
                    card.getAttribute("data-oaam-environment-instance") === "desktop-local",
            );
            const windowsInput = windowsCard?.querySelector("input[type='checkbox']");
            assert(windowsInput instanceof HTMLInputElement && windowsInput.checked, "Local Windows is not selected");
            assert(
                environmentCards
                    .filter((card) => card !== windowsCard)
                    .every((card) => !(card.querySelector("input[type='checkbox']")?.checked ?? true)),
                "an optional Environment is selected",
            );
            click(locations.querySelector("[data-oaam-journey-continue='locations']"));

            const tools = await routeStage("onboarding", "tools");
            assertInsideViewport(tools, "empty onboarding tools");
            assertOrdinaryLanguage(tools, "empty onboarding tools");
            click(tools.querySelector("[data-oaam-journey-continue='tools']"));

            const complete = await waitFor(
                () =>
                    document.querySelector(
                        "[data-oaam-route='onboarding'][data-oaam-step='complete'][data-oaam-completion='no_content']",
                    ),
                "direct no-content completion",
            );
            assertInsideViewport(complete, "empty onboarding completion");
            assertOrdinaryLanguage(complete, "empty onboarding completion");
            assert(
                complete.querySelector(".source-review-card") === null &&
                    complete.querySelector("[data-oaam-import-candidate-id]") === null,
                "empty journey exposes source or Asset review",
            );
            assert(
                document.documentElement.dataset.oaamProbeAdapterIds === '["CLAUDECODE","OPENCODE"]' &&
                    document.documentElement.dataset.oaamProbeEnvironmentCount === "1",
                "empty journey did not bind the exact selected tools and Environment",
            );
            click(complete.querySelector(".onboarding-completion .onboarding-actions button:not(.library-secondary-button)"));

            let projects = await waitFor(() => document.querySelector("[data-oaam-route='library']"), "workbench shell");
            assert(projects.getAttribute("data-oaam-subject") === "projects", "onboarding did not return to Projects");
            projects = await waitFor(() => {
                const candidate = document.querySelector("[data-oaam-route='library'][data-oaam-subject='projects']");
                return candidate?.querySelector(".library-empty-state") instanceof HTMLElement ? candidate : false;
            }, "loaded empty Projects workbench");
            assertInsideViewport(projects, "empty Projects workbench");
            assert(
                projects.getAttribute("data-oaam-asset-count") === "0" &&
                    projects.querySelector("[data-oaam-action='open-deployments']") === null,
                "empty Projects workbench exposes content or a Deployment shortcut",
            );
            click(projects.querySelector("[data-oaam-subject-choice='global']"));
            const global = await waitFor(() => {
                const candidate = document.querySelector("[data-oaam-route='library'][data-oaam-subject='global']");
                return candidate?.querySelector(".library-empty-state") instanceof HTMLElement ? candidate : false;
            }, "loaded empty Global workbench");
            assertInsideViewport(global, "empty Global workbench");
            assert(
                global.getAttribute("data-oaam-asset-count") === "0" &&
                    global.querySelector("[data-oaam-action='open-deployments']") === null,
                "empty Global workbench exposes content or a Deployment shortcut",
            );

            return {
                innerWidth,
                innerHeight,
                resolvedTheme: document.documentElement.dataset.oaamTheme,
                resolvedLocale: document.documentElement.lang,
                dialogInventory: JSON.parse(document.documentElement.dataset.oaamDialogInventory ?? "[]"),
                dialogStates: [],
                journeyStates: [
                    "first_run_onboarding:welcome",
                    "first_run_onboarding:locations",
                    "first_run_onboarding:tools",
                    "first_run_onboarding:no_content",
                    "first_run_onboarding:complete",
                    "project_management:empty",
                    "asset_library_lifecycle:empty",
                ],
                routeStates: ["onboarding:ready", "library:ready"],
                surfaceInventory: JSON.parse(document.documentElement.dataset.oaamSurfaceInventory ?? "[]"),
            };
        }.toString()})(${JSON.stringify(entry)}, ${ordinaryLanguageRendererArguments()})`,
        true,
    );
}
