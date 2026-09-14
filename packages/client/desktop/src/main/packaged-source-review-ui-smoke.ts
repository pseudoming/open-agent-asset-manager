export type PackagedSourceSelectionMode = "native_primary" | "compatible_only";

export interface PackagedSourceReviewProof {
    readonly selectionMode: PackagedSourceSelectionMode;
    readonly selectedSourcePath: string;
    readonly sourceCardCount: number;
    readonly nativeSourcePath: string;
    readonly nativeRelationshipKinds: readonly ["native", "compatible_shared"];
    readonly compatibleOnlySourcePath: string;
    readonly compatibleOnlyRelationshipKinds: readonly ["compatible_shared"];
    readonly compatibleOnlyInitialState: "included" | "ignored";
    readonly restoredSelectedSource: boolean;
    readonly checkboxCount: 0;
    readonly confirmationObserved: true;
    readonly ignoredCardCount: number;
    readonly usesConfirmedIgnore: true;
}

export interface PackagedSourceReviewWebContents {
    executeJavaScript(script: string): Promise<unknown>;
}

function sourceReviewScript(selectionMode: PackagedSourceSelectionMode): string {
    return `(async () => {
    const deadline = Date.now() + 15000;
    const selectionMode = ${JSON.stringify(selectionMode)};
    const waitFor = async (predicate, label) => {
        while (Date.now() < deadline) {
            const value = predicate();
            if (value !== undefined && value !== false && value !== null) return value;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("timed out waiting for " + label);
    };
    const workspace = await waitFor(
        () => document.querySelector('.discovery-workspace[data-oaam-journey-stage="sources"]'),
        "the source review stage",
    );
    if (workspace.querySelector("[data-oaam-diagnostic-layout='individual']") !== null) {
        throw new Error("source review still exposes repeated individual diagnostics");
    }
    const groupedDiagnostics = [...workspace.querySelectorAll("[data-oaam-diagnostic-layout='grouped']")];
    if (groupedDiagnostics.some(
        (group) =>
            group.querySelectorAll(".workbench-notice").length !== 1 ||
            group.querySelectorAll(".protocol-technical-record").length === 0,
    )) {
        throw new Error("source review exposes a malformed grouped diagnostic");
    }
    const issueDisclosure = workspace.querySelector("details.discovery-probe-issues");
    if (issueDisclosure !== null && (!(issueDisclosure instanceof HTMLDetailsElement) || issueDisclosure.open)) {
        throw new Error("skipped scan information is not a collapsed disclosure");
    }
    const attributedIssues = [...workspace.querySelectorAll(
        ".discovery-probe-issue-list > .discovery-probe-issue",
    )];
    if (attributedIssues.some(
        (issue) =>
            issue.querySelector(".discovery-probe-issue-owner strong") === null ||
            issue.querySelectorAll(".discovery-probe-issue-paths > li").length === 0 ||
            issue.querySelectorAll(".protocol-technical-record").length === 0,
    )) {
        throw new Error("source review exposes an unattributed probe issue");
    }
    if (groupedDiagnostics.length === 0 && attributedIssues.length === 0) {
        throw new Error("source review lost all diagnostic evidence");
    }
    const cards = [...workspace.querySelectorAll(".source-review-card[data-oaam-source-path]")];
    if (cards.length < 2) throw new Error("source review has fewer than two physical source counterexamples");
    const identityOf = (card) => JSON.stringify([
        card.dataset.oaamSourceEnvironment ?? "",
        card.dataset.oaamSourcePath ?? "",
    ]);
    const identities = cards.map(identityOf);
    if (
        identities.some((identity) => identity === JSON.stringify(["", ""])) ||
        new Set(identities).size !== identities.length
    ) {
        throw new Error("source review did not group each exact environment and physical path once");
    }
    const cardClaims = cards.map((card) => ({
        card,
        relationshipKinds: JSON.parse(card.dataset.oaamSourceClaimKinds ?? "null"),
    }));
    for (const entry of cardClaims) {
        if (
            !Array.isArray(entry.relationshipKinds) ||
            entry.relationshipKinds.length === 0 ||
            entry.relationshipKinds.some((kind) => typeof kind !== "string" || kind.length === 0) ||
            (entry.relationshipKinds.includes("native") && entry.relationshipKinds[0] !== "native")
        ) {
            throw new Error("source review did not present the native relationship first");
        }
    }
    const localNative = cardClaims.filter(
        (entry) =>
            entry.card.dataset.oaamSourceEnvironment === "win32:desktop-local" &&
            JSON.stringify(entry.relationshipKinds) === JSON.stringify(["native", "compatible_shared"]),
    );
    const localCompatibleOnly = cardClaims.filter(
        (entry) =>
            entry.card.dataset.oaamSourceEnvironment === "win32:desktop-local" &&
            JSON.stringify(entry.relationshipKinds) === JSON.stringify(["compatible_shared"]),
    );
    if (localNative.length !== 1 || localCompatibleOnly.length !== 1) {
        throw new Error(
            "source review did not expose one native-plus-compatible and one compatible-only Windows path; observed=" +
            JSON.stringify(cardClaims.map((entry) => ({
                environment: entry.card.dataset.oaamSourceEnvironment ?? "",
                path: entry.card.dataset.oaamSourcePath ?? "",
                relationshipKinds: entry.relationshipKinds,
            }))),
        );
    }
    const nativeCard = localNative[0].card;
    const compatibleOnlyCard = localCompatibleOnly[0].card;
    const currentCardFor = (identity) => [...workspace.querySelectorAll(".source-review-card[data-oaam-source-path]")]
        .find((card) => identityOf(card) === identity);
    const checkboxCount = workspace.querySelectorAll('.source-review-card input[type="checkbox"]').length;
    if (checkboxCount !== 0 || workspace.querySelector("[data-oaam-source-choice]") !== null) {
        throw new Error("source review still reinforces default inclusion with checkbox controls");
    }
    const compatibleOnlyInitialState = compatibleOnlyCard.dataset.oaamSourceState ?? "";
    const compatibleOnlyInitialEvidence = {
        defaultIncluded: compatibleOnlyCard.dataset.oaamSourceDefaultIncluded ?? "",
        selected: compatibleOnlyCard.dataset.oaamSourceSelected ?? "",
        state: compatibleOnlyInitialState,
        watched: compatibleOnlyCard.dataset.oaamSourceWatchSelected ?? "",
    };
    const expectedCompatibleOnlyInitialState = selectionMode === "native_primary" ? "included" : "ignored";
    const compatibleOnlyInitialStateMatches = selectionMode === "native_primary"
        ? compatibleOnlyInitialEvidence.defaultIncluded === "true" &&
            compatibleOnlyInitialEvidence.selected === "true" &&
            compatibleOnlyInitialEvidence.state === "included" &&
            compatibleOnlyInitialEvidence.watched === "true"
        : compatibleOnlyInitialEvidence.defaultIncluded === "false" &&
            compatibleOnlyInitialEvidence.selected === "false" &&
            compatibleOnlyInitialEvidence.state === "ignored" &&
            compatibleOnlyInitialEvidence.watched === "false";
    if (!compatibleOnlyInitialStateMatches) {
        throw new Error(
            "compatible-only source did not preserve the expected default-or-prior-ignore state: " +
            JSON.stringify({ selectionMode, expectedCompatibleOnlyInitialState, ...compatibleOnlyInitialEvidence }),
        );
    }
    const selectedCard = selectionMode === "native_primary" ? nativeCard : compatibleOnlyCard;
    const selectedIdentity = identityOf(selectedCard);
    let confirmationObserved = false;
    let restoredSelectedSource = false;
    for (const identity of identities) {
        let card = currentCardFor(identity);
        if (!(card instanceof HTMLElement)) throw new Error("source review lost one physical source card");
        const shouldSelect = identity === selectedIdentity;
        if (shouldSelect && card.dataset.oaamSourceSelected !== "true") {
            const include = await waitFor(() => {
                const currentCard = currentCardFor(identity);
                const currentAction = currentCard?.querySelector(
                    '[data-oaam-source-action="restore"], [data-oaam-source-action="include"]',
                );
                return currentAction instanceof HTMLButtonElement && !currentAction.disabled ? currentAction : false;
            }, "the enabled source inclusion action for " + identity);
            restoredSelectedSource = include.dataset.oaamSourceAction === "restore";
            include.click();
            await waitFor(() => {
                const currentCard = currentCardFor(identity);
                return currentCard instanceof HTMLElement &&
                    currentCard.dataset.oaamSourceSelected === "true" &&
                    currentCard.dataset.oaamSourceState === "included";
            }, "the source inclusion state for " + identity);
            card = currentCardFor(identity);
        }
        if (!shouldSelect && card instanceof HTMLElement && card.dataset.oaamSourceState === "included") {
            const ignore = await waitFor(() => {
                const currentCard = currentCardFor(identity);
                const currentAction = currentCard?.querySelector('[data-oaam-source-action="ignore"]');
                return currentAction instanceof HTMLButtonElement && !currentAction.disabled ? currentAction : false;
            }, "the enabled source ignore action for " + identity);
            ignore.click();
            const confirmation = await waitFor(() => {
                const currentCard = currentCardFor(identity);
                return currentCard?.querySelector('[data-oaam-source-ignore-confirmation="true"]');
            }, "the source ignore confirmation for " + identity);
            if (!(confirmation instanceof HTMLElement)) {
                throw new Error("the source ignore confirmation is not attributable to its card");
            }
            confirmationObserved = true;
            const confirm = confirmation.querySelector('[data-oaam-source-action="confirm-ignore"]');
            if (!(confirm instanceof HTMLButtonElement)) {
                throw new Error("the source ignore confirmation has no exact confirm action");
            }
            confirm.click();
            await waitFor(() => {
                const currentCard = currentCardFor(identity);
                return currentCard instanceof HTMLElement &&
                    currentCard.dataset.oaamSourceSelected === "false" &&
                    currentCard.dataset.oaamSourceWatchSelected === "false" &&
                    currentCard.dataset.oaamSourceState === "ignored";
            }, "the confirmed source ignore state for " + identity);
        }
    }
    const finalCards = identities.map((identity) => currentCardFor(identity));
    if (finalCards.some((card) => !(card instanceof HTMLElement))) {
        throw new Error("source review lost a physical source card after review");
    }
    const selectedCards = finalCards.filter((card) => card?.dataset.oaamSourceSelected === "true");
    const ignoredCardCount = finalCards.filter((card) => card?.dataset.oaamSourceState === "ignored").length;
    if (selectedCards.length !== 1 || identityOf(selectedCards[0]) !== selectedIdentity) {
        throw new Error("source review did not retain the exact one-path read selection");
    }
    if (!confirmationObserved || ignoredCardCount < 1) {
        throw new Error("source review did not exercise confirmed whole-location ignore");
    }
    if (restoredSelectedSource !== (selectionMode === "compatible_only")) {
        throw new Error("source review did not preserve and restore the prior whole-location ignore decision");
    }
    const nativeSourcePath = nativeCard.dataset.oaamSourcePath ?? "";
    const compatibleOnlySourcePath = compatibleOnlyCard.dataset.oaamSourcePath ?? "";
    const selectedSourcePath = selectedCard.dataset.oaamSourcePath ?? "";
    if (nativeSourcePath.length === 0 || compatibleOnlySourcePath.length === 0 || selectedSourcePath.length === 0) {
        throw new Error("a deterministic Windows source path is empty");
    }
    return {
        status: "complete",
        selectionMode,
        selectedSourcePath,
        sourceCardCount: cards.length,
        nativeSourcePath,
        nativeRelationshipKinds: ["native", "compatible_shared"],
        compatibleOnlySourcePath,
        compatibleOnlyRelationshipKinds: ["compatible_shared"],
        compatibleOnlyInitialState,
        restoredSelectedSource,
        checkboxCount,
        confirmationObserved,
        ignoredCardCount,
        usesConfirmedIgnore: true,
    };
})()`;
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function parsePackagedSourceReviewProof(value: unknown): PackagedSourceReviewProof {
    if (
        !exactRecord(value, [
            "compatibleOnlyInitialState",
            "compatibleOnlyRelationshipKinds",
            "compatibleOnlySourcePath",
            "checkboxCount",
            "confirmationObserved",
            "ignoredCardCount",
            "nativeRelationshipKinds",
            "nativeSourcePath",
            "restoredSelectedSource",
            "selectionMode",
            "selectedSourcePath",
            "sourceCardCount",
            "status",
            "usesConfirmedIgnore",
        ]) ||
        value.status !== "complete" ||
        (value.selectionMode !== "native_primary" && value.selectionMode !== "compatible_only") ||
        typeof value.selectedSourcePath !== "string" ||
        value.selectedSourcePath.length === 0 ||
        typeof value.nativeSourcePath !== "string" ||
        value.nativeSourcePath.length === 0 ||
        typeof value.compatibleOnlySourcePath !== "string" ||
        value.compatibleOnlySourcePath.length === 0 ||
        !Number.isSafeInteger(value.sourceCardCount) ||
        (value.sourceCardCount as number) < 2 ||
        JSON.stringify(value.nativeRelationshipKinds) !== JSON.stringify(["native", "compatible_shared"]) ||
        JSON.stringify(value.compatibleOnlyRelationshipKinds) !== JSON.stringify(["compatible_shared"]) ||
        (value.compatibleOnlyInitialState !== "included" && value.compatibleOnlyInitialState !== "ignored") ||
        typeof value.restoredSelectedSource !== "boolean" ||
        value.checkboxCount !== 0 ||
        value.confirmationObserved !== true ||
        !Number.isSafeInteger(value.ignoredCardCount) ||
        (value.ignoredCardCount as number) < 1 ||
        value.usesConfirmedIgnore !== true
    ) {
        throw new TypeError("invalid packaged source-review proof");
    }
    return Object.freeze({
        selectionMode: value.selectionMode,
        selectedSourcePath: value.selectedSourcePath,
        sourceCardCount: value.sourceCardCount as number,
        nativeSourcePath: value.nativeSourcePath,
        nativeRelationshipKinds: Object.freeze(["native", "compatible_shared"] as const),
        compatibleOnlySourcePath: value.compatibleOnlySourcePath,
        compatibleOnlyRelationshipKinds: Object.freeze(["compatible_shared"] as const),
        compatibleOnlyInitialState: value.compatibleOnlyInitialState,
        restoredSelectedSource: value.restoredSelectedSource,
        checkboxCount: 0,
        confirmationObserved: true,
        ignoredCardCount: value.ignoredCardCount as number,
        usesConfirmedIgnore: true,
    });
}

export async function reviewPackagedPhysicalSources(
    webContents: PackagedSourceReviewWebContents,
    selectionMode: PackagedSourceSelectionMode,
): Promise<PackagedSourceReviewProof> {
    return parsePackagedSourceReviewProof(await webContents.executeJavaScript(sourceReviewScript(selectionMode)));
}
