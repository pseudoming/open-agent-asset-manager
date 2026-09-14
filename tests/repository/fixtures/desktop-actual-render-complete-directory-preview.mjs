import { inspectPreviewFileInspector } from "./desktop-actual-render-file-inspector.mjs";
import { sendNativeKeyAndWait } from "./desktop-actual-render-native-keyboard.mjs";

export async function inspectCompleteDirectoryPreviewCase(webContents, entry) {
    const evaluate = async (source) => {
        const result = await webContents.executeJavaScript(
            `(async () => { try { return { value: await (${source}) }; }
                catch (error) { return { error: String(error) }; } })()`,
            true,
        );
        if (result.error !== undefined) throw new Error(`${entry.id}: ${result.error}`);
        return result.value;
    };
    const result = await evaluate(
        `(${async function inspectCompleteDirectoryPreview(entryValue, inspectFileInspector) {
            const waitFor = async (predicate, label, timeoutMs = 10_000) => {
                const deadline = performance.now() + timeoutMs;
                while (performance.now() < deadline) {
                    const value = predicate();
                    if (value) return value;
                    await new Promise((resolve) => setTimeout(resolve, 25));
                }
                throw new Error(`${entryValue.id}: timed out waiting for ${label}`);
            };
            const assert = (condition, message) => {
                if (!condition) throw new Error(`${entryValue.id}: ${message}`);
            };
            const click = (element, label) => {
                assert(element instanceof HTMLButtonElement, `${label} is not a button`);
                assert(!element.disabled, `${label} is disabled`);
                element.click();
            };

            const library = await waitFor(
                () => document.querySelector("[data-oaam-route='library'][data-oaam-state='ready']"),
                "ready Project library",
            );
            const manage = await waitFor(
                () => library.querySelector(".library-toolbar-actions [data-oaam-action='open-deployments']"),
                "manage existing deployments action",
            );
            click(manage, "manage existing deployments action");

            const surface = await waitFor(
                () => document.querySelector("[data-oaam-route='deployment'][data-oaam-state='ready']"),
                "ready Deployment route",
            );
            assert(surface.dataset.oaamDeploymentMode === "manage", "complete-directory review did not open manage mode");
            const workspace = await waitFor(() => surface.querySelector(".catalog-deployment-workspace"), "Deployment workspace");
            const deploymentInput = await waitFor(
                () =>
                    workspace.querySelector(
                        "[data-oaam-deployment-action='select'] input[value='44444444-4444-4444-8444-444444444444']",
                    ),
                "exact Deployment selection",
            );
            assert(deploymentInput instanceof HTMLInputElement, "exact Deployment selection is not an input");
            deploymentInput.click();
            click(
                await waitFor(() => workspace.querySelector("[data-oaam-deployment-action='analyze']"), "analyze action"),
                "analyze action",
            );

            const option = await waitFor(
                () =>
                    workspace.querySelector(
                        "[data-oaam-semantic-kind='skill.body'] " +
                            "[data-oaam-render-option-fingerprint='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']",
                    ),
                "exact Skill render option",
            );
            assert(option instanceof HTMLElement, "exact Skill render option is not rendered");
            const autoSelected = option.querySelector('[data-oaam-render-option-auto-selected="true"]');
            const optionInput = option.querySelector("input[type='radio']");
            assert(
                autoSelected instanceof HTMLElement || optionInput instanceof HTMLInputElement,
                "exact Skill render option has no automatic or explicit selection",
            );
            if (optionInput instanceof HTMLInputElement) optionInput.click();
            click(
                await waitFor(() => workspace.querySelector("[data-oaam-deployment-action='preview']"), "preview action"),
                "preview action",
            );

            const graph = await waitFor(
                () => workspace.querySelector("[data-oaam-preview-graph='complete']"),
                "complete managed-directory preview graph",
            );
            const previewResult = await waitFor(() => {
                const result = workspace.querySelector("[data-oaam-preview-result='44444444-4444-4444-8444-444444444444']");
                return result instanceof HTMLElement && document.activeElement === result ? result : undefined;
            }, "user-requested Preview result focus");
            const previewHeading = previewResult.querySelector("h3");
            assert(previewHeading instanceof HTMLElement, "focused Preview has no heading");
            const headingBounds = previewHeading.getBoundingClientRect();
            assert(
                headingBounds.height > 0 && headingBounds.top >= 0 && headingBounds.bottom <= innerHeight,
                "Preview result heading remains outside the viewport",
            );
            assert(
                graph.querySelectorAll("[data-oaam-preview-entry-kind='directory']").length === 5,
                "directory graph is incomplete",
            );
            assert(graph.querySelectorAll("[data-oaam-preview-entry-kind='file']").length === 4, "file graph is incomplete");
            assert(graph.classList.contains("catalog-preview-graph"), "complete graph lost its grouped preview container");
            const changes = graph.querySelector(":scope > [data-oaam-preview-graph-changes]");
            const unchanged = graph.querySelector(":scope > [data-oaam-preview-graph-unchanged]");
            assert(changes instanceof HTMLElement, "actual changes have no primary review section");
            assert(unchanged instanceof HTMLDetailsElement && !unchanged.open, "unchanged graph is not initially collapsed");
            assert(
                changes.querySelectorAll("[data-oaam-preview-entry-kind]").length === 8 &&
                    unchanged.querySelectorAll("[data-oaam-preview-entry-kind]").length === 1 &&
                    changes.querySelector("[data-oaam-preview-change-kind='unchanged']") === null &&
                    unchanged.querySelector("[data-oaam-preview-change-kind='unchanged']") !== null,
                "changed and unchanged graph entries lost their exact review ownership",
            );
            assert(
                changes.nextElementSibling === unchanged &&
                    changes.firstElementChild?.getAttribute("data-oaam-preview-graph-section") === "files",
                "actual file changes are not presented before directories and unchanged content",
            );
            const unchangedSummary = unchanged.querySelector(":scope > summary");
            assert(unchangedSummary instanceof HTMLElement, "unchanged graph disclosure is missing");
            unchangedSummary.click();
            await new Promise((resolve) => requestAnimationFrame(resolve));
            assert(
                unchanged.open && unchanged.querySelector("[data-oaam-preview-entry-kind]").getBoundingClientRect().height > 0,
                "expanding unchanged content did not reveal the retained graph",
            );
            unchangedSummary.click();
            assert(!unchanged.open, "unchanged graph cannot be collapsed again");
            assert(graph.querySelector(".preview-detail") === null, "complete graph retained nested card presentation");
            const expectedDirectories = [
                [".claude/skills/release-helper", "managed", "unchanged", "present", "present"],
                [".claude/skills/release-helper/resources", "unmanaged", "create", "missing", "present"],
                [".claude/skills/release-helper/empty", "unmanaged", "create", "missing", "present"],
                [".claude/skills/release-helper/old", "managed", "remove_managed", "present", "missing"],
                [".claude/skills/release-helper/scratch", "unmanaged", "remove_unmanaged", "present", "missing"],
            ];
            for (const [path, baseline, change, current, desired] of expectedDirectories) {
                const row = graph.querySelector(`[data-oaam-preview-entry-kind='directory'][data-oaam-preview-path='${path}']`);
                assert(row instanceof HTMLElement, `missing directory graph row ${path}`);
                assert(row.classList.contains("catalog-preview-directory-row"), `directory row ${path} is not compact`);
                assert(
                    row.dataset.oaamPreviewBoundary === ".claude/skills/release-helper" &&
                        row.dataset.oaamPreviewBaselineState === baseline &&
                        row.dataset.oaamPreviewChangeKind === change &&
                        row.dataset.oaamPreviewCurrentState === current &&
                        row.dataset.oaamPreviewDesiredState === desired,
                    `directory graph row ${path} lost its exact authority state`,
                );
            }
            const expectedFiles = [
                [".claude/skills/release-helper/SKILL.md", "managed", "update_managed"],
                [".claude/skills/release-helper/resources/reference.md", "unmanaged", "create"],
                [".claude/skills/release-helper/old.bin", "managed", "remove_managed"],
                [".claude/skills/release-helper/scratch/local.txt", "unmanaged", "replace_unmanaged"],
            ];
            for (const [path, baseline, change] of expectedFiles) {
                const row = graph.querySelector(`[data-oaam-preview-entry-kind='file'][data-oaam-preview-path='${path}']`);
                assert(row instanceof HTMLElement, `missing file graph row ${path}`);
                assert(row.classList.contains("catalog-preview-file-row"), `file row ${path} is not compact`);
                assert(
                    row.dataset.oaamPreviewBaselineState === baseline && row.dataset.oaamPreviewChangeKind === change,
                    `file graph row ${path} lost its exact authority state`,
                );
            }
            assert(graph.querySelector("input") === null, "complete graph added per-entry authorization controls");
            await inspectFileInspector({ workspace, graph, assert, click, waitFor });
            assert(
                graph.querySelector(".catalog-preview-root")?.textContent === ".claude/skills/release-helper/",
                "graph root is not identified once",
            );
            const removedFile = graph.querySelector('[data-oaam-preview-path=".claude/skills/release-helper/scratch/local.txt"]');
            assert(
                removedFile?.querySelector("strong")?.textContent === "scratch/local.txt",
                "graph paths were not shortened within the exact root",
            );
            const removalCopy = {
                en: "Remove this reviewed existing file",
                de: "Diese geprüfte vorhandene Datei entfernen",
                ja: "確認した既存ファイルを削除",
                "zh-CN": "删除本次审查的现有文件",
            };
            assert(
                removedFile?.textContent.includes(removalCopy[entryValue.locale]),
                "unmanaged file removal lost its localized action",
            );

            const request = JSON.parse(document.documentElement.dataset.oaamCompleteDirectoryPreviewRequest ?? "null");
            assert(request?.deploymentId === "44444444-4444-4444-8444-444444444444", "preview request lost Deployment identity");
            assert(
                request?.selection?.semanticOptions?.length === 1,
                "preview request did not use one directory-level selection",
            );
            assert(
                request.selection.semanticOptions[0]?.optionFingerprint ===
                    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                "preview request lost the selected directory graph fingerprint",
            );
            const confirmations = [...workspace.querySelectorAll("input[type='checkbox']")];
            assert(confirmations.length === 0, "complete graph still requires checkbox-unlocked replacement");
            const replace = workspace.querySelector("[data-oaam-replacement-action='review']");
            assert(replace instanceof HTMLButtonElement && !replace.disabled, "replacement review action is unavailable");

            graph.scrollIntoView({ block: "start", inline: "nearest" });
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const graphBounds = graph.getBoundingClientRect();
            assert(
                graphBounds.bottom > 0 && graphBounds.top < window.innerHeight,
                "complete graph is outside the captured viewport after deterministic scrolling",
            );
            assert(
                graphBounds.left >= -1 && graphBounds.right <= window.innerWidth + 1,
                "complete graph overflows the captured viewport horizontally",
            );

            return {
                innerWidth,
                innerHeight,
                resolvedTheme: document.documentElement.dataset.oaamTheme,
                resolvedLocale: document.documentElement.lang,
                dialogInventory: JSON.parse(document.documentElement.dataset.oaamDialogInventory ?? "[]"),
                dialogStates: [],
                journeyStates: ["deployment_and_reverse:complete_directory_preview"],
                routeStates: ["library:ready", "deployment:ready"],
                surfaceInventory: JSON.parse(document.documentElement.dataset.oaamSurfaceInventory ?? "[]"),
            };
        }.toString()})(${JSON.stringify(entry)}, ${inspectPreviewFileInspector.toString()})`,
        true,
    );
    await evaluate(
        `(async () => {
        const action = document.querySelector('[data-oaam-replacement-action="review"]');
        action.focus(); action.click();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const dialog = document.querySelector('[data-oaam-dialog="deployment_replacement"]');
        if (!(dialog instanceof HTMLElement) || dialog.getAttribute('aria-modal') !== 'true') throw new Error('replacement dialog missing');
        const rect = dialog.getBoundingClientRect();
        if (rect.left < 0 || rect.top < 0 || rect.right > innerWidth || rect.bottom > innerHeight) throw new Error('replacement dialog escapes viewport');
        if (!dialog.contains(document.activeElement) || document.activeElement?.getAttribute('data-oaam-replacement-action') === 'confirm') throw new Error('replacement dialog default focus is unsafe');
        const confirm = dialog.querySelector('[data-oaam-replacement-action="confirm"]');
        if (!(confirm instanceof HTMLButtonElement)) throw new Error('replacement confirm missing');
        const footer = dialog.querySelector('.workbench-dialog-actions');
        const review = dialog.querySelector('.catalog-replacement-review');
        if (!(footer instanceof HTMLElement) || !(review instanceof HTMLElement)) throw new Error('replacement review or footer missing');
        const footerRect = footer.getBoundingClientRect();
        const confirmRect = confirm.getBoundingClientRect();
        if (footerRect.bottom > rect.bottom || confirmRect.bottom > innerHeight || confirmRect.top < rect.top) throw new Error('replacement footer is not visible');
        if (review.contains(footer)) throw new Error('replacement footer is inside scrolling graph');
        const subject = dialog.querySelector('.catalog-replacement-subject');
        if (!(subject instanceof HTMLElement) || review.contains(subject) || subject.getBoundingClientRect().bottom > review.getBoundingClientRect().top + 1) throw new Error('replacement subject is not fixed above its graph');
        if (review.querySelectorAll('[data-oaam-reviewed-relative-path]').length !== 9) throw new Error('replacement review dropped graph entries');
        confirm.focus();
    })()`,
        true,
    );
    await sendNativeKeyAndWait(
        webContents,
        "Tab",
        `(() => {
        const dialog = document.querySelector('[data-oaam-dialog="deployment_replacement"]');
        return dialog !== null && document.activeElement === dialog.querySelector('button');
    })()`,
        `${entry.id}: replacement dialog native focus loop`,
    );
    const readDialogScroll = () =>
        evaluate(
            `(() => {
        const review = document.querySelector('.catalog-replacement-review');
        const footer = document.querySelector('.catalog-replacement-dialog .workbench-dialog-actions');
        const last = review?.querySelector('.catalog-replacement-paths > li:last-child');
        if (!(review instanceof HTMLElement) || !(footer instanceof HTMLElement) || !(last instanceof HTMLElement)) throw new Error('replacement scroll owner detached');
        const rect = review.getBoundingClientRect();
        const lastRect = last.getBoundingClientRect();
        return { x: Math.floor(rect.left + rect.width / 2), y: Math.floor(rect.top + rect.height / 2),
            scrollTop: review.scrollTop, overflows: review.scrollHeight > review.clientHeight + 1,
            footerTop: footer.getBoundingClientRect().top,
            subjectTop: document.querySelector('.catalog-replacement-subject').getBoundingClientRect().top,
            reached: lastRect.top >= rect.top && lastRect.bottom <= rect.bottom + 1 };
    })()`,
            true,
        );
    const beforeScroll = await readDialogScroll();
    let afterScroll = beforeScroll;
    if (beforeScroll.overflows && !beforeScroll.reached) {
        webContents.focus();
        for (const multiplier of [1, entry.deviceScaleFactor]) {
            for (let attempt = 0; attempt < 8 && !afterScroll.reached; attempt += 1) {
                webContents.sendInputEvent({
                    type: "mouseMove",
                    x: Math.round(beforeScroll.x * multiplier),
                    y: Math.round(beforeScroll.y * multiplier),
                });
                webContents.sendInputEvent({
                    type: "mouseWheel",
                    x: Math.round(beforeScroll.x * multiplier),
                    y: Math.round(beforeScroll.y * multiplier),
                    deltaY: -480,
                    canScroll: true,
                });
                await new Promise((resolve) => setTimeout(resolve, 50));
                afterScroll = await readDialogScroll();
            }
            if (afterScroll.reached) break;
        }
        if (!afterScroll.reached || afterScroll.scrollTop <= beforeScroll.scrollTop)
            throw new Error(`${entry.id}: replacement graph did not respond to native wheel input`);
    }
    if (Math.abs(afterScroll.footerTop - beforeScroll.footerTop) > 1)
        throw new Error(`${entry.id}: replacement footer moved with graph scrolling`);
    if (Math.abs(afterScroll.subjectTop - beforeScroll.subjectTop) > 1)
        throw new Error(`${entry.id}: replacement subject moved with graph scrolling`);
    await sendNativeKeyAndWait(
        webContents,
        "Escape",
        `(() => {
        const action = document.querySelector('[data-oaam-replacement-action="review"]');
        return !document.querySelector('[data-oaam-dialog="deployment_replacement"]') &&
            action !== null && document.activeElement === action;
    })()`,
        `${entry.id}: replacement dialog native Escape and trigger focus restoration`,
    );
    return { ...result, dialogStates: ["deployment_replacement"] };
}
