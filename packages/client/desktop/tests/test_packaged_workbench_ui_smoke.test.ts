import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    PACKAGED_WORKBENCH_JOURNEY_PROOF_FILE,
    PACKAGED_WORKBENCH_SCREENSHOT_MANIFEST,
    PackagedLibraryScreenshotProof,
    PackagedWorkbenchScreenshotProof,
    packagedWorkbenchProofMode,
    startPackagedWorkbenchProof,
} from "../src/main/packaged-workbench-screenshot-proof";
import {
    PACKAGED_LIBRARY_SCREENSHOT_STAGES,
    PACKAGED_LIBRARY_UI_LINE,
    PACKAGED_WORKBENCH_JOURNEY_SCREENSHOT_STAGES,
    PACKAGED_WORKBENCH_PERSISTENCE_LINE,
    PACKAGED_WORKBENCH_PERSISTENCE_SCREENSHOT_STAGE,
    PACKAGED_WORKBENCH_SCREENSHOT_STAGES,
    PACKAGED_WORKBENCH_UI_LINE,
    type PackagedLibraryUiProof,
    type PackagedWorkbenchPersistenceProof,
    type PackagedWorkbenchUiProof,
    proveWindowsPackagedLibraryUi,
    proveWindowsPackagedWorkbenchPersistence,
    proveWindowsPackagedWorkbenchUi,
} from "../src/main/packaged-workbench-ui-smoke";

const roots: string[] = [];
const LIBRARY_SUBJECT = Object.freeze({
    projectId: "74212dfd-86f3-40c9-b308-6c4fe789afab",
    assetId: "9fc3c65f-d0fd-4857-a8ea-400e3d8d371e",
    versionId: "d72c9d3f-03f8-4956-884c-d8289b70003d",
    deploymentId: "c8106b22-091f-47ed-a608-b886a57a6625",
});

function pngFixture(): Buffer {
    const bytes = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    bytes.writeUInt32BE(13, 8);
    bytes.write("IHDR", 12, "ascii");
    bytes.writeUInt32BE(1_280, 16);
    bytes.writeUInt32BE(720, 20);
    return bytes;
}

function uiProof(): PackagedWorkbenchUiProof {
    return {
        status: "complete",
        startup: {
            starting: true,
            reconnecting: true,
            terminalFailure: true,
            manualRetryRecovered: true,
            recoveredAssetCount: 2,
        },
        settings: {
            enteredThroughOrdinaryControl: true,
            theme: "dark",
            textSize: "large",
            surfacePalette: "cool",
        },
        search: {
            query: "oaam-proof",
            exactMatchCount: 2,
            highlightedMatchCount: 3,
            focusRestored: true,
            exactAssetActivated: true,
        },
    };
}

function persistenceProof(): PackagedWorkbenchPersistenceProof {
    return {
        status: "complete",
        enteredThroughOrdinaryControl: true,
        theme: "dark",
        textSize: "large",
        surfacePalette: "cool",
        assetCount: 2,
    };
}

function libraryProof(): PackagedLibraryUiProof {
    return {
        status: "complete",
        project: {
            selectedProjectId: LIBRARY_SUBJECT.projectId,
            selectedAssetId: LIBRARY_SUBJECT.assetId,
            visibleProjectCount: 2,
            unrelatedProjectCount: 1,
            selectedProjectAssetCount: 1,
            totalAssetCount: 52,
            manageDialog: true,
            destructiveReview: true,
            backupGate: true,
            reviewCancelled: true,
            comparedVersionCount: 2,
        },
        asset: {
            boundedGlobalCount: 50,
            comparisonRendered: true,
            deleteReviewed: true,
            deleted: true,
            purgeReviewed: true,
            restoreCompleted: true,
        },
    };
}

function successfulExecutions(): readonly unknown[] {
    return [
        "starting",
        "reconnecting",
        "failed",
        true,
        2,
        "general",
        { theme: "dark", textSize: "large", surfacePalette: "cool" },
        true,
        72,
        { query: "oaam-proof", exactMatchCount: 2, highlightedMatchCount: 3, dialogTop: 72 },
        true,
        72,
        { query: "oaam-proof", exactMatchCount: 2, highlightedMatchCount: 3, dialogTop: 72 },
        true,
    ];
}

function successfulLibraryExecutions(): readonly unknown[] {
    return [
        {
            selectedProjectId: LIBRARY_SUBJECT.projectId,
            selectedAssetId: LIBRARY_SUBJECT.assetId,
            visibleProjectCount: 2,
            unrelatedProjectCount: 1,
            selectedProjectAssetCount: 1,
            totalAssetCount: 52,
            onboardingDismissed: true,
        },
        true,
        { destructiveReview: true, backupGate: true },
        true,
        { versionCount: 2 },
        { comparisonRendered: true, changedFileCount: 1 },
        { boundedGlobalCount: 50 },
        true,
        true,
        { purgeReviewed: true, backupGate: true },
        true,
    ];
}

function stagedExecution(values: readonly unknown[]) {
    const executeJavaScript = vi.fn();
    for (const value of values) executeJavaScript.mockResolvedValueOnce(value);
    return executeJavaScript;
}

afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("packaged startup, Settings and Search UI smoke", () => {
    it("owns switch selection, packaged execution, persistence continuation, and shutdown outcome", async () => {
        expect(packagedWorkbenchProofMode([])).toBeUndefined();
        expect(packagedWorkbenchProofMode(["--oaam-packaged-workbench-ui-smoke"])).toBe("journey");
        expect(packagedWorkbenchProofMode(["--oaam-packaged-library-ui-smoke"])).toBe("library");
        expect(packagedWorkbenchProofMode(["--oaam-packaged-workbench-persistence-smoke"])).toBe("persistence");
        expect(() =>
            packagedWorkbenchProofMode(["--oaam-packaged-workbench-ui-smoke", "--oaam-packaged-workbench-persistence-smoke"]),
        ).toThrow("mutually exclusive");

        const parent = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-packaged-workbench-runner-"));
        roots.push(parent);
        const writeOutput = vi.fn();
        const writeError = vi.fn();
        const requestJourneyShutdown = vi.fn();
        expect(
            startPackagedWorkbenchProof({
                mode: "journey",
                platform: "win32",
                temporaryRootPath: parent,
                librarySubject: LIBRARY_SUBJECT,
                webContents: {
                    executeJavaScript: stagedExecution(successfulExecutions()),
                    capturePage: vi.fn(async () => ({ toPNG: () => pngFixture() })),
                },
                writeOutput,
                writeError,
                requestShutdown: requestJourneyShutdown,
            }),
        ).toBe(true);
        await vi.waitFor(() => expect(requestJourneyShutdown).toHaveBeenCalledWith(false), { timeout: 5_000 });
        expect(writeOutput).toHaveBeenCalledWith(`${PACKAGED_WORKBENCH_UI_LINE}\n`);
        expect(writeError).not.toHaveBeenCalled();

        const requestPersistenceShutdown = vi.fn();
        expect(
            startPackagedWorkbenchProof({
                mode: "persistence",
                platform: "win32",
                temporaryRootPath: parent,
                webContents: {
                    executeJavaScript: vi.fn(async () => ({
                        theme: "dark",
                        textSize: "large",
                        surfacePalette: "cool",
                        assetCount: 2,
                    })),
                    capturePage: vi.fn(async () => ({ toPNG: () => pngFixture() })),
                },
                writeOutput,
                writeError,
                requestShutdown: requestPersistenceShutdown,
            }),
        ).toBe(true);
        await vi.waitFor(() => expect(requestPersistenceShutdown).toHaveBeenCalledWith(false));
        expect(writeOutput).toHaveBeenCalledWith(`${PACKAGED_WORKBENCH_PERSISTENCE_LINE}\n`);

        const requestLibraryShutdown = vi.fn();
        expect(
            startPackagedWorkbenchProof({
                mode: "library",
                platform: "win32",
                temporaryRootPath: parent,
                librarySubject: LIBRARY_SUBJECT,
                webContents: {
                    executeJavaScript: stagedExecution(successfulLibraryExecutions()),
                    capturePage: vi.fn(async () => ({ toPNG: () => pngFixture() })),
                },
                writeOutput,
                writeError,
                requestShutdown: requestLibraryShutdown,
            }),
        ).toBe(true);
        await vi.waitFor(() => expect(requestLibraryShutdown).toHaveBeenCalledWith(false), { timeout: 5_000 });
        expect(writeOutput).toHaveBeenCalledWith(`${PACKAGED_LIBRARY_UI_LINE}\n`);
    }, 15_000);

    it("does not start without a mode and fails closed off Windows or after proof rejection", async () => {
        const writeOutput = vi.fn();
        const writeError = vi.fn();
        const requestShutdown = vi.fn();
        const webContents = {
            executeJavaScript: vi.fn(async () => undefined),
            capturePage: vi.fn(async () => ({ toPNG: () => pngFixture() })),
        };
        expect(
            startPackagedWorkbenchProof({
                mode: undefined,
                platform: "win32",
                temporaryRootPath: "/unused",
                webContents,
                writeOutput,
                writeError,
                requestShutdown,
            }),
        ).toBe(false);
        expect(requestShutdown).not.toHaveBeenCalled();

        expect(
            startPackagedWorkbenchProof({
                mode: "journey",
                platform: "linux",
                temporaryRootPath: "/unused",
                webContents,
                writeOutput,
                writeError,
                requestShutdown,
            }),
        ).toBe(true);
        expect(writeError).toHaveBeenCalledWith("OAAM_DESKTOP_WORKBENCH_UI_SMOKE failed=unsupported_platform\n");
        expect(requestShutdown).toHaveBeenCalledWith(true);

        requestShutdown.mockClear();
        expect(
            startPackagedWorkbenchProof({
                mode: "journey",
                platform: "win32",
                temporaryRootPath: "/unused",
                webContents,
                writeOutput,
                writeError,
                requestShutdown,
                runProof: vi.fn(async () => {
                    throw new Error("proof rejected");
                }),
            }),
        ).toBe(true);
        await vi.waitFor(() => expect(requestShutdown).toHaveBeenCalledWith(true));
        expect(writeError).toHaveBeenCalledWith("OAAM_DESKTOP_WORKBENCH_UI_SMOKE failed=proof detail=proof rejected\n");
    });

    it("proves terminal startup recovery, ordinary Settings, Search focus and exact activation", async () => {
        const executeJavaScript = stagedExecution(successfulExecutions());
        const capture = vi.fn(async () => undefined);
        await expect(proveWindowsPackagedWorkbenchUi({ executeJavaScript }, { capture })).resolves.toEqual(uiProof());
        expect(capture.mock.calls.map(([stage]) => stage)).toEqual(PACKAGED_WORKBENCH_JOURNEY_SCREENSHOT_STAGES);
        expect(executeJavaScript).toHaveBeenCalledTimes(14);
        expect(String(executeJavaScript.mock.calls[3]?.[0])).toContain("status-card-actions");
        expect(String(executeJavaScript.mock.calls[5]?.[0])).toContain("settings-return-button");
        expect(String(executeJavaScript.mock.calls[5]?.[0])).toContain("settings-search input");
        expect(String(executeJavaScript.mock.calls[6]?.[0])).toContain("presentation-preferences-field");
        expect(String(executeJavaScript.mock.calls[7]?.[0])).toContain("Settings return-to-app");
        expect(String(executeJavaScript.mock.calls[7]?.[0])).not.toContain("settings-toolbar");
        expect(String(executeJavaScript.mock.calls[9]?.[0])).toContain("data-oaam-search-match");
        expect(String(executeJavaScript.mock.calls[9]?.[0])).toContain("getBoundingClientRect");
        expect(String(executeJavaScript.mock.calls[13]?.[0])).toContain("asset-inspector");
    });

    it("proves current Project and Asset UI on top of the installed authority fixture", async () => {
        const executeJavaScript = stagedExecution(successfulLibraryExecutions());
        const capture = vi.fn(async () => undefined);
        await expect(
            proveWindowsPackagedLibraryUi({ executeJavaScript }, { capture, subject: LIBRARY_SUBJECT }),
        ).resolves.toEqual(libraryProof());
        expect(capture.mock.calls.map(([stage]) => stage)).toEqual(PACKAGED_LIBRARY_SCREENSHOT_STAGES);
        expect(executeJavaScript).toHaveBeenCalledTimes(11);
        expect(String(executeJavaScript.mock.calls[0]?.[0])).toContain("asset-library-item");
        expect(String(executeJavaScript.mock.calls[0]?.[0])).toContain("data-oaam-project-id");
        expect(String(executeJavaScript.mock.calls[0]?.[0])).toContain("unrelatedProjectCount");
        expect(String(executeJavaScript.mock.calls[0]?.[0])).toContain(LIBRARY_SUBJECT.projectId);
        expect(String(executeJavaScript.mock.calls[1]?.[0])).toContain("open.focus()");
        expect(String(executeJavaScript.mock.calls[2]?.[0])).toContain("project-lifecycle-backup-gate");
        expect(String(executeJavaScript.mock.calls[3]?.[0])).toContain(LIBRARY_SUBJECT.projectId);
        expect(String(executeJavaScript.mock.calls[3]?.[0])).toContain("candidate.dataset.oaamProjectId");
        expect(String(executeJavaScript.mock.calls[4]?.[0])).toContain('data-oaam-action="inspect-asset"');
        expect(String(executeJavaScript.mock.calls[4]?.[0])).toContain("assetItem?.querySelector");
        expect(String(executeJavaScript.mock.calls[4]?.[0])).toContain('dataset.oaamVersionCount === "2"');
        expect(String(executeJavaScript.mock.calls[5]?.[0])).toContain("asset-diff-result");
        expect(String(executeJavaScript.mock.calls[6]?.[0])).toContain("asset-library-item");
        expect(String(executeJavaScript.mock.calls[7]?.[0])).toContain('.asset-library-item [data-oaam-action="inspect-asset"]');
        expect(String(executeJavaScript.mock.calls[7]?.[0])).toContain("current collection refresh");
        expect(String(executeJavaScript.mock.calls[8]?.[0])).toContain("asset.restore");
        expect(String(executeJavaScript.mock.calls[9]?.[0])).toContain("asset.purge_commit");
    });

    it("rejects Project/Asset UI evidence whose exact count or review gate is absent", async () => {
        const countValues = [...successfulLibraryExecutions()];
        countValues[0] = {
            selectedProjectId: LIBRARY_SUBJECT.projectId,
            selectedAssetId: LIBRARY_SUBJECT.assetId,
            visibleProjectCount: 1,
            unrelatedProjectCount: 0,
            selectedProjectAssetCount: 1,
            totalAssetCount: 51,
        };
        await expect(
            proveWindowsPackagedLibraryUi(
                { executeJavaScript: stagedExecution(countValues) },
                { capture: vi.fn(async () => undefined), subject: LIBRARY_SUBJECT },
            ),
        ).rejects.toThrow("invalid packaged Project library proof");

        const versionValues = [...successfulLibraryExecutions()];
        versionValues[4] = { versionCount: 3 };
        await expect(
            proveWindowsPackagedLibraryUi(
                { executeJavaScript: stagedExecution(versionValues) },
                { capture: vi.fn(async () => undefined), subject: LIBRARY_SUBJECT },
            ),
        ).rejects.toThrow("invalid packaged Project Asset inspector proof");

        const reviewValues = [...successfulLibraryExecutions()];
        reviewValues[9] = { purgeReviewed: true, backupGate: false };
        await expect(
            proveWindowsPackagedLibraryUi(
                { executeJavaScript: stagedExecution(reviewValues) },
                { capture: vi.fn(async () => undefined), subject: LIBRARY_SUBJECT },
            ),
        ).rejects.toThrow("invalid packaged Asset purge review proof");
    });

    it("rejects a weakened appearance result", async () => {
        const values = [...successfulExecutions()];
        values[6] = { theme: "system", textSize: "large", surfacePalette: "cool" };
        await expect(
            proveWindowsPackagedWorkbenchUi(
                { executeJavaScript: stagedExecution(values) },
                { capture: vi.fn(async () => undefined) },
            ),
        ).rejects.toThrow("invalid packaged workbench appearance proof");
    });

    it("rejects a Search result without an exact highlighted match", async () => {
        const values = [...successfulExecutions()];
        values[9] = { query: "oaam-proof", exactMatchCount: 1, highlightedMatchCount: 0, dialogTop: 72 };
        await expect(
            proveWindowsPackagedWorkbenchUi(
                { executeJavaScript: stagedExecution(values) },
                { capture: vi.fn(async () => undefined) },
            ),
        ).rejects.toThrow("invalid packaged workbench Search proof");
    });

    it("rejects a Search dialog that jumps when its result inventory changes", async () => {
        const values = [...successfulExecutions()];
        values[9] = { query: "oaam-proof", exactMatchCount: 1, highlightedMatchCount: 2, dialogTop: 172 };
        await expect(
            proveWindowsPackagedWorkbenchUi(
                { executeJavaScript: stagedExecution(values) },
                { capture: vi.fn(async () => undefined) },
            ),
        ).rejects.toThrow("Search dialog moved");
    });

    it("rejects false startup, Settings, and Search transition claims at their own gates", async () => {
        const cases = [
            [0, "invalid packaged starting proof"],
            [1, "invalid packaged reconnecting proof"],
            [2, "invalid packaged terminal startup proof"],
            [3, "invalid packaged Retry proof"],
            [4, "invalid packaged recovered workbench proof"],
            [5, "invalid packaged Settings entry proof"],
            [7, "invalid packaged Settings return proof"],
            [8, "invalid packaged workbench Search geometry proof"],
            [10, "invalid packaged Search focus-restoration proof"],
            [11, "invalid packaged workbench Search geometry proof"],
            [13, "invalid packaged Search route-activation proof"],
        ] as const;
        for (const [index, message] of cases) {
            const values = [...successfulExecutions()];
            values[index] = false;
            await expect(
                proveWindowsPackagedWorkbenchUi(
                    { executeJavaScript: stagedExecution(values) },
                    { capture: vi.fn(async () => undefined) },
                ),
            ).rejects.toThrow(message);
        }
    });

    it("proves the same appearance through ordinary Settings after a new process starts", async () => {
        const capture = vi.fn(async () => undefined);
        await expect(
            proveWindowsPackagedWorkbenchPersistence(
                {
                    executeJavaScript: vi.fn(async () => ({
                        theme: "dark",
                        textSize: "large",
                        surfacePalette: "cool",
                        assetCount: 2,
                    })),
                },
                { capture },
            ),
        ).resolves.toEqual(persistenceProof());
        expect(capture).toHaveBeenCalledWith(PACKAGED_WORKBENCH_PERSISTENCE_SCREENSHOT_STAGE);
    });

    it("rejects a restart whose catalog does not retain both imported Assets", async () => {
        await expect(
            proveWindowsPackagedWorkbenchPersistence(
                {
                    executeJavaScript: vi.fn(async () => ({
                        theme: "dark",
                        textSize: "large",
                        surfacePalette: "cool",
                        assetCount: 1,
                    })),
                },
                { capture: vi.fn(async () => undefined) },
            ),
        ).rejects.toThrow("invalid packaged persisted workbench Asset count");
    });

    it("continues one immutable screenshot inventory across the two packaged processes", async () => {
        const parent = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-packaged-workbench-screenshots-"));
        roots.push(parent);
        const rootPath = path.join(parent, "proof");
        const capturePage = vi.fn(async () => ({ toPNG: () => pngFixture() }));
        const first = PackagedWorkbenchScreenshotProof.create(rootPath);
        for (const stage of PACKAGED_WORKBENCH_JOURNEY_SCREENSHOT_STAGES) {
            await first.capture(stage, { capturePage });
        }
        first.recordJourney(uiProof());

        const second = PackagedWorkbenchScreenshotProof.resume(rootPath);
        await second.capture(PACKAGED_WORKBENCH_PERSISTENCE_SCREENSHOT_STAGE, { capturePage });
        second.finalize(persistenceProof());

        expect(fs.readdirSync(rootPath).sort()).toEqual(
            [
                ...PACKAGED_WORKBENCH_SCREENSHOT_STAGES.map((stage) => `${stage}.png`),
                PACKAGED_WORKBENCH_JOURNEY_PROOF_FILE,
                PACKAGED_WORKBENCH_SCREENSHOT_MANIFEST,
            ].sort(),
        );
        expect(JSON.parse(fs.readFileSync(path.join(rootPath, PACKAGED_WORKBENCH_JOURNEY_PROOF_FILE), "utf8"))).toEqual(
            uiProof(),
        );
        expect(JSON.parse(fs.readFileSync(path.join(rootPath, PACKAGED_WORKBENCH_SCREENSHOT_MANIFEST), "utf8"))).toMatchObject({
            schemaVersion: 1,
            proof: {
                journey: uiProof(),
                persistence: persistenceProof(),
            },
        });
    });

    it("rejects a non-PNG screenshot and an incomplete continuation inventory", async () => {
        const parent = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-packaged-workbench-invalid-"));
        roots.push(parent);
        const rootPath = path.join(parent, "proof");
        const proof = PackagedWorkbenchScreenshotProof.create(rootPath);
        await expect(
            proof.capture("startup-starting", {
                capturePage: vi.fn(async () => ({ toPNG: () => Buffer.alloc(24) })),
            }),
        ).rejects.toThrow("packaged workbench screenshot startup-starting is not a PNG");
        expect(() => PackagedWorkbenchScreenshotProof.resume(rootPath)).toThrow(/continuation inventory is incomplete/u);
    });

    it("rejects duplicate capture, incomplete journey/finalization, and a non-directory continuation root", async () => {
        const parent = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-packaged-workbench-immutability-"));
        roots.push(parent);
        const rootPath = path.join(parent, "proof");
        const capturePage = vi.fn(async () => ({ toPNG: () => pngFixture() }));
        const proof = PackagedWorkbenchScreenshotProof.create(rootPath);
        await proof.capture("startup-starting", { capturePage });
        await expect(proof.capture("startup-starting", { capturePage })).rejects.toThrow("was captured twice");
        expect(() => proof.recordJourney(uiProof())).toThrow("journey screenshots are incomplete");
        expect(() => proof.finalize(persistenceProof())).toThrow("persistence screenshot is incomplete");

        const filePath = path.join(parent, "not-a-directory");
        fs.writeFileSync(filePath, "not a continuation root");
        expect(() => PackagedWorkbenchScreenshotProof.resume(filePath)).toThrow("is not a direct directory");
    });

    it("writes one immutable Project/Asset screenshot manifest", async () => {
        const parent = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-packaged-library-screenshots-"));
        roots.push(parent);
        const rootPath = path.join(parent, "proof");
        const capturePage = vi.fn(async () => ({ toPNG: () => pngFixture() }));
        const proof = PackagedLibraryScreenshotProof.create(rootPath);
        for (const stage of PACKAGED_LIBRARY_SCREENSHOT_STAGES) await proof.capture(stage, { capturePage });
        proof.finalize(libraryProof());
        expect(fs.readdirSync(rootPath).sort()).toEqual(
            [...PACKAGED_LIBRARY_SCREENSHOT_STAGES.map((stage) => `${stage}.png`), "manifest.json"].sort(),
        );
        expect(JSON.parse(fs.readFileSync(path.join(rootPath, "manifest.json"), "utf8"))).toMatchObject({
            schemaVersion: 2,
            proof: libraryProof(),
        });
    });
});
