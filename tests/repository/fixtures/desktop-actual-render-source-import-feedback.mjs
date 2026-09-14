import { ordinaryLanguageRendererArguments } from "./desktop-actual-render-language.mjs";

export async function inspectSourceImportFeedbackCase(webContents, entry) {
    return webContents.executeJavaScript(
        `(${async function inspect(entryValue, assertOrdinarySurfaceLanguage, lexicon) {
            const assert = (condition, label) => {
                if (!condition) throw new Error(`${entryValue.id}: ${label}`);
            };
            const waitFor = async (predicate, label) => {
                const deadline = performance.now() + 10_000;
                while (performance.now() < deadline) {
                    const value = predicate();
                    if (value) return value;
                    await new Promise((resolve) => setTimeout(resolve, 20));
                }
                throw new Error(`${entryValue.id}: timed out waiting for ${label}`);
            };
            const click = (element, label) => {
                assert(element instanceof HTMLButtonElement, `${label} button missing`);
                assert(!element.disabled, `${label} button disabled`);
                element.click();
            };
            const interaction = (id) => document.querySelector(`[data-oaam-interaction-entry='${id}']`);
            const observedJourneyStates = [];
            await waitFor(() => document.querySelector("[data-oaam-route='library'][data-oaam-state='ready']"), "library");
            click(
                await waitFor(() => document.querySelector(".library-source-locations-button"), "source locations action"),
                "source locations",
            );
            await waitFor(() => document.querySelector(".source-library-row"), "source rows");
            click(document.querySelector(".source-library-row"), "source detail");
            const detail = await waitFor(() => document.querySelector(".source-library-detail"), "source detail");
            assert(detail.querySelector("code")?.textContent === "C:\\Users\\Example\\.claude", "source path changed");
            assertOrdinarySurfaceLanguage(detail, "source detail", entryValue.id, lexicon);
            observedJourneyStates.push("asset_and_sources_views:source_detail");

            document.documentElement.dataset.oaamFeedbackSourceRefresh = "hold";
            click(interaction("features.source-library.source_library_workspace.013"), "source refresh");
            await waitFor(
                () => document.querySelector("[data-oaam-route='sources'][data-oaam-state='loading']"),
                "held source refresh",
            );
            assert(document.documentElement.dataset.oaamFeedbackSourceRefresh === "pending", "source response was not held");
            observedJourneyStates.push("asset_and_sources_views:source_loading");
            window.dispatchEvent(new Event("oaam-feedback-release-source"));
            const failedSources = await waitFor(
                () => document.querySelector("[data-oaam-route='sources'][data-oaam-state='failed']"),
                "failed source refresh",
            );
            assert(document.documentElement.dataset.oaamFeedbackSourceRefresh === "failed", "wrong source response");
            assert(failedSources.querySelector(".source-library-detail") === null, "failure retained stale detail");
            assert(
                failedSources.querySelector(".source-library-main .workbench-notice") === null,
                "source failure repeats an inner notice",
            );
            assertOrdinarySurfaceLanguage(failedSources, "source failure", entryValue.id, lexicon);
            observedJourneyStates.push("asset_and_sources_views:source_failed");
            click(interaction("features.source-library.source_library_workspace.014"), "source retry");
            await waitFor(() => document.querySelector(".source-library-detail"), "recovered exact source detail");

            click(document.querySelector("[data-oaam-action='start-guided-import']"), "guided import");
            const locations = await waitFor(() => document.querySelector("[data-oaam-step='locations']"), "locations");
            for (const card of locations.querySelectorAll(".environment-card")) {
                const input = card.querySelector("input[type='checkbox']");
                assert(input instanceof HTMLInputElement, "Environment checkbox missing");
                const selected = card.getAttribute("data-oaam-environment-platform") === "win32";
                if (input.checked !== selected) input.click();
            }
            click(locations.querySelector("[data-oaam-journey-continue='locations']"), "continue locations");
            const tools = await waitFor(() => document.querySelector("[data-oaam-step='tools']"), "tools");
            document.documentElement.dataset.oaamHoldGlobalProbe = "true";
            click(tools.querySelector("[data-oaam-journey-continue='tools']"), "start scan");
            await waitFor(() => document.querySelector(".discovery-probe-progress[aria-busy='true']"), "held scan");
            assert(document.documentElement.dataset.oaamContainmentStage === "probing", "scan did not reach held Client seam");
            observedJourneyStates.push("ordinary_guided_import:scanning");
            window.dispatchEvent(new Event("oaam-actual-render-release-probe"));
            const sources = await waitFor(() => document.querySelector("[data-oaam-step='sources']"), "source review");
            await waitFor(() => sources.querySelectorAll(".source-review-card").length === 3, "three source roots");
            assert(document.documentElement.dataset.oaamProbeEnvironmentCount === "1", "scanned an unselected Environment");
            const projectCard = [...sources.querySelectorAll(".source-review-card")].find(
                (card) => card.dataset.oaamSourcePath === "C:\\Users\\Example\\work\\sample-project",
            );
            assert(projectCard instanceof HTMLElement, "Project source is missing");
            click(projectCard.querySelector("[data-oaam-source-action='ignore']"), "ignore Project source");
            click(
                await waitFor(
                    () => projectCard.querySelector("[data-oaam-source-action='confirm-ignore']"),
                    "ignore confirmation",
                ),
                "confirm ignore",
            );
            await waitFor(() => projectCard.dataset.oaamSourceState === "ignored", "ignored Project source");
            click(sources.querySelector("[data-oaam-journey-continue='sources']"), "read chosen sources");
            await waitFor(() => document.querySelectorAll("[data-oaam-import-candidate-id]").length === 2, "two candidates");
            const candidateReview = document.querySelector(".import-review-main");
            assert(candidateReview instanceof HTMLElement, "candidate review missing");
            const ordinaryReadFeedback = candidateReview.innerText;
            assert(
                ordinaryReadFeedback.includes("AGENTS.override.md") && ordinaryReadFeedback.includes("AGENTS.md"),
                "actual Guidance filename limitation is missing from the ordinary review",
            );
            assert(
                !/saved choice|gespeicherte Auswahl|保存済みの選択|保存的选择/u.test(ordinaryReadFeedback),
                "routine managed omissions are presented as a saved-choice conflict",
            );
            assert(
                !ordinaryReadFeedback.includes("already managed by OAAM"),
                "routine managed omission leaks its technical cause into the ordinary review",
            );
            const readRecords = candidateReview.querySelectorAll(".protocol-technical-record");
            assert(readRecords.length === 3, "read diagnostic evidence was discarded or duplicated");
            assert(
                candidateReview.textContent.includes("read.managed_source_entry_ignored") &&
                    candidateReview.textContent.includes("codex.guidance_fallback_configuration_unknown"),
                "exact source diagnostic codes were discarded",
            );
            assertOrdinarySurfaceLanguage(candidateReview, "source read limitations", entryValue.id, lexicon);
            const importButton = await waitFor(() => document.querySelector("[data-oaam-import-commit]"), "import action");
            click(importButton, "import selected Assets");
            await waitFor(() => document.documentElement.dataset.oaamFeedbackAcceptStage === "pending", "held import");
            assert(importButton.disabled, "pending import can be submitted twice");
            await waitFor(
                () => document.querySelector(".import-review-activity [data-oaam-loading-indicator]"),
                "import activity indicator",
            );
            assert(document.querySelector("[data-oaam-import-result-status]") === null, "pending import shows a result");
            observedJourneyStates.push("ordinary_guided_import:accepting");
            window.dispatchEvent(new Event("oaam-feedback-release-import"));
            await waitFor(
                () => document.documentElement.dataset.oaamFeedbackAcceptStage === "failed" && !importButton.disabled,
                "failed import retry",
            );
            assert(document.querySelector("[data-oaam-import-result-status]") === null, "rejected import shows success");
            assert(
                document.querySelectorAll(".import-review-main > .workbench-notice").length === 1,
                "import failure has competing notices",
            );
            assertOrdinarySurfaceLanguage(
                document.querySelector(".import-review-main"),
                "import failure",
                entryValue.id,
                lexicon,
            );
            observedJourneyStates.push("ordinary_guided_import:accept_failed");
            click(importButton, "retry import");
            const result = await waitFor(
                () => document.querySelector(".onboarding-completion .import-result-content"),
                "visible mixed result",
            );
            const items = [...result.querySelectorAll("[data-oaam-import-result-status]")];
            assert(items.length === 2, "mixed result count changed");
            assert(
                items.every((item) => item.closest("[hidden]") === null),
                "mixed result is hidden",
            );
            assert(
                JSON.stringify(items.map((item) => item.dataset.oaamImportResultStatus)) === '["complete","failed"]',
                "mixed result was relabelled",
            );
            assert(document.documentElement.dataset.oaamFeedbackAcceptCount === "2", "import dispatch count changed");
            assert(document.documentElement.dataset.oaamFeedbackAcceptStage === "partial", "partial fixture response missing");
            assert(result.querySelector(".workbench-notice") === null, "mixed result repeats generic warning surfaces");
            assert(result.textContent.includes("fixture.import.failed"), "prior batch technical evidence was discarded");
            assert(result.textContent.includes("fixture.import.item_failed"), "item technical evidence was discarded");
            assertOrdinarySurfaceLanguage(result, "mixed import result", entryValue.id, lexicon);
            observedJourneyStates.push("ordinary_guided_import:partial");
            assert(document.querySelector("[data-oaam-renderer-failure]") === null, "renderer failed");
            return {
                innerWidth,
                innerHeight,
                resolvedTheme: document.documentElement.dataset.oaamTheme,
                resolvedLocale: document.documentElement.lang,
                dialogInventory: JSON.parse(document.documentElement.dataset.oaamDialogInventory ?? "[]"),
                dialogStates: [],
                journeyStates: observedJourneyStates,
                routeStates: ["library:ready", "sources:ready", "sources:loading", "sources:failed", "guided_import:ready"],
                surfaceInventory: JSON.parse(document.documentElement.dataset.oaamSurfaceInventory ?? "[]"),
            };
        }.toString()})(${JSON.stringify(entry)}, ${ordinaryLanguageRendererArguments()})`,
        true,
    );
}
