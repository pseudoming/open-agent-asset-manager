export async function inspectJourneyProjectRegistration({
    projectCard,
    projectSourcePath,
    route,
    waitFor,
    click,
    assert,
    assertOrdinaryLanguage,
    observedDialogs,
}) {
    const registerProject = projectCard.querySelector("[data-oaam-project-decision='add']");
    click(registerProject);
    const registrationDialog = await waitFor(
        () => document.querySelector("[data-oaam-dialog='discovery_project_registration']"),
        `${route} Project registration dialog`,
    );
    assert(registrationDialog instanceof HTMLElement, "Project registration dialog has the wrong type");
    assert(registrationDialog.getAttribute("aria-modal") === "true", "Project registration dialog is not modal");
    const registrationBounds = registrationDialog.getBoundingClientRect();
    assert(
        registrationBounds.left >= 0 &&
            registrationBounds.top >= 0 &&
            registrationBounds.right <= window.innerWidth &&
            registrationBounds.bottom <= window.innerHeight,
        "Project registration dialog escapes the viewport",
    );
    assert(
        registrationDialog.querySelector("code")?.textContent?.trim() === projectSourcePath,
        "Project registration dialog changed the exact observed path",
    );
    assertOrdinaryLanguage(registrationDialog, `${route} Project registration dialog`);
    observedDialogs.push("discovery_project_registration");
    const revealCountBefore = Number.parseInt(document.documentElement.dataset.oaamObservedProjectRevealCount ?? "0", 10);
    click(registrationDialog.querySelector("[data-oaam-project-registration-action='reveal']"));
    await waitFor(
        () =>
            Number.parseInt(document.documentElement.dataset.oaamObservedProjectRevealCount ?? "0", 10) === revealCountBefore + 1,
        `${route} Project folder reveal`,
    );
    assert(
        document.querySelector("[data-oaam-dialog='discovery_project_registration']") === registrationDialog,
        "revealing the Project folder closed its registration dialog",
    );
    registrationDialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await waitFor(
        () => document.querySelector("[data-oaam-dialog='discovery_project_registration']") === null,
        `${route} closed Project registration dialog`,
    );
    const ignoreProject = projectCard.querySelector('[data-oaam-source-action="ignore"]');
    click(ignoreProject);
    const projectIgnoreConfirmation = await waitFor(
        () => projectCard.querySelector('[data-oaam-source-ignore-confirmation="true"]'),
        `${route} Project source ignore confirmation`,
    );
    click(projectIgnoreConfirmation.querySelector('[data-oaam-source-action="confirm-ignore"]'));
    await waitFor(() => projectCard.getAttribute("data-oaam-source-state") === "ignored", `${route} ignored Project source`);
}
