export function assertImportStepBounds(root, assert, label) {
    for (const step of root.querySelectorAll(".import-journey-steps > li")) {
        const box = step.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(step);
        for (const text of range.getClientRects()) {
            assert(
                text.left >= box.left - 1 &&
                    text.right <= box.right + 1 &&
                    text.top >= box.top - 1 &&
                    text.bottom <= box.bottom + 1,
                `${label}: step label ${JSON.stringify(step.textContent)} escapes its cell ` +
                    `(text=${text.left}..${text.right}, cell=${box.left}..${box.right})`,
            );
        }
    }
}

async function sidebarGeometry(webContents, focusLast = false) {
    return webContents.executeJavaScript(
        `(${function inspect(focus) {
            const tree = document.querySelector(".asset-tree");
            const footer = document.querySelector(".library-sidebar-footer");
            const chrome = document.querySelector(".desktop-window-chrome");
            const rows = tree?.querySelectorAll(".asset-tree-project[data-oaam-project-id]");
            const last = rows?.[rows.length - 1];
            if (
                !(tree instanceof HTMLElement) ||
                !(footer instanceof HTMLElement) ||
                !(chrome instanceof HTMLElement) ||
                !(last instanceof HTMLElement)
            ) {
                throw new Error("Dense Project sidebar owners are missing");
            }
            if (focus) last.focus();
            const treeBox = tree.getBoundingClientRect();
            const footerBox = footer.getBoundingClientRect();
            const lastBox = last.getBoundingClientRect();
            return {
                count: rows.length,
                scrollTop: tree.scrollTop,
                scrollHeight: tree.scrollHeight,
                clientHeight: tree.clientHeight,
                x: Math.round(treeBox.left + treeBox.width / 2),
                y: Math.round(treeBox.top + 80),
                contained: treeBox.top >= 0 && treeBox.bottom <= footerBox.top + 1 && footerBox.bottom <= innerHeight + 1,
                footerBottom: footerBox.bottom,
                viewportHeight: innerHeight,
                chromeTop: chrome.getBoundingClientRect().top,
                lastVisible: lastBox.top >= treeBox.top && lastBox.bottom <= treeBox.bottom + 1,
                focused: document.activeElement === last,
            };
        }.toString()})(${JSON.stringify(focusLast)})`,
        true,
    );
}

export async function proveDenseProjectSidebar(webContents, entry) {
    const before = await sidebarGeometry(webContents);
    if (before.count !== 64 || !before.contained || before.scrollHeight <= before.clientHeight) {
        throw new Error(
            `${entry.id}: 64 Projects do not retain an internal scroll owner and visible footer: ${JSON.stringify(before)}`,
        );
    }
    await webContents.executeJavaScript("document.querySelector('.asset-tree').scrollTop = 0", true);
    webContents.focus();
    let moved = false;
    for (const deltaY of [-560, 560]) {
        webContents.sendInputEvent({ type: "mouseMove", x: before.x, y: before.y });
        webContents.sendInputEvent({ type: "mouseWheel", x: before.x, y: before.y, deltaY, canScroll: true });
        await new Promise((resolve) => setTimeout(resolve, 100));
        if ((await sidebarGeometry(webContents)).scrollTop > 0) {
            moved = true;
            break;
        }
    }
    const after = await sidebarGeometry(webContents, true);
    if (!moved || !after.contained || !after.lastVisible || !after.focused || Math.abs(after.chromeTop - before.chromeTop) > 1) {
        throw new Error(
            `${entry.id}: wheel/focus cannot reach the final Project without moving chrome/footer: ${JSON.stringify({ moved, after })}`,
        );
    }
}

async function onboardingGeometry(webContents, focusLast = false) {
    return webContents.executeJavaScript(
        `(${function inspect(focus) {
            const shell = document.querySelector(".onboarding-shell");
            const chrome = document.querySelector(".desktop-window-chrome");
            if (!(shell instanceof HTMLElement) || !(chrome instanceof HTMLElement)) return undefined;
            const actions = [...shell.querySelectorAll(".source-review-card button:not([disabled])")];
            const last = actions[actions.length - 1];
            if (focus && last instanceof HTMLElement) last.focus();
            const box = shell.getBoundingClientRect();
            const chromeBox = chrome.getBoundingClientRect();
            const lastBox = last?.getBoundingClientRect();
            const progress = shell.querySelector(".discovery-probe-progress");
            const spinner = progress?.querySelector("[data-oaam-loading-indicator]");
            const spinnerBox = spinner?.getBoundingClientRect();
            return {
                stage: document.documentElement.dataset.oaamContainmentStage,
                step: shell.dataset.oaamStep,
                scrollTop: shell.scrollTop,
                scrollHeight: shell.scrollHeight,
                clientHeight: shell.clientHeight,
                x: Math.round(box.left + box.width / 2),
                y: Math.round(box.top + box.height / 2),
                contained: box.top >= chromeBox.bottom - 1 && box.bottom <= innerHeight + 1,
                chrome: [chromeBox.top, chromeBox.bottom, chromeBox.left, chromeBox.right],
                lastVisible: lastBox !== undefined && lastBox.top >= box.top && lastBox.bottom <= box.bottom + 1,
                focused: last !== undefined && document.activeElement === last,
                progressVisible:
                    progress?.getAttribute("aria-busy") === "true" &&
                    spinnerBox !== undefined &&
                    spinnerBox.width > 0 &&
                    spinnerBox.top >= box.top &&
                    spinnerBox.bottom <= box.bottom,
                animationName: spinner === null || spinner === undefined ? undefined : getComputedStyle(spinner).animationName,
                resolvedLocale: document.documentElement.lang,
            };
        }.toString()})(${JSON.stringify(focusLast)})`,
        true,
    );
}

export async function proveOnboardingContainment(webContents, entry, journey) {
    let journeyFailure;
    const completion = journey.catch((error) => {
        journeyFailure = error;
    });
    const fail = (message, observation) => {
        throw new Error(`${entry.id}: ${message}: ${JSON.stringify(observation)}`);
    };
    const waitForStage = async (stage) => {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
            if (journeyFailure !== undefined) throw journeyFailure;
            const observation = await onboardingGeometry(webContents);
            if (observation?.stage === stage && (stage !== "probing" || observation.progressVisible)) return observation;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        fail(`onboarding did not reach observable ${stage}`, await onboardingGeometry(webContents));
    };
    const release = (stage) =>
        webContents.executeJavaScript(`window.dispatchEvent(new Event('oaam-actual-render-release-${stage}'))`, true);
    try {
        const probing = await waitForStage("probing");
        if (
            !probing.contained ||
            probing.step !== "results" ||
            probing.resolvedLocale !== entry.locale ||
            probing.animationName !== (entry.reducedMotion ? "none" : "oaam-status-spin")
        ) {
            fail("scoped probe progress is not visible with the requested motion preference", probing);
        }
        await release("probe");
        await waitForStage("sources");
        await webContents.executeJavaScript("document.querySelector('.onboarding-shell').scrollTop = 0", true);
        const before = await onboardingGeometry(webContents);
        if (!before.contained) fail("source review escaped its content frame", before);
        const needsScroll = before.scrollHeight > before.clientHeight + 1;
        if (entry.windowCssViewport.height <= 720 && !needsScroll) {
            fail("compact source-review fixture does not exercise scroll ownership", before);
        }
        let moved = !needsScroll;
        if (needsScroll) {
            webContents.focus();
            for (const deltaY of [-420, 420]) {
                webContents.sendInputEvent({ type: "mouseMove", x: before.x, y: before.y });
                webContents.sendInputEvent({ type: "mouseWheel", x: before.x, y: before.y, deltaY, canScroll: true });
                await new Promise((resolve) => setTimeout(resolve, 100));
                if ((await onboardingGeometry(webContents)).scrollTop > 0) {
                    moved = true;
                    break;
                }
            }
        }
        const focused = await onboardingGeometry(webContents, true);
        if (
            !moved ||
            !focused.contained ||
            !focused.focused ||
            !focused.lastVisible ||
            focused.chrome.some((value, index) => Math.abs(value - probing.chrome[index]) > 1)
        ) {
            fail("source-review wheel/focus moved chrome or failed to reach its final action", { moved, before, focused });
        }
        await webContents.executeJavaScript("document.querySelector('.onboarding-shell').scrollTop = 0", true);
        await release("sources");
        const result = await completion;
        if (journeyFailure !== undefined) throw journeyFailure;
        return result;
    } finally {
        await release("probe");
        await release("sources");
    }
}
