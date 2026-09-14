export function formatActualRenderOperationMessage(templates, messageId, values = {}) {
    const template = templates[messageId];
    if (typeof template !== "string") throw new Error(`actual-render operation message ${messageId} is unavailable`);
    let result = template;
    for (const [key, value] of Object.entries(values)) result = result.replaceAll(`{${key}}`, String(value));
    return result;
}

export function assertActualRenderOperationLayout(root, label, caseId) {
    if (!(root instanceof HTMLElement)) throw new Error(`${caseId}: ${label} is not an HTML element`);
    const documentElement = root.ownerDocument.documentElement;
    const viewportWidth = root.ownerDocument.defaultView?.innerWidth ?? 0;
    const rootRect = root.getBoundingClientRect();
    if (rootRect.width <= 0 || rootRect.height <= 0) throw new Error(`${caseId}: ${label} has no rendered geometry`);
    if (rootRect.left < -1 || rootRect.right > viewportWidth + 1) {
        throw new Error(
            `${caseId}: ${label} escapes the horizontal viewport: left=${String(rootRect.left)} right=${String(rootRect.right)}`,
        );
    }
    if (documentElement.scrollWidth > viewportWidth + 2) {
        throw new Error(
            `${caseId}: ${label} creates document-level horizontal overflow ` +
                `${String(documentElement.scrollWidth)} > ${String(viewportWidth)}`,
        );
    }

    const criticalSelectors = [
        "[role='alert']",
        "[role='status']",
        ".asset-action-form",
        ".asset-diff-result",
        ".diagnostics-support-review",
        ".inspection-summary",
        ".project-lifecycle-review",
        ".render-analysis",
        ".state-resilience-progress",
        ".state-resilience-review",
    ].join(",");
    for (const element of root.querySelectorAll(criticalSelectors)) {
        if (!(element instanceof HTMLElement)) continue;
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (rect.left < -1 || rect.right > viewportWidth + 1) {
            throw new Error(
                `${caseId}: ${label} contains horizontally clipped ${element.className || element.getAttribute("role") || "state"}`,
            );
        }
    }
}

export function operationRendererArguments() {
    return `${formatActualRenderOperationMessage.toString()}, ${assertActualRenderOperationLayout.toString()}`;
}
