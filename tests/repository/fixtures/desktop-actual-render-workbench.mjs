function fail(message) {
    throw new Error(message);
}

function trace(message) {
    if (process.env.OAAM_ACTUAL_RENDER_TRACE === "1") process.stdout.write(`OAAM_ACTUAL_RENDER_TRACE ${message}\n`);
}

async function focusRendererForRealInput(
    webContents,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
) {
    webContents.focus();
    await sleep(50);
}

export async function proveWheelReachability(webContents, entry, probe) {
    if (probe.scrollHeight <= probe.clientHeight) return;
    await focusRendererForRealInput(webContents);
    const positions = [
        { x: probe.x, y: probe.y },
        {
            x: Math.round(probe.x * entry.deviceScaleFactor),
            y: Math.round(probe.y * entry.deviceScaleFactor),
        },
    ];
    for (const position of positions) {
        webContents.sendInputEvent({ type: "mouseMove", x: position.x, y: position.y });
        for (const deltaY of [-240, 240]) {
            for (let index = 0; index < 16; index += 1) {
                webContents.sendInputEvent({
                    type: "mouseWheel",
                    x: position.x,
                    y: position.y,
                    deltaY,
                    canScroll: true,
                });
                await new Promise((resolve) => setTimeout(resolve, 50));
                const scrollTop = await webContents.executeJavaScript(
                    "document.querySelector('.settings-scroll')?.scrollTop ?? 0",
                    true,
                );
                if (scrollTop > 0) return;
            }
        }
    }
    fail(`${entry.id}: real mouse-wheel input did not move the Settings scroll owner`);
}

async function readDeploymentScrollState(webContents) {
    return webContents.executeJavaScript(
        `(() => {
            const owner = document.querySelector(".deployment-page");
            const heading = document.querySelector(
                "[data-oaam-deployment-mode='create'] #deployment-target-title, #deployment-title",
            );
            if (!(owner instanceof HTMLElement) || !(heading instanceof HTMLElement)) return undefined;
            const ownerRect = owner.getBoundingClientRect();
            const headingRect = heading.getBoundingClientRect();
            return {
                x: Math.floor(ownerRect.left + ownerRect.width / 2),
                y: Math.floor(ownerRect.top + Math.min(ownerRect.height / 2, 80)),
                scrollTop: owner.scrollTop,
                scrollHeight: owner.scrollHeight,
                clientHeight: owner.clientHeight,
                reached: headingRect.top >= ownerRect.top && headingRect.bottom <= ownerRect.bottom,
            };
        })()`,
        true,
    );
}

export async function proveDeploymentWheelReachability(webContents, entry, _probe, options = {}) {
    const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    const now = options.now ?? Date.now;
    const timeoutMs = options.timeoutMs ?? 10_000;
    const settleTimeoutMs = options.settleTimeoutMs ?? 500;
    const initial = await readDeploymentScrollState(webContents);
    if (initial === undefined) fail(`${entry.id}: Deployment scroll owner or target heading is missing`);
    if (initial.scrollHeight <= initial.clientHeight) return;
    if (initial.reached) return;
    await focusRendererForRealInput(webContents, sleep);

    const deadline = now() + timeoutMs;
    let attempt = 0;
    let movementObserved = false;
    let workingDeltaY;
    while (now() < deadline) {
        const before = await readDeploymentScrollState(webContents);
        if (before === undefined) fail(`${entry.id}: Deployment scroll owner or target heading detached`);
        if (before.scrollHeight <= before.clientHeight) return;
        const multiplier = attempt % 2 === 0 ? 1 : entry.deviceScaleFactor;
        const x = Math.round(before.x * multiplier);
        const y = Math.round(before.y * multiplier);
        const deltaY = workingDeltaY ?? (Math.floor(attempt / 2) % 2 === 0 ? -360 : 360);
        webContents.sendInputEvent({ type: "mouseMove", x, y });
        webContents.sendInputEvent({
            type: "mouseWheel",
            x,
            y,
            deltaY,
            canScroll: true,
        });

        const effectDeadline = Math.min(deadline, now() + settleTimeoutMs);
        while (now() < effectDeadline) {
            await sleep(25);
            const after = await readDeploymentScrollState(webContents);
            if (after === undefined) fail(`${entry.id}: Deployment scroll owner or target heading detached`);
            if (after.scrollTop !== before.scrollTop) {
                movementObserved = true;
                workingDeltaY ??= deltaY;
            }
            if (movementObserved && after.reached) return;
        }
        attempt += 1;
    }
    fail(
        `${entry.id}: real mouse-wheel input did not reach the target-status section ` +
            `after ${String(attempt)} live-geometry attempts`,
    );
}

async function readTransientSidebarProbe(webContents) {
    return webContents.executeJavaScript(
        `(() => {
            const rect = (element) => {
                if (!(element instanceof HTMLElement)) return undefined;
                const value = element.getBoundingClientRect();
                return { x: value.x, y: value.y, width: value.width, height: value.height };
            };
            const sidebar = document.querySelector(".settings-sidebar");
            const edge = document.querySelector("[data-oaam-transient-sidebar-edge]");
            const workbench = document.querySelector(".settings-workbench");
            const firstCategory = document.querySelector(".settings-category-button");
            const toggle = document.getElementById("oaam-workbench-sidebar-toggle");
            return {
                sidebarCount: document.querySelectorAll(".settings-sidebar").length,
                sidebarHidden: sidebar instanceof HTMLElement ? sidebar.hidden : undefined,
                sidebarMode: sidebar instanceof HTMLElement ? sidebar.dataset.oaamSidebarMode : undefined,
                phase: sidebar instanceof HTMLElement ? sidebar.dataset.oaamTransientPhase : undefined,
                sidebarRect: rect(sidebar),
                edgeRect: rect(edge),
                workbenchRect: rect(workbench),
                firstCategoryRect: rect(firstCategory),
                firstCategorySelected:
                    firstCategory instanceof HTMLButtonElement ? firstCategory.getAttribute("aria-current") : undefined,
                activeElementId: document.activeElement instanceof HTMLElement ? document.activeElement.id : undefined,
                reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
                animationDuration: sidebar instanceof HTMLElement ? getComputedStyle(sidebar).animationDuration : undefined,
                transitionDuration: sidebar instanceof HTMLElement ? getComputedStyle(sidebar).transitionDuration : undefined,
                toggleAvailable: toggle instanceof HTMLButtonElement,
                inputEvents: Array.isArray(window.__oaamActualRenderPointerEvents)
                    ? window.__oaamActualRenderPointerEvents.slice(-8)
                    : [],
            };
        })()`,
        true,
    );
}

async function installBoundedPointerEventRecorder(webContents) {
    await webContents.executeJavaScript(
        `(() => {
            if (Array.isArray(window.__oaamActualRenderPointerEvents)) return;
            const events = [];
            window.__oaamActualRenderPointerEvents = events;
            for (const type of ["pointerdown", "click"]) {
                document.addEventListener(type, (event) => {
                    const target = event.target;
                    events.push({
                        type,
                        x: event.clientX,
                        y: event.clientY,
                        tag: target instanceof Element ? target.tagName : "",
                        className: target instanceof Element ? target.className : "",
                        settingsCategory:
                            target instanceof Element
                                ? target.closest("[data-oaam-settings-category]")?.getAttribute("data-oaam-settings-category") ?? ""
                                : "",
                    });
                    if (events.length > 8) events.shift();
                }, true);
            }
        })()`,
        true,
    );
}

export async function waitForTransientSidebarState(webContents, predicate, options = {}) {
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    const timeoutMs = options.timeoutMs ?? 5000;
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
        const probe = await readTransientSidebarProbe(webContents);
        if (predicate(probe)) return probe;
        await sleep(25);
    }
    return undefined;
}

export async function waitForStableTransientSidebarGeometry(webContents, options = {}) {
    const stableSampleCount = options.stableSampleCount ?? 2;
    let previous;
    let stableSamples = 0;
    return waitForTransientSidebarState(
        webContents,
        (probe) => {
            if (probe.phase !== "open" || probe.sidebarRect === undefined || probe.firstCategoryRect === undefined) {
                previous = undefined;
                stableSamples = 0;
                return false;
            }
            stableSamples =
                previous !== undefined &&
                sameRect(previous.sidebarRect, probe.sidebarRect) &&
                sameRect(previous.firstCategoryRect, probe.firstCategoryRect)
                    ? stableSamples + 1
                    : 1;
            previous = probe;
            return stableSamples >= stableSampleCount;
        },
        options,
    );
}

async function waitForTransientState(webContents, label, predicate, timeoutMs = 5000, context) {
    let lastProbe;
    const probe = await waitForTransientSidebarState(
        webContents,
        (candidate) => {
            lastProbe = candidate;
            return predicate(candidate);
        },
        { timeoutMs },
    );
    if (probe !== undefined) return probe;
    fail(`timed out waiting for ${label}: ${JSON.stringify({ context, lastProbe })}`);
}

function sendPointerMove(webContents, point, multiplier = 1) {
    webContents.sendInputEvent({
        type: "mouseMove",
        x: Math.round(point.x * multiplier),
        y: Math.round(point.y * multiplier),
    });
}

function clickAt(webContents, point, multiplier) {
    const x = Math.round(point.x * multiplier);
    const y = Math.round(point.y * multiplier);
    webContents.sendInputEvent({ type: "mouseMove", x, y });
    webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
}

function centerOf(rect) {
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function sameRect(left, right) {
    return (
        Math.abs(left.x - right.x) <= 1 &&
        Math.abs(left.y - right.y) <= 1 &&
        Math.abs(left.width - right.width) <= 1 &&
        Math.abs(left.height - right.height) <= 1
    );
}

export async function proveTransientSidebar(webContents, entry) {
    await focusRendererForRealInput(webContents);
    await installBoundedPointerEventRecorder(webContents);
    trace(`${entry.id} transient:persistent`);
    const persistent = await readTransientSidebarProbe(webContents);
    if (persistent.sidebarCount !== 1 || persistent.sidebarMode !== "persistent" || persistent.edgeRect !== undefined) {
        fail(`${entry.id}: persistent Settings sidebar does not have one exclusive content owner`);
    }
    await webContents.executeJavaScript("document.getElementById('oaam-workbench-sidebar-toggle')?.click()", true);
    const closed = await waitForTransientState(
        webContents,
        `${entry.id} closed transient sidebar`,
        (probe) => probe.sidebarHidden === true && probe.sidebarMode === "transient" && probe.edgeRect !== undefined,
    );
    trace(`${entry.id} transient:closed`);
    if (closed.workbenchRect === undefined || closed.edgeRect === undefined) {
        fail(`${entry.id}: transient sidebar geometry is incomplete`);
    }
    const workbenchBefore = closed.workbenchRect;
    const edgePoint = centerOf(closed.edgeRect);
    const revealResetPoint = {
        x: workbenchBefore.x + Math.max(40, workbenchBefore.width - 40),
        y: workbenchBefore.y + Math.min(100, workbenchBefore.height / 2),
    };
    const coordinateMultiplier = entry.deviceScaleFactor;
    let openedByRealInput;
    for (let attempt = 0; attempt < 4; attempt += 1) {
        sendPointerMove(webContents, revealResetPoint, coordinateMultiplier);
        await new Promise((resolve) => setTimeout(resolve, 25));
        sendPointerMove(webContents, edgePoint, coordinateMultiplier);
        openedByRealInput = await waitForTransientSidebarState(webContents, (probe) => probe.phase === "open", {
            timeoutMs: 500,
        });
        if (openedByRealInput !== undefined) break;
    }
    if (openedByRealInput === undefined) fail(`${entry.id}: real pointer input did not reveal the edge sidebar`);

    await waitForTransientState(
        webContents,
        `${entry.id} open transient sidebar`,
        (probe) => probe.phase === "open" && probe.sidebarHidden === false,
        5000,
        { openedByRealInput },
    );
    const opened = await waitForStableTransientSidebarGeometry(webContents, { timeoutMs: 2_000 });
    if (opened === undefined) fail(`${entry.id}: open transient sidebar geometry did not stabilize`);
    trace(`${entry.id} transient:opened`);
    if (opened.sidebarRect === undefined || opened.workbenchRect === undefined || opened.firstCategoryRect === undefined) {
        fail(`${entry.id}: open transient sidebar geometry is incomplete`);
    }
    if (!sameRect(workbenchBefore, opened.workbenchRect)) {
        fail(`${entry.id}: transient sidebar reflowed the Settings workbench`);
    }
    if (opened.sidebarCount !== 1) fail(`${entry.id}: transient sidebar duplicated route-owned Settings content`);
    if (opened.reducedMotion !== entry.reducedMotion) {
        fail(`${entry.id}: reduced-motion media state does not match the rendered case`);
    }
    if (
        entry.reducedMotion &&
        (opened.animationDuration !== "0s" || opened.transitionDuration?.split(",").some((duration) => duration.trim() !== "0s"))
    ) {
        fail(`${entry.id}: reduced motion still animates the transient sidebar`);
    }

    let interactionMultiplier;
    const interactionAttempts = [];
    for (const multiplier of [coordinateMultiplier]) {
        sendPointerMove(webContents, revealResetPoint, coordinateMultiplier);
        await new Promise((resolve) => setTimeout(resolve, 25));
        sendPointerMove(webContents, edgePoint, coordinateMultiplier);
        const current = await waitForStableTransientSidebarGeometry(webContents, { timeoutMs: 2_000 });
        if (current === undefined) continue;
        clickAt(webContents, centerOf(current.firstCategoryRect), multiplier);
        await new Promise((resolve) => setTimeout(resolve, 100));
        const probe = await readTransientSidebarProbe(webContents);
        interactionAttempts.push({
            multiplier,
            phase: probe.phase,
            firstCategoryRect: current.firstCategoryRect,
            firstCategorySelected: probe.firstCategorySelected,
            activeElementId: probe.activeElementId,
            inputEvents: probe.inputEvents,
        });
        if (probe.firstCategorySelected === "page") {
            interactionMultiplier = multiplier;
            break;
        }
    }
    if (interactionMultiplier === undefined) {
        fail(`${entry.id}: real pointer input did not activate a sidebar control ${JSON.stringify(interactionAttempts)}`);
    }
    trace(`${entry.id} transient:interactive`);

    const outsidePoint = {
        x: workbenchBefore.x + Math.max(40, workbenchBefore.width - 40),
        y: workbenchBefore.y + Math.min(100, workbenchBefore.height / 2),
    };
    sendPointerMove(webContents, outsidePoint, coordinateMultiplier);
    await new Promise((resolve) => setTimeout(resolve, 280));
    const focusRetained = await readTransientSidebarProbe(webContents);
    if (focusRetained.phase !== "open") fail(`${entry.id}: pointer leave destroyed focused sidebar controls`);

    webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    const escaped = await waitForTransientState(
        webContents,
        `${entry.id} Escape dismissal`,
        (probe) => probe.phase === "closed" && probe.sidebarHidden === true,
    );
    trace(`${entry.id} transient:escaped`);
    if (escaped.activeElementId !== "oaam-workbench-sidebar-toggle") {
        fail(`${entry.id}: Escape did not restore focus to the persistent sidebar toggle`);
    }

    sendPointerMove(webContents, edgePoint, coordinateMultiplier);
    await waitForTransientState(webContents, `${entry.id} rapid reopen`, (probe) => probe.phase === "open");
    sendPointerMove(webContents, outsidePoint, coordinateMultiplier);
    await waitForTransientState(webContents, `${entry.id} rapid dismissal`, (probe) => probe.phase === "closing");
    await new Promise((resolve) => setTimeout(resolve, 40));
    for (let attempt = 0; attempt < 4; attempt += 1) {
        sendPointerMove(webContents, edgePoint, coordinateMultiplier);
        await new Promise((resolve) => setTimeout(resolve, 30));
        const probe = await readTransientSidebarProbe(webContents);
        if (probe.phase === "open") break;
    }
    await waitForTransientState(webContents, `${entry.id} rapid re-entry cancellation`, (probe) => probe.phase === "open", 1000);
    sendPointerMove(webContents, outsidePoint, coordinateMultiplier);
    await waitForTransientState(
        webContents,
        `${entry.id} final transient dismissal`,
        (probe) => probe.phase === "closed" && probe.sidebarHidden === true,
    );
    trace(`${entry.id} transient:closed-final`);
    const finalProbe = await readTransientSidebarProbe(webContents);
    if (finalProbe.workbenchRect === undefined || !sameRect(workbenchBefore, finalProbe.workbenchRect)) {
        fail(`${entry.id}: transient lifecycle changed the main workbench geometry`);
    }
}
