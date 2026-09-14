export async function inspectPreviewFileInspector({ workspace, graph, assert, click, waitFor }) {
    const firstFile = graph.querySelector('[data-oaam-preview-entry-kind="file"]');
    const trigger = firstFile?.querySelector("[data-oaam-preview-review-path]");
    assert(firstFile instanceof HTMLElement && trigger instanceof HTMLButtonElement, "preview file review entry is missing");
    assert(firstFile.querySelectorAll("[data-oaam-preview-review-path]").length === 1, "file review has duplicate entries");
    assert(
        firstFile.querySelector("details[data-oaam-preview-text-kind]") === null,
        "file review retains the old inline text cards",
    );
    click(trigger, "open preview file review");
    const inspector = await waitFor(() => workspace.querySelector(".catalog-deployment-file-inspector"), "file review inspector");
    assert(inspector.classList.contains("workbench-file-inspector"), "deployment does not reuse the shared file inspector");
    const page = workspace.closest(".deployment-page");
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    assert(page?.dataset.fileInspectorOpen === "true", "file inspector did not reserve its main-page space");
    const bounds = inspector.getBoundingClientRect();
    assert(
        bounds.width > 0 && bounds.height > 0 && bounds.left >= -1 && bounds.right <= innerWidth + 1,
        "file inspector escapes its horizontal viewport",
    );
    if (getComputedStyle(inspector).position === "fixed") {
        assert(
            workspace.getBoundingClientRect().right <= bounds.left + 1,
            "file inspector covers the main review or apply actions",
        );
    }
    const listToggle = inspector.querySelector(
        '[data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_file_inspector.005"]',
    );
    assert(listToggle instanceof HTMLButtonElement, "file-list toggle is missing");
    if (listToggle.getAttribute("aria-pressed") !== "true") click(listToggle, "show file list");
    const list = await waitFor(() => inspector.querySelector(".import-preview-file-list"), "preview file list");
    const content = inspector.querySelector(".catalog-file-review-content");
    assert(
        list.querySelectorAll("button").length === graph.querySelectorAll("[data-oaam-preview-entry-kind]").length,
        "file inspector omitted an exact file or directory",
    );
    if (innerWidth > 640)
        assert(
            list.getBoundingClientRect().left >= content.getBoundingClientRect().right - 1,
            "file list does not occupy the right side of the inspector",
        );
    click(listToggle, "hide file list");
    await waitFor(() => inspector.querySelector(".import-preview-file-list") === null, "hidden file list");
    let tabCount = 1;
    for (const side of ["current", "desired"]) {
        const action = inspector.querySelector(`[data-oaam-preview-open-snapshot="${side}"]`);
        const present = firstFile.getAttribute(`data-oaam-preview-${side}-state`) === "present";
        assert(action instanceof HTMLButtonElement === present, "snapshot tab entry disagrees with file presence");
        if (!present) continue;
        click(action, `open ${side} snapshot tab`);
        tabCount += 1;
        await waitFor(() => inspector.querySelectorAll('[role="tab"]').length === tabCount, `${side} internal file tab`);
        assert(
            inspector.querySelector("[data-oaam-preview-text-kind]") !== null ||
                inspector.querySelector(".workbench-notice") !== null,
            "snapshot tab has neither text nor a binary disposition",
        );
    }
    click(inspector.querySelector('[role="tab"]'), "return to file changes");
    await waitFor(
        () =>
            inspector.querySelector('[role="tab"][aria-selected="true"]')?.textContent ===
            inspector.querySelector('[role="tab"]')?.textContent,
        "active file review tab",
    );
    click(
        inspector.querySelector(
            '[data-oaam-interaction-entry="features.catalog-deployment.catalog_deployment_file_inspector.006"]',
        ),
        "close file review inspector",
    );
    await waitFor(() => workspace.querySelector(".catalog-deployment-file-inspector") === null, "closed file review inspector");
    assert(page?.dataset.fileInspectorOpen === undefined, "closed file review retained the reserved sidebar space");
    assert(document.activeElement === trigger, "closing file review lost its invoking action");
}
