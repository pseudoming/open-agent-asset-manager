function fail(entry, message) {
    throw new Error(`${entry.id}: ${message}`);
}

async function rehearsalMetadata(webContents, entry) {
    const metadata = await webContents.executeJavaScript(
        `(() => globalThis.__oaamProjectGuidanceApplyRehearsal?.metadata ?? null)()`,
        true,
    );
    if (metadata === null || typeof metadata !== "object") fail(entry, "Project Guidance rehearsal bridge is missing");
    return metadata;
}

async function executeStage(webContents, entry, stage, input = {}) {
    const request = {
        stage,
        terminalDeadlineAtMillisecondsSinceEpoch: Date.now() + (entry.expectedTerminalStage === stage ? 1_000 : 6_000),
        ...input,
    };
    const source = await webContents.executeJavaScript(
        `(() => globalThis.__oaamProjectGuidanceApplyRehearsal?.build(${JSON.stringify(request)}) ?? null)()`,
        true,
    );
    if (typeof source !== "string" || source.length === 0) fail(entry, `${stage} production proof script is missing`);
    const receipt = await webContents.executeJavaScript(source, true);
    const failureBoundary = await webContents.executeJavaScript(
        `document.querySelector('[data-oaam-renderer-failure]')?.getAttribute('data-oaam-renderer-failure-kind') ?? null`,
        true,
    );
    if (failureBoundary !== null) fail(entry, `${stage} proof entered the Renderer error boundary: ${failureBoundary}`);
    return receipt;
}

function requireComplete(entry, receipt, stage) {
    if (receipt?.status !== "complete") {
        fail(entry, `${stage} did not return a complete structured receipt: ${JSON.stringify(receipt).slice(0, 1_200)}`);
    }
    return receipt;
}

function requireTerminal(entry, receipt, stage) {
    if (
        receipt?.status !== "terminal" ||
        receipt.stage !== stage ||
        receipt.code !== "proof_assertion_failed" ||
        receipt.lastObservation === null ||
        typeof receipt.lastObservation !== "object"
    ) {
        fail(entry, `${stage} did not return its structured fail-closed terminal receipt`);
    }
    if (entry.variant === "deploy_stale" && receipt.lastObservation.stale !== "true") {
        fail(entry, "stale deploy terminal did not retain the stale machine state");
    }
    if (entry.variant === "deploy_recovery" && receipt.lastObservation.reconciliation === "none") {
        fail(entry, "uncertain deploy terminal did not retain the reconciliation state");
    }
}

async function renderedResult(webContents, journeyState) {
    return webContents.executeJavaScript(
        `(() => ({
            innerWidth,
            innerHeight,
            resolvedTheme: document.documentElement.dataset.oaamTheme,
            resolvedLocale: document.documentElement.lang,
            dialogInventory: JSON.parse(document.documentElement.dataset.oaamDialogInventory ?? "[]"),
            dialogStates: [],
            journeyStates: [${JSON.stringify(journeyState)}],
            routeStates: ["library:ready", "deployment:ready"],
            surfaceInventory: JSON.parse(document.documentElement.dataset.oaamSurfaceInventory ?? "[]")
        }))()`,
        true,
    );
}

async function requireFreshAppliedRelationship(webContents, entry, targetKey) {
    const result = await webContents.executeJavaScript(
        `(async () => {
            const deadline = Date.now() + 6_000;
            while (Date.now() < deadline) {
                const panel = document.querySelector('.asset-usage-relationships');
                if (panel?.getAttribute('data-oaam-asset-usage-state') === 'failed') throw new Error('post-apply relationship refresh failed');
                const row = panel?.querySelector('.asset-usage-row[data-oaam-agent-runtime-id="CLAUDE_CODE_CLI"]');
                if (panel?.getAttribute('data-oaam-asset-usage-state') === 'ready' &&
                    row?.getAttribute('data-oaam-target-key') === ${JSON.stringify(targetKey)} &&
                    row.getAttribute('data-oaam-asset-usage-analysis') === 'complete' &&
                    row.getAttribute('data-oaam-asset-usage-target-state') === 'already_usable' &&
                    row.getAttribute('data-oaam-asset-usage-managed') === 'applied') {
                    if ([...document.querySelectorAll('.deployment-create-target-summary, .deployment-create-review')].some(review => review.getClientRects().length > 0)) throw new Error('settled relationship still duplicates the visible pre-apply review');
                    return true;
                }
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            return false;
        })()`,
        true,
    );
    if (result !== true) fail(entry, "post-apply relationship did not settle from its fresh exact-target read");
}

export async function inspectProjectGuidanceApplyRehearsalCase(webContents, entry) {
    const metadata = await rehearsalMetadata(webContents, entry);
    const relationship = await executeStage(webContents, entry, "relationship");
    if (entry.expectedTerminalStage === "relationship") {
        requireTerminal(entry, relationship, "relationship");
        return renderedResult(webContents, "deployment_and_reverse:project_guidance_apply_rehearsal");
    }
    requireComplete(entry, relationship, "relationship");
    if (entry.variant === "target_key_mismatch") {
        if (relationship.targetKey === metadata.expectedTargetKey) {
            fail(entry, "target-key mismatch fixture did not change the exact target identity");
        }
        return renderedResult(webContents, "deployment_and_reverse:project_guidance_apply_rehearsal");
    }
    if (relationship.targetKey !== metadata.expectedTargetKey) fail(entry, "relationship returned the wrong targetKey");
    const relationshipVisual = requireComplete(
        entry,
        await executeStage(webContents, entry, "visual_relationship", { targetKey: relationship.targetKey }),
        "visual_relationship",
    );
    if (relationshipVisual.visualStage !== "relationship") fail(entry, "relationship visual stage identity changed");

    const createReview = requireComplete(
        entry,
        await executeStage(webContents, entry, "create_review", { targetKey: relationship.targetKey }),
        "create_review",
    );
    const identity = { targetKey: relationship.targetKey, deploymentId: createReview.deploymentId };
    const authorizationVisual = requireComplete(
        entry,
        await executeStage(webContents, entry, "visual_authorization", identity),
        "visual_authorization",
    );
    if (authorizationVisual.visualStage !== "authorization") {
        fail(entry, "authorization visual stage identity changed");
    }
    const authorization = await executeStage(webContents, entry, "authorize", identity);
    if (entry.expectedTerminalStage === "authorize") {
        requireTerminal(entry, authorization, "authorize");
        return renderedResult(webContents, "deployment_and_reverse:project_guidance_apply_rehearsal");
    }
    requireComplete(entry, authorization, "authorize");
    if (JSON.stringify(authorization.semanticSelections) !== JSON.stringify(metadata.semanticClosure)) {
        fail(entry, "authorized review did not expose the exact production semantic closure");
    }

    const preview = await executeStage(webContents, entry, "preview", {
        ...identity,
        semanticSelections: authorization.semanticSelections,
    });
    if (entry.expectedTerminalStage === "preview") {
        requireTerminal(entry, preview, "preview");
        return renderedResult(webContents, "deployment_and_reverse:project_guidance_apply_rehearsal");
    }
    requireComplete(entry, preview, "preview");
    if (JSON.stringify(preview.semanticSelections) !== JSON.stringify(metadata.semanticClosure)) {
        fail(entry, "preview did not retain all production semantic selections");
    }
    const previewVisual = requireComplete(
        entry,
        await executeStage(webContents, entry, "visual_preview", {
            ...identity,
            desiredSha256: preview.desiredSha256,
            semanticSelections: preview.semanticSelections,
        }),
        "visual_preview",
    );
    if (previewVisual.visualStage !== "preview") fail(entry, "preview visual stage identity changed");
    if (entry.provePreviewScroll === true) await provePreviewScrollBoundary(webContents, entry);

    const applied = await executeStage(webContents, entry, "apply", {
        ...identity,
        desiredSha256: preview.desiredSha256,
        semanticSelections: preview.semanticSelections,
    });
    if (entry.expectedTerminalStage === "apply") {
        requireTerminal(entry, applied, "apply");
        return renderedResult(webContents, "deployment_and_reverse:project_guidance_apply_rehearsal");
    }
    requireComplete(entry, applied, "apply");
    if (JSON.stringify(applied.semanticSelections) !== JSON.stringify(metadata.semanticClosure)) {
        fail(entry, "applied state did not retain all production semantic selections");
    }
    if (applied.applicationState !== "applied" || applied.versionState !== "current") {
        fail(entry, "happy rehearsal did not finish applied and current");
    }
    await requireFreshAppliedRelationship(webContents, entry, relationship.targetKey);
    const appliedVisual = requireComplete(
        entry,
        await executeStage(webContents, entry, "visual_applied", {
            ...identity,
            desiredSha256: preview.desiredSha256,
            semanticSelections: applied.semanticSelections,
        }),
        "visual_applied",
    );
    if (appliedVisual.visualStage !== "applied") fail(entry, "applied visual stage identity changed");
    const counts = await webContents.executeJavaScript(
        `(() => ({
            probe: Number(document.documentElement.dataset.oaamProjectGuidanceProbeCount ?? "0"),
            usage: Number(document.documentElement.dataset.oaamProjectGuidanceAssetUsageCount ?? "0"),
            create: Number(document.documentElement.dataset.oaamProjectGuidanceCreateCount ?? "0"),
            grantCreate: Number(document.documentElement.dataset.oaamProjectGuidanceGrantCreateCount ?? "0"),
            analyze: Number(document.documentElement.dataset.oaamProjectGuidanceAnalyzeCount ?? "0"),
            preview: Number(document.documentElement.dataset.oaamProjectGuidancePreviewCount ?? "0"),
            deploy: Number(document.documentElement.dataset.oaamProjectGuidanceDeployCount ?? "0"),
            deployTerminal: Number(document.documentElement.dataset.oaamProjectGuidanceDeployTerminalCount ?? "0")
        }))()`,
        true,
    );
    if (
        JSON.stringify(counts) !==
        // Initial observation, saved intent, and completed Apply each own one exact-target read.
        JSON.stringify({ probe: 1, usage: 3, create: 1, grantCreate: 1, analyze: 2, preview: 1, deploy: 1, deployTerminal: 1 })
    ) {
        fail(entry, `happy rehearsal operation counts are ${JSON.stringify(counts)}`);
    }
    return renderedResult(webContents, "deployment_and_reverse:project_guidance_apply_rehearsal");
}

async function provePreviewScrollBoundary(webContents, entry) {
    const before = await webContents.executeJavaScript(
        `(${function prepare() {
            const outer = document.querySelector(".deployment-workbench");
            const inner = document.querySelector(".deployment-page");
            const target = document.querySelector(".catalog-preview-decision");
            const summaries = [
                ...document.querySelectorAll('.workbench-disclosure[data-oaam-technical-detail="true"] > summary'),
            ];
            if (
                !(outer instanceof HTMLElement) ||
                !(inner instanceof HTMLElement) ||
                !(target instanceof HTMLElement) ||
                summaries.length === 0
            )
                throw new Error("preview scroll owners or technical labels missing");
            const styles = summaries.map((node) => node.style.position);
            let oldOverflow = 0;
            let oldDisplacement = 0;
            try {
                // Reproduce the diagnosed former containing block, without changing the product stylesheet.
                summaries.forEach((node) => {
                    node.style.position = "static";
                });
                outer.scrollTop = 0;
                inner.scrollTop = 0;
                oldOverflow = outer.scrollHeight - outer.clientHeight;
                target.scrollIntoView({ block: "center", inline: "nearest" });
                oldDisplacement = outer.scrollTop;
            } finally {
                summaries.forEach((node, index) => {
                    node.style.position = styles[index];
                });
                outer.scrollTop = 0;
                inner.scrollTop = 0;
            }
            target.scrollIntoView({ block: "center", inline: "nearest" });
            const box = inner.getBoundingClientRect();
            const x = Math.round(box.right - 40),
                y = Math.round(box.bottom - 60);
            document.documentElement.dataset.oaamPreviewWheelTrusted = "false";
            document.addEventListener(
                "wheel",
                (event) => {
                    document.documentElement.dataset.oaamPreviewWheelTrusted = String(
                        event.isTrusted && inner.contains(event.target),
                    );
                },
                { capture: true, once: true },
            );
            return {
                oldOverflow,
                oldDisplacement,
                outerTop: outer.scrollTop,
                outerOverflow: outer.scrollHeight - outer.clientHeight,
                bottom: box.bottom,
                viewport: innerHeight,
                innerTop: inner.scrollTop,
                innerMaximum: inner.scrollHeight - inner.clientHeight,
                hitInside: inner.contains(document.elementFromPoint(x, y)),
                x,
                y,
            };
        }.toString()})()`,
        true,
    );
    if (before.oldOverflow <= 1 || before.oldDisplacement <= 1)
        fail(entry, "negative control did not reproduce escaped technical-label overflow");
    if (before.outerTop !== 0 || before.outerOverflow > 1 || Math.abs(before.bottom - before.viewport) > 1 || !before.hitInside)
        fail(entry, `centered preview displaced its full-height scrollport: ${JSON.stringify(before)}`);
    if (before.innerMaximum <= 1) fail(entry, "preview fixture has no scrollable content for a real wheel check");
    webContents.focus();
    webContents.sendInputEvent({ type: "mouseMove", x: before.x, y: before.y });
    webContents.sendInputEvent({
        type: "mouseWheel",
        x: before.x,
        y: before.y,
        deltaY: before.innerTop > 1 ? 320 : -320,
        canScroll: true,
    });
    const after = await webContents.executeJavaScript(
        `(async () => {
        const inner = document.querySelector('.deployment-page');
        const deadline = performance.now() + 1500;
        while (performance.now() < deadline && Math.abs(inner.scrollTop - ${JSON.stringify(before.innerTop)}) <= 1)
            await new Promise(resolve => setTimeout(resolve, 25));
        const wheelTop = inner.scrollTop;
        const summaries = [...document.querySelectorAll('.workbench-disclosure[data-oaam-technical-detail="true"] > summary')];
        summaries.at(-1).focus();
        return {wheelTop, innerTop: inner.scrollTop, outerTop: document.querySelector('.deployment-workbench').scrollTop,
            trusted: document.documentElement.dataset.oaamPreviewWheelTrusted === 'true', focused: document.activeElement === summaries.at(-1)};
    })()`,
        true,
    );
    if (!after.trusted || !after.focused || Math.abs(after.wheelTop - before.innerTop) <= 1 || after.outerTop !== 0)
        fail(entry, `real wheel/focus did not remain inside the preview scroll owner: ${JSON.stringify({ before, after })}`);
    webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
    webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
    if ((await webContents.executeJavaScript("document.querySelector('.deployment-workbench').scrollTop", true)) !== 0)
        fail(entry, "Tab displaced the preview's outer workbench");
}
