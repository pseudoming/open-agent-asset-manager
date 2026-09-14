import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    PACKAGED_PROJECT_RESTORE_DIRECTORY,
    PACKAGED_PROJECT_RESTORE_SUBJECT_FILE_NAME,
    PACKAGED_PROJECT_STOP_DIRECTORY,
    PACKAGED_PROJECT_STOP_SUBJECT_FILE_NAME,
    packagedRetainedProjectProofMode,
    packagedRetainedProjectProofText,
    proveWindowsPackagedProjectStopStage,
    proveWindowsPackagedRetainedProjectStage,
    readPackagedProjectStopSubject,
} from "../src/main/packaged-retained-project-recovery-ui-smoke";
import { retainedSettingsReadyScript } from "../src/main/packaged-retained-project-recovery-ui-script-support";

const TARGET = "11111111-1111-4111-8111-111111111111";
const SELECTED = "22222222-2222-4222-8222-222222222222";
const ROOT = "\\\\wsl.localhost\\Ubuntu\\home\\example\\oaam-stop-target";
const LOCK_ROOT = "transactions/authority-locks/projects";
const STRUCTURAL_COORDINATION = ["transactions", "transactions/authority-locks", LOCK_ROOT] as const;
const TARGET_LOCK = `${LOCK_ROOT}/${TARGET}.lock`;
const CATALOG_LOCK = `${LOCK_ROOT}/catalog.lock`;
const roots: string[] = [];

function snapshot(fingerprint: string, coordinationPaths: readonly string[] = []) {
    return {
        businessAuthorityEntryCount: 1,
        businessAuthorityTreeFingerprint: fingerprint.repeat(64),
        businessAuthorityManifest: [
            { relativePath: "oaam.sqlite", kind: "file" as const, size: 8, sha256: fingerprint.repeat(64) },
        ],
        observabilityEntryCount: 0,
        observabilityTreeFingerprint: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        observabilityManifest: [],
        desktopPreferencesFingerprint: "b".repeat(64),
        desktopPreferences: {
            schemaVersion: 4,
            onboardingCompleted: true,
            lastSelectedProjectId: SELECTED,
            assetLayout: "list" as const,
        },
        coordinationPaths,
    };
}

function png(): Buffer {
    const bytes = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    bytes.writeUInt32BE(1_280, 16);
    bytes.writeUInt32BE(720, 20);
    return bytes;
}

type TreeScenario = "delayed" | "missing" | "duplicate" | "wrong-id" | "wrong-name" | "wrong-root" | "failed";
type ChoiceScenario = "turn-off" | "already-false" | "invalid" | "duplicate" | "wrong-review" | "stuck";

function runStopDom(
    script: string,
    scenario: TreeScenario,
    choice: ChoiceScenario = "turn-off",
    onSwitch = () => {},
): Promise<unknown> {
    document.body.innerHTML = `<main data-oaam-route="library" data-oaam-subject="projects" data-oaam-state="ready"
        data-oaam-project-id="${SELECTED}"><div class="asset-library-tree-region"></div>
        <section class="library-state-panel" aria-busy="true"></section></main>`;
    const library = document.querySelector<HTMLElement>("main");
    if (library === null) throw new Error("Project library fixture is missing");
    if (scenario === "failed") {
        library.querySelector(".library-state-panel")?.setAttribute("aria-busy", "false");
        library.querySelector(".library-state-panel")?.setAttribute("data-oaam-tone", "danger");
        library.querySelector(".library-state-panel")?.setAttribute("role", "alert");
        if (library.querySelector(".library-state-panel") !== null)
            library.querySelector(".library-state-panel")!.textContent = "Project list failed";
    }
    let pollCount = 0;
    let rendered = false;
    const renderRows = (): void => {
        library.querySelector(".library-state-panel")?.remove();
        const id = scenario === "wrong-id" ? "33333333-3333-4333-8333-333333333333" : TARGET;
        const name = scenario === "wrong-name" ? "Wrong target" : "Stop target";
        const row = `<div><button class="asset-tree-project" data-oaam-project-id="${id}">
            <span class="asset-tree-project-label"><span>${name}</span></span></button>
            <button data-oaam-action="manage-project" data-oaam-project-id="${id}"></button></div>`;
        library.querySelector(".asset-library-tree-region")!.innerHTML =
            row +
            (scenario === "duplicate" ? row : "") +
            `<button class="asset-tree-project" data-oaam-project-id="${SELECTED}">
                <span class="asset-tree-project-label"><span>Selected control</span></span></button>`;
        library.querySelector<HTMLButtonElement>('[data-oaam-action="manage-project"]')?.addEventListener("click", () => {
            const dialog = document.createElement("div");
            dialog.dataset.oaamDialog = "project_lifecycle";
            dialog.innerHTML = `<dl class="project-lifecycle-subject"><dd>Stop target</dd><dd>${scenario === "wrong-root" ? `${ROOT}-wrong` : ROOT}</dd></dl>
                <button data-oaam-project-action="stop_managing"></button>`;
            dialog.querySelector("button")?.addEventListener("click", () => {
                const initial = choice === "already-false" ? "false" : choice === "invalid" ? "mixed" : "true";
                const switchMarkup = `<button data-oaam-interaction-entry="features.project-library.project_lifecycle_dialog.007"
                    role="switch" aria-checked="${initial}"></button>`;
                dialog.insertAdjacentHTML(
                    "beforeend",
                    (choice === "wrong-review" ? switchMarkup : "") +
                        `<div class="project-lifecycle-review" data-oaam-project-lifecycle-action="stop_managing">
                    <div class="project-lifecycle-backup-gate">${choice === "wrong-review" ? "" : switchMarkup}
                    ${choice === "duplicate" ? switchMarkup : ""}<div class="detail-actions"><button
                    data-oaam-interaction-entry="features.project-library.project_lifecycle_dialog.009"
                    class="library-secondary-button"></button></div></div></div>`,
                );
                dialog.querySelectorAll<HTMLButtonElement>('[role="switch"]').forEach((element) => {
                    element.addEventListener("click", () => {
                        onSwitch();
                        if (choice !== "stuck") element.setAttribute("aria-checked", "false");
                    });
                });
                dialog.querySelector<HTMLButtonElement>(".detail-actions button")?.addEventListener("click", () => {
                    library.querySelector(`[data-oaam-project-id="${TARGET}"]`)?.parentElement?.remove();
                    dialog.remove();
                });
            });
            document.body.append(dialog);
        });
    };
    return Promise.resolve(
        runInNewContext(script, {
            Date: { now: () => ++pollCount * 1_000 },
            document,
            HTMLButtonElement,
            HTMLElement,
            Promise,
            setTimeout: (callback: () => void) => {
                if (!rendered && !["missing", "failed"].includes(scenario)) {
                    rendered = true;
                    renderRows();
                }
                queueMicrotask(callback);
            },
        }) as unknown,
    );
}

async function proveChoice(choice: ChoiceScenario, onSwitch = () => {}) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-project-stop-choice-"));
    roots.push(profile);
    const subject = { projectId: TARGET, selectedProjectId: SELECTED, displayName: "Stop target", rootPath: ROOT };
    fs.writeFileSync(
        path.join(profile, PACKAGED_PROJECT_STOP_SUBJECT_FILE_NAME),
        JSON.stringify({ schemaVersion: 1, ...subject }),
    );
    let invocation = 0;
    const before = snapshot("a");
    const after = snapshot("c", ["transactions", "transactions/authority-locks", "transactions/authority-locks/projects"]);
    const proof = await proveWindowsPackagedProjectStopStage(
        {
            executeJavaScript: (script) =>
                invocation++ === 0
                    ? runStopDom(script, "delayed", choice, onSwitch)
                    : Promise.resolve({
                          status: "complete",
                          projectId: TARGET,
                          displayName: "Stop target",
                          rootPath: ROOT,
                          retainedHistoryCollapsed: true,
                          retainedHistoryAfterPrimaryContent: true,
                      }),
            capturePage: vi.fn(async () => ({ toPNG: png })),
        },
        profile,
        vi.fn().mockReturnValueOnce(before).mockReturnValueOnce(before).mockReturnValue(after),
        readPackagedProjectStopSubject(profile),
    );
    return { proof, profile, invocation };
}

afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("packaged Project stop-only proof", () => {
    it("stops an exact non-selected Project and records active and retained views", async () => {
        const result = await proveChoice("turn-off");
        expect(result.proof).toMatchObject({
            projectId: TARGET,
            selectedProjectId: SELECTED,
            nonSelectedTargetVerified: true,
            rememberChoiceSwitchClickCount: 1,
        });
        expect(result.invocation).toBe(2);
        expect(fs.existsSync(path.join(result.profile, PACKAGED_PROJECT_STOP_DIRECTORY, "manifest.json"))).toBe(true);
    });

    it("does not click an already-off remember-choice switch", async () => {
        const switchClick = vi.fn();
        await expect(proveChoice("already-false", switchClick)).resolves.toMatchObject({
            proof: {
                rememberChoiceSwitchClickCount: 0,
                rememberChoiceFalse: true,
            },
        });
        expect(switchClick).not.toHaveBeenCalled();
    });

    it.each([
        ["invalid", /invalid aria-checked/u, 0],
        ["duplicate", /remember-choice switch is ambiguous/u, 0],
        ["wrong-review", /remember-choice switch is ambiguous/u, 0],
        ["stuck", /timed out waiting for remember choice to turn off/u, 1],
    ] as const)("fails closed for the %s remember-choice terminal", async (choice, message, clicks) => {
        const switchClick = vi.fn();
        await expect(proveChoice(choice, switchClick)).rejects.toThrow(message);
        expect(switchClick).toHaveBeenCalledTimes(clicks);
    });

    it.each([
        ["missing", /timed out.*terminal=.*loading.*rowCount.*0/u],
        ["duplicate", /row is ambiguous/u],
        ["wrong-id", /row changed identity/u],
        ["wrong-name", /row changed identity/u],
        ["wrong-root", /dialog changed the registered Project identity/u],
        ["failed", /Project library failed: Project list failed/u],
    ] as const)("fails closed for the %s Project-tree terminal", async (scenario, message) => {
        const profile = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-project-stop-terminal-"));
        roots.push(profile);
        await expect(
            proveWindowsPackagedProjectStopStage(
                { executeJavaScript: (script) => runStopDom(script, scenario), capturePage: vi.fn() },
                profile,
                () => snapshot("a"),
                { projectId: TARGET, selectedProjectId: SELECTED, displayName: "Stop target", rootPath: ROOT },
            ),
        ).rejects.toThrow(message);
    });
});

type RestoreRenderScenario = "replace" | "wrong-selection" | "wrong-identity" | "duplicate" | "missing-target" | "missing-route";
type RestoreReturnScenario = "normal" | "missing" | "disabled" | "duplicate" | "wrong-route" | "stuck" | "hidden-old";

function installRestoreDom(
    options: {
        duplicate?: boolean;
        omit?: boolean;
        projectId?: string;
        changeSelection?: boolean;
        renderScenario?: RestoreRenderScenario;
        returnScenario?: RestoreReturnScenario;
    } = {},
) {
    const id = options.projectId ?? TARGET;
    const renderScenario = options.changeSelection ? "wrong-selection" : (options.renderScenario ?? "replace");
    const returnScenario = options.returnScenario ?? "normal";
    document.body.innerHTML = `<main data-oaam-route="library" data-oaam-subject="projects" data-oaam-state="ready"
        data-oaam-project-id="${SELECTED}"><div class="library-sidebar-footer"><button class="library-settings-button"
        data-oaam-semantic-action="library.open_settings" data-oaam-semantic-entry="library.settings.footer"></button>
        </div><div class="tree"></div></main>`;
    const library = document.querySelector<HTMLElement>("main");
    if (library === null) throw new Error("restore fixture library is missing");
    let currentLibrary = library;
    let restored = false;
    const settings = document.createElement("main");
    settings.dataset.oaamRoute = "settings";
    settings.dataset.oaamState = "ready";
    settings.dataset.settingsCategory = "general";
    settings.innerHTML = `<button class="settings-return-button"></button><section class="retained-project-settings"><details class="retained-projects">
        <summary>Retained</summary><ul><li data-oaam-project-id="${id}"><span><strong>Stop target</strong><small>${ROOT}</small></span>
        <button data-oaam-interaction-entry="features.project-library.retained_project_settings.002"></button></li></ul></details></section>`;
    const retainedRow = settings.querySelector("li");
    if (retainedRow === null) throw new Error("restore fixture retained row is missing");
    if (options.duplicate) settings.querySelector("ul")?.append(retainedRow.cloneNode(true));
    if (options.omit) settings.querySelector("li")?.remove();
    const returnButton = settings.querySelector<HTMLButtonElement>(".settings-return-button");
    if (returnButton === null) throw new Error("restore fixture return control is missing");
    if (returnScenario === "missing") returnButton.remove();
    if (returnScenario === "disabled") returnButton.disabled = true;
    if (returnScenario === "duplicate") settings.prepend(returnButton.cloneNode());
    if (returnScenario === "wrong-route") {
        const wrongRoute = document.createElement("main");
        wrongRoute.dataset.oaamRoute = "sources";
        wrongRoute.append(returnButton);
        document.body.append(wrongRoute);
    }
    let hiddenLibrary: HTMLElement | null = null;
    const mountSettings = (sourceLibrary: HTMLElement) => {
        if (returnScenario === "hidden-old") {
            hiddenLibrary?.remove();
            hiddenLibrary = sourceLibrary.cloneNode(true) as HTMLElement;
            hiddenLibrary.hidden = true;
            document.body.append(hiddenLibrary);
        }
        sourceLibrary.replaceWith(settings);
    };
    library.querySelector(".library-settings-button")?.addEventListener("click", () => mountSettings(currentLibrary));
    const createRestoredLibrary = (withManage: boolean): HTMLElement => {
        const next = document.createElement("main");
        next.dataset.oaamRoute = "library";
        next.dataset.oaamSubject = "projects";
        next.dataset.oaamState = "ready";
        next.dataset.oaamProjectId = renderScenario === "wrong-selection" ? TARGET : SELECTED;
        const targetId = renderScenario === "wrong-identity" ? "33333333-3333-4333-8333-333333333333" : TARGET;
        const row =
            renderScenario === "missing-target"
                ? ""
                : `<button class="asset-tree-project" data-oaam-project-id="${targetId}">
                    <span class="asset-tree-project-label"><span>Stop target</span></span></button>`;
        next.innerHTML = `<div class="library-sidebar-footer"><button class="library-settings-button"
            data-oaam-semantic-action="library.open_settings" data-oaam-semantic-entry="library.settings.footer"></button></div>
            <div class="tree">${row}${renderScenario === "duplicate" ? row : ""}
            ${withManage ? `<button data-oaam-action="manage-project" data-oaam-project-id="${TARGET}"></button>` : ""}</div>`;
        next.querySelector<HTMLButtonElement>(".library-settings-button")?.addEventListener("click", () => mountSettings(next));
        next.querySelector<HTMLButtonElement>('[data-oaam-action="manage-project"]')?.addEventListener("click", () => {
            const reopened = document.createElement("div");
            reopened.dataset.oaamDialog = "project_lifecycle";
            reopened.innerHTML = `<dl class="project-lifecycle-subject"><dd>Stop target</dd><dd>${ROOT}</dd></dl>`;
            reopened.addEventListener("keydown", () => reopened.remove());
            document.body.append(reopened);
        });
        return next;
    };
    settings.querySelector(".settings-return-button")?.addEventListener("click", () => {
        if (!restored || returnScenario === "stuck") return;
        setTimeout(() => {
            if (renderScenario === "missing-route") {
                settings.remove();
                return;
            }
            const next = createRestoredLibrary(true);
            settings.replaceWith(next);
            hiddenLibrary?.remove();
            currentLibrary = next;
        }, 0);
    });
    settings.querySelectorAll<HTMLButtonElement>("li button").forEach((button) => {
        button.addEventListener("click", () => {
            const dialog = document.createElement("div");
            dialog.dataset.oaamDialog = "project_lifecycle";
            dialog.innerHTML = `<dl class="project-lifecycle-subject"><dd>Stop target</dd><dd>${ROOT}</dd></dl>
            <button data-oaam-project-action="restore"></button>`;
            dialog.querySelector("button")?.addEventListener("click", () => {
                dialog.insertAdjacentHTML(
                    "beforeend",
                    `<section class="project-lifecycle-review" data-oaam-project-lifecycle-action="restore">
                <div class="detail-actions"><button data-oaam-interaction-entry="features.project-library.project_lifecycle_dialog.010"></button></div></section>`,
                );
                dialog.querySelector<HTMLButtonElement>(".detail-actions button")?.addEventListener("click", () => {
                    dialog.remove();
                    settings.querySelector(`li[data-oaam-project-id="${TARGET}"]`)?.remove();
                    restored = true;
                });
            });
            dialog.addEventListener("keydown", () => dialog.remove());
            document.body.append(dialog);
        });
    });
    return { library, settings };
}

type SettingsEntryScenario =
    | "delayed"
    | "missing"
    | "duplicate"
    | "disabled"
    | "wrong-action"
    | "wrong-entry"
    | "wrong-route"
    | "wrong-subject"
    | "failed";

function runSettingsEntryDom(scenario: SettingsEntryScenario): Promise<unknown> {
    const { library, settings } = installRestoreDom();
    const settingsButton = library.querySelector<HTMLButtonElement>(".library-settings-button");
    const footer = library.querySelector<HTMLElement>(".library-sidebar-footer");
    if (settingsButton === null || footer === null) throw new Error("Settings-entry fixture is incomplete");
    settingsButton.remove();
    if (["delayed", "missing"].includes(scenario)) footer.remove();
    const makeButton = (): HTMLButtonElement => {
        const button = settingsButton.cloneNode() as HTMLButtonElement;
        button.dataset.oaamSemanticAction = scenario === "wrong-action" ? "library.open_search" : "library.open_settings";
        button.dataset.oaamSemanticEntry = scenario === "wrong-entry" ? "library.settings.warning" : "library.settings.footer";
        button.disabled = scenario === "disabled";
        button.addEventListener("click", () => document.body.append(settings));
        return button;
    };
    if (scenario === "failed")
        library.insertAdjacentHTML(
            "beforeend",
            '<section class="library-state-panel" role="alert">Project list failed</section>',
        );
    else if (!["delayed", "missing", "wrong-route", "wrong-subject"].includes(scenario)) footer.append(makeButton());
    if (scenario === "duplicate") footer.append(makeButton());
    if (scenario === "wrong-route" || scenario === "wrong-subject") {
        const owner = document.createElement("main");
        owner.dataset.oaamRoute = scenario === "wrong-route" ? "sources" : "library";
        owner.dataset.oaamSubject = scenario === "wrong-subject" ? "global" : "projects";
        owner.dataset.oaamState = "ready";
        owner.append(makeButton());
        document.body.append(owner);
    }
    let pollCount = 0;
    let rendered = false;
    return Promise.resolve(
        runInNewContext(
            retainedSettingsReadyScript({
                projectId: TARGET,
                selectedProjectId: SELECTED,
                displayName: "Stop target",
                rootPath: ROOT,
            }),
            {
                Date: { now: () => ++pollCount * 1_000 },
                document,
                HTMLElement,
                HTMLButtonElement,
                HTMLDetailsElement,
                Promise,
                setTimeout: (callback: () => void) => {
                    if (scenario === "delayed" && !rendered) {
                        rendered = true;
                        footer.append(makeButton());
                        library.append(footer);
                    }
                    queueMicrotask(callback);
                },
            },
        ) as unknown,
    );
}

async function proveRestore(
    options: Parameters<typeof installRestoreDom>[0] = {},
    authority?: { before: ReturnType<typeof snapshot>; after: ReturnType<typeof snapshot> },
) {
    const fixture = installRestoreDom(options);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-project-restore-"));
    roots.push(root);
    const subject = { projectId: TARGET, selectedProjectId: SELECTED, displayName: "Stop target", rootPath: ROOT };
    fs.writeFileSync(
        path.join(root, PACKAGED_PROJECT_RESTORE_SUBJECT_FILE_NAME),
        JSON.stringify({ schemaVersion: 1, ...subject }),
    );
    const restoredCoordination = [...STRUCTURAL_COORDINATION, TARGET_LOCK, CATALOG_LOCK].sort();
    const before = authority?.before ?? snapshot("a", STRUCTURAL_COORDINATION);
    const after = authority?.after ?? snapshot("c", restoredCoordination);
    const readSnapshot = vi
        .fn()
        .mockReturnValueOnce(before)
        .mockReturnValueOnce(before)
        .mockReturnValueOnce(after)
        .mockReturnValueOnce(after);
    let pollCount = 0;
    const proof = await proveWindowsPackagedRetainedProjectStage(
        "restore",
        {
            executeJavaScript: (script) =>
                Promise.resolve(
                    runInNewContext(script, {
                        document,
                        HTMLElement,
                        HTMLButtonElement,
                        HTMLDetailsElement,
                        KeyboardEvent,
                        Promise,
                        Date: { now: () => ++pollCount * 1_000 },
                        setTimeout,
                    }) as unknown,
                ),
            capturePage: vi.fn(async () => ({ toPNG: png })),
        },
        root,
        readSnapshot,
        root,
    );
    return { proof, root, initialLibraryConnected: fixture.library.isConnected };
}

describe("packaged Project restore-only proof", () => {
    it("waits for the exact Settings footer control after the Projects shell is ready", async () => {
        await expect(runSettingsEntryDom("delayed")).resolves.toMatchObject({ status: "retained_ready", projectId: TARGET });
    });

    it.each([
        ["missing", /cannot open Settings: terminal=.*controlCount.*0/u],
        ["duplicate", /Settings footer control is ambiguous/u],
        ["disabled", /Settings footer control is disabled/u],
        ["wrong-action", /wrong semantic identity/u],
        ["wrong-entry", /wrong semantic identity/u],
        ["wrong-route", /wrong route or subject/u],
        ["wrong-subject", /wrong route or subject/u],
        ["failed", /Project library failed: Project list failed/u],
    ] as const)("fails closed for the %s Settings-entry terminal", async (scenario, message) => {
        await expect(runSettingsEntryDom(scenario)).rejects.toThrow(message);
    });

    it("reacquires replaced Projects libraries while preserving the selected control", async () => {
        const result = await proveRestore();
        expect(result.proof).toMatchObject({ projectId: TARGET, selectedProjectId: SELECTED, selectedProjectPreserved: true });
        expect(result.initialLibraryConnected).toBe(false);
        expect(packagedRetainedProjectProofMode(["--oaam-packaged-project-restore-smoke"])).toBe("restore");
        expect(packagedRetainedProjectProofMode(["--oaam-packaged-project-stop-smoke"])).toBe("stop");
        expect(packagedRetainedProjectProofText("restore", "line")).toBe("OAAM_DESKTOP_PROJECT_RESTORE passed");
        expect(packagedRetainedProjectProofText("restore", "label")).toBe("OAAM_DESKTOP_PROJECT_RESTORE_SMOKE");
        expect(fs.existsSync(path.join(result.root, PACKAGED_PROJECT_RESTORE_DIRECTORY, "manifest.json"))).toBe(true);
    });

    it("ignores a hidden pre-Settings library and waits for the fresh returned route", async () => {
        await expect(proveRestore({ returnScenario: "hidden-old" })).resolves.toMatchObject({
            proof: { projectId: TARGET, selectedProjectId: SELECTED, selectedProjectPreserved: true },
        });
    });

    it.each([
        ["missing", /Settings return control is missing/u],
        ["disabled", /Settings return control is disabled/u],
        ["duplicate", /Settings return control is ambiguous/u],
        ["wrong-route", /Settings return control belongs to the wrong route/u],
        ["stuck", /timed out waiting for restored Project fresh Projects library/u],
    ] as const)("fails closed for a %s Settings return", async (returnScenario, message) => {
        await expect(proveRestore({ returnScenario })).rejects.toThrow(message);
    });

    it.each([
        ["wrong-selection", /preserve the selected Project/u],
        ["wrong-identity", /active Project identity changed/u],
        ["duplicate", /active Project is ambiguous/u],
        ["missing-target", /timed out waiting for restored Project exact active Project/u],
        ["missing-route", /timed out waiting for restored Project fresh Projects library/u],
    ] as const)("fails closed for a replaced %s Projects library", async (renderScenario, message) => {
        await expect(proveRestore({ renderScenario })).rejects.toThrow(message);
    });

    it("accepts exact legal lock anchors that already exist", async () => {
        const paths = [...STRUCTURAL_COORDINATION, TARGET_LOCK, CATALOG_LOCK].sort();
        await expect(proveRestore({}, { before: snapshot("a", paths), after: snapshot("c", paths) })).resolves.toBeDefined();
    });

    it.each([
        ["missing target", [CATALOG_LOCK]],
        ["missing catalog", [TARGET_LOCK]],
        ["extra lock", [TARGET_LOCK, CATALOG_LOCK, `${LOCK_ROOT}/foreign.lock`]],
        ["wrong target", [`${LOCK_ROOT}/33333333-3333-4333-8333-333333333333.lock`, CATALOG_LOCK]],
        ["wrong catalog", [TARGET_LOCK, `${LOCK_ROOT}/catalogue.lock`]],
        ["wrong namespace", [TARGET_LOCK, "transactions/authority-locks/assets/catalog.lock"]],
        ["wrong suffix", [TARGET_LOCK, `${LOCK_ROOT}/catalog.txt`]],
        ["deep lock", [TARGET_LOCK, `${LOCK_ROOT}/deep/catalog.lock`]],
    ] as const)("rejects a %s coordination transition", async (_label, locks) => {
        await expect(
            proveRestore(
                {},
                {
                    before: snapshot("a", STRUCTURAL_COORDINATION),
                    after: snapshot("c", [...STRUCTURAL_COORDINATION, ...locks].sort()),
                },
            ),
        ).rejects.toThrow();
    });

    it("rejects a business child under transactions", async () => {
        const paths = [...STRUCTURAL_COORDINATION, TARGET_LOCK, CATALOG_LOCK].sort();
        const after = snapshot("c", paths);
        after.businessAuthorityManifest.push({
            relativePath: `${LOCK_ROOT}/receipt.json`,
            kind: "file",
            size: 1,
            sha256: "d".repeat(64),
        });
        after.businessAuthorityEntryCount += 1;
        await expect(proveRestore({}, { before: snapshot("a", paths), after })).rejects.toThrow(/coordination boundary/u);
    });

    it.each([
        [{ duplicate: true }, /missing or ambiguous/u],
        [{ omit: true }, /missing or ambiguous/u],
        [{ projectId: "33333333-3333-4333-8333-333333333333" }, /identity changed/u],
        [{ changeSelection: true }, /preserve the selected Project/u],
    ] as const)("fails closed for a mismatched retained or final identity", async (options, message) => {
        await expect(proveRestore(options)).rejects.toThrow(message);
    });
});
