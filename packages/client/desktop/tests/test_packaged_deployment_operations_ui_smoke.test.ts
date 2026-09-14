import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    PACKAGED_DEPLOYMENT_REVERSE_COMMIT_PROOF,
    PACKAGED_DEPLOYMENT_SCREENSHOT_MANIFEST,
    proveWindowsPackagedDeploymentRepairUi,
    proveWindowsPackagedDeploymentReverseCommitUi,
    proveWindowsPackagedDeploymentReverseRecoveryUi,
    runPackagedDeploymentScreenshotProof,
} from "../src/main/packaged-deployment-operations-screenshot-proof";
import {
    PACKAGED_DEPLOYMENT_REPAIR_SCREENSHOT_DIRECTORY,
    PACKAGED_DEPLOYMENT_REPAIR_SCREENSHOT_STAGES,
    PACKAGED_DEPLOYMENT_REPAIR_UI_LINE,
    PACKAGED_DEPLOYMENT_REVERSE_COMMIT_SCREENSHOT_STAGES,
    PACKAGED_DEPLOYMENT_REVERSE_COMMIT_UI_LINE,
    PACKAGED_DEPLOYMENT_REVERSE_RECOVERY_SCREENSHOT_STAGES,
    PACKAGED_DEPLOYMENT_REVERSE_RECOVERY_UI_SMOKE_SWITCH,
    PACKAGED_DEPLOYMENT_REVERSE_SCREENSHOT_DIRECTORY,
    PACKAGED_DEPLOYMENT_REVERSE_SCREENSHOT_STAGES,
    PACKAGED_DEPLOYMENT_REVERSE_UI_LINE,
    type PackagedDeploymentRepairUiProof,
    type PackagedDeploymentReverseCommitUiProof,
    type PackagedDeploymentReverseUiProof,
} from "../src/main/packaged-deployment-operations-ui-smoke";
import { packagedWorkbenchProofMode, startPackagedWorkbenchProof } from "../src/main/packaged-workbench-screenshot-proof";

const roots: string[] = [];

function pngFixture(): Buffer {
    const bytes = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    bytes.writeUInt32BE(13, 8);
    bytes.write("IHDR", 12, "ascii");
    bytes.writeUInt32BE(1_280, 16);
    bytes.writeUInt32BE(720, 20);
    return bytes;
}

function repairProof(): PackagedDeploymentRepairUiProof {
    return {
        status: "complete",
        mode: "repair",
        ordinaryEntry: true,
        missingTargetReviewed: true,
        conflictCount: 1,
        repairedStage: "in_sync",
    };
}

function reverseProof(): PackagedDeploymentReverseUiProof {
    return {
        status: "complete",
        mode: "reverse",
        ordinaryEntry: true,
        prewriteAction: "blocked_managed_conflict",
        changeCount: 1,
        prepared: true,
        cancelled: true,
        committed: true,
        processRestarted: true,
        durableRecoveryVisible: true,
        markerRetired: true,
        recoveredStage: "in_sync",
    };
}

function reverseCommitProof(): PackagedDeploymentReverseCommitUiProof {
    const {
        processRestarted: _processRestarted,
        durableRecoveryVisible: _durableRecoveryVisible,
        markerRetired: _markerRetired,
        recoveredStage: _recoveredStage,
        ...proof
    } = reverseProof();
    return { ...proof, status: "pending_restart" };
}

function createReverseContinuationRoot(
    commitEnvelope: unknown = {
        schemaVersion: 1,
        mode: "deployment_reverse_commit",
        proof: reverseCommitProof(),
    },
): string {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-packaged-deployment-reverse-continuation-"));
    roots.push(parent);
    const proofRoot = path.join(parent, PACKAGED_DEPLOYMENT_REVERSE_SCREENSHOT_DIRECTORY);
    fs.mkdirSync(proofRoot);
    for (const stage of PACKAGED_DEPLOYMENT_REVERSE_COMMIT_SCREENSHOT_STAGES) {
        fs.writeFileSync(path.join(proofRoot, `${stage}.png`), pngFixture(), { flag: "wx" });
    }
    fs.writeFileSync(
        path.join(proofRoot, PACKAGED_DEPLOYMENT_REVERSE_COMMIT_PROOF),
        `${JSON.stringify(commitEnvelope, null, 2)}\n`,
        { flag: "wx" },
    );
    return proofRoot;
}

function repairExecutions(): readonly unknown[] {
    return [
        true,
        "in_sync",
        true,
        { stage: "needs_repair" },
        true,
        { stage: "needs_repair", conflictCount: 1 },
        true,
        { stage: "in_sync", diagnosticCount: 2 },
    ];
}

function reverseCommitExecutions(): readonly unknown[] {
    return [
        true,
        "in_sync",
        true,
        { stage: "conflict" },
        true,
        { stage: "conflict" },
        true,
        true,
        { preview: "ready:blocked_managed_conflict" },
        true,
        { changeCount: 1 },
        true,
        { reverse: "prepared" },
        true,
        { reverse: "none", message: "catalog.reverse.cancelled" },
        true,
        { changeCount: 1 },
        true,
        { reverse: "prepared" },
        true,
        true,
        true,
        { reverse: "result:committed" },
    ];
}

function reverseRecoveryExecutions(): readonly unknown[] {
    return [
        true,
        "blocked",
        {
            stage: "blocked",
            reverse: "none",
            reconciliation: "none",
            stale: "false",
            diagnosticCount: 0,
            recoverAvailable: true,
        },
        true,
        { stage: "in_sync", reverse: "none", diagnosticCount: 3 },
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

describe("packaged Deployment and reverse UI smoke", () => {
    it("reviews a missing target and repairs it through the ordinary Deployment surface", async () => {
        const executeJavaScript = stagedExecution(repairExecutions());
        const capture = vi.fn(async () => undefined);
        await expect(proveWindowsPackagedDeploymentRepairUi({ executeJavaScript }, { capture })).resolves.toEqual(repairProof());
        expect(capture.mock.calls.map(([stage]) => stage)).toEqual(PACKAGED_DEPLOYMENT_REPAIR_SCREENSHOT_STAGES);
        const entryScript = String(executeJavaScript.mock.calls[0]?.[0]);
        expect(entryScript).toContain('data-oaam-route="onboarding"');
        expect(entryScript).toContain("onboarding Set up later is unavailable");
        expect(entryScript).toContain('data-oaam-subject-choice="projects"');
        expect(entryScript).toContain("button[data-oaam-project-id]");
        expect(entryScript).toContain("projectSearch: for (const project of projectChoices)");
        expect(entryScript).not.toContain("multiple current Projects");
        expect(entryScript).toContain("selectedLibrary.dataset.oaamProjectId === projectId");
        expect(entryScript).toContain("expectedProjectId = projectId");
        expect(entryScript).toContain("open-deployments");
        expect(entryScript).toContain('data-oaam-subject="project"');
        expect(String(executeJavaScript.mock.calls[2]?.[0])).toContain("data-oaam-deployment-action");
        expect(executeJavaScript).toHaveBeenCalledTimes(8);
    });

    it("commits reverse through one renderer and recovers through a fresh renderer", async () => {
        const commitExecution = stagedExecution(reverseCommitExecutions());
        const commitCapture = vi.fn(async () => undefined);
        await expect(
            proveWindowsPackagedDeploymentReverseCommitUi({ executeJavaScript: commitExecution }, { capture: commitCapture }),
        ).resolves.toEqual(reverseCommitProof());
        expect(commitCapture.mock.calls.map(([stage]) => stage)).toEqual(PACKAGED_DEPLOYMENT_REVERSE_COMMIT_SCREENSHOT_STAGES);
        expect(String(commitExecution.mock.calls[8]?.[0])).toContain("oaamDeploymentPreview");
        expect(String(commitExecution.mock.calls[6]?.[0])).toContain("firstByGroup");
        expect(String(commitExecution.mock.calls[13]?.[0])).toContain("reverse.cancel");
        expect(String(commitExecution.mock.calls[19]?.[0])).toContain("firstByGroup");
        expect(String(commitExecution.mock.calls[21]?.[0])).toContain("reverse.commit");
        expect(commitExecution).toHaveBeenCalledTimes(23);

        const recoveryExecution = stagedExecution(reverseRecoveryExecutions());
        const recoveryCapture = vi.fn(async () => undefined);
        await expect(
            proveWindowsPackagedDeploymentReverseRecoveryUi(
                { executeJavaScript: recoveryExecution },
                { commitProof: reverseCommitProof(), capture: recoveryCapture },
            ),
        ).resolves.toEqual(reverseProof());
        expect(recoveryCapture.mock.calls.map(([stage]) => stage)).toEqual(
            PACKAGED_DEPLOYMENT_REVERSE_RECOVERY_SCREENSHOT_STAGES,
        );
        expect(String(recoveryExecution.mock.calls[2]?.[0])).toContain("fresh renderer");
        expect(String(recoveryExecution.mock.calls[3]?.[0])).toContain('"recover"');
        expect(String(recoveryExecution.mock.calls[3]?.[0])).toContain("action was not available");
        expect(recoveryExecution).toHaveBeenCalledTimes(5);
    });

    it("reattaches the terminal wait after renderer navigation without clicking the action twice", async () => {
        const executeJavaScript = vi.fn();
        executeJavaScript
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce("in_sync")
            .mockResolvedValueOnce(true)
            .mockRejectedValueOnce(new Error("Execution context was destroyed during navigation"))
            .mockResolvedValueOnce({ stage: "needs_repair" })
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce({ stage: "needs_repair", conflictCount: 1 })
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce({ stage: "in_sync", diagnosticCount: 2 });

        await expect(
            proveWindowsPackagedDeploymentRepairUi({ executeJavaScript }, { capture: vi.fn(async () => undefined) }),
        ).resolves.toEqual(repairProof());
        const scripts = executeJavaScript.mock.calls.map(([script]) => String(script));
        expect(scripts.filter((script) => script.includes('("scan"') && script.includes("action.click()"))).toHaveLength(1);
        expect(
            scripts.filter(
                (script) => script.includes('"scan missing target"') && script.includes("Object.entries(expectations)"),
            ),
        ).toHaveLength(2);
    });

    it("rejects false repair, preview, cancellation, commit, and recovery outcomes", async () => {
        const cases = [
            [3, null, "missing-target scan proof"],
            [3, { stage: "conflict" }, "missing target"],
            [5, { conflictCount: 0 }, "repair review count"],
            [7, { stage: "needs_repair" }, "repair did not restore"],
        ] as const;
        for (const [index, replacement, message] of cases) {
            const values = [...repairExecutions()];
            values[index] = replacement;
            await expect(
                proveWindowsPackagedDeploymentRepairUi(
                    { executeJavaScript: stagedExecution(values) },
                    { capture: vi.fn(async () => undefined) },
                ),
            ).rejects.toThrow(message);
        }

        const reverseCommitCases = [
            [6, false, "render selection"],
            [8, { preview: "ready:ready_apply" }, "managed-conflict"],
            [10, { changeCount: 0 }, "external-change inspection"],
            [12, { reverse: "failed" }, "preparation"],
            [14, { reverse: "none", message: "catalog.reverse.cancel_failed" }, "cancellation"],
            [19, false, "reverse render selection"],
            [22, { reverse: "result:not_committed" }, "commit"],
        ] as const;
        for (const [index, replacement, message] of reverseCommitCases) {
            const values = [...reverseCommitExecutions()];
            values[index] = replacement;
            await expect(
                proveWindowsPackagedDeploymentReverseCommitUi(
                    { executeJavaScript: stagedExecution(values) },
                    { capture: vi.fn(async () => undefined) },
                ),
            ).rejects.toThrow(message);
        }
        const recoveryCases = [
            [2, { stage: "in_sync" }, "durable reverse recovery"],
            [4, { stage: "needs_recovery" }, "recovery"],
        ] as const;
        for (const [index, replacement, message] of recoveryCases) {
            const values = [...reverseRecoveryExecutions()];
            values[index] = replacement;
            await expect(
                proveWindowsPackagedDeploymentReverseRecoveryUi(
                    { executeJavaScript: stagedExecution(values) },
                    { commitProof: reverseCommitProof(), capture: vi.fn(async () => undefined) },
                ),
            ).rejects.toThrow(message);
        }
        await expect(
            proveWindowsPackagedDeploymentReverseRecoveryUi(
                { executeJavaScript: stagedExecution(reverseRecoveryExecutions()) },
                { commitProof: { ...reverseCommitProof(), committed: false }, capture: vi.fn(async () => undefined) },
            ),
        ).rejects.toThrow("commit proof");
    });

    it("owns mutually exclusive switches and writes one immutable repair proof", async () => {
        expect(packagedWorkbenchProofMode(["--oaam-packaged-deployment-repair-ui-smoke"])).toBe("deployment_repair");
        expect(packagedWorkbenchProofMode(["--oaam-packaged-deployment-reverse-ui-smoke"])).toBe("deployment_reverse_commit");
        expect(packagedWorkbenchProofMode([PACKAGED_DEPLOYMENT_REVERSE_RECOVERY_UI_SMOKE_SWITCH])).toBe(
            "deployment_reverse_recovery",
        );
        expect(() =>
            packagedWorkbenchProofMode([
                "--oaam-packaged-deployment-repair-ui-smoke",
                PACKAGED_DEPLOYMENT_REVERSE_RECOVERY_UI_SMOKE_SWITCH,
            ]),
        ).toThrow("mutually exclusive");

        const parent = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-packaged-deployment-ui-runner-"));
        roots.push(parent);
        const writeOutput = vi.fn();
        const requestShutdown = vi.fn();
        expect(
            startPackagedWorkbenchProof({
                mode: "deployment_repair",
                platform: "win32",
                temporaryRootPath: parent,
                webContents: {
                    executeJavaScript: stagedExecution(repairExecutions()),
                    capturePage: vi.fn(async () => ({ toPNG: () => pngFixture() })),
                },
                writeOutput,
                writeError: vi.fn(),
                requestShutdown,
            }),
        ).toBe(true);
        await vi.waitFor(() => expect(requestShutdown).toHaveBeenCalledWith(false), { timeout: 5_000 });
        expect(writeOutput).toHaveBeenCalledWith(`${PACKAGED_DEPLOYMENT_REPAIR_UI_LINE}\n`);
        const proofRoot = path.join(parent, PACKAGED_DEPLOYMENT_REPAIR_SCREENSHOT_DIRECTORY);
        expect(fs.readdirSync(proofRoot).sort()).toEqual(
            [...PACKAGED_DEPLOYMENT_REPAIR_SCREENSHOT_STAGES.map((stage) => `${stage}.png`), "manifest.json"].sort(),
        );
        expect(JSON.parse(fs.readFileSync(path.join(proofRoot, PACKAGED_DEPLOYMENT_SCREENSHOT_MANIFEST), "utf8"))).toMatchObject({
            schemaVersion: 1,
            mode: "deployment_repair",
            proof: repairProof(),
        });
    });

    it("writes reverse commit evidence and resumes the same immutable root after restart", async () => {
        const parent = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-packaged-deployment-reverse-ui-runner-"));
        roots.push(parent);
        const commitOutput = vi.fn();
        const commitShutdown = vi.fn();
        expect(
            startPackagedWorkbenchProof({
                mode: "deployment_reverse_commit",
                platform: "win32",
                temporaryRootPath: parent,
                webContents: {
                    executeJavaScript: stagedExecution(reverseCommitExecutions()),
                    capturePage: vi.fn(async () => ({ toPNG: () => pngFixture() })),
                },
                writeOutput: commitOutput,
                writeError: vi.fn(),
                requestShutdown: commitShutdown,
            }),
        ).toBe(true);
        await vi.waitFor(() => expect(commitShutdown).toHaveBeenCalledWith(false), { timeout: 5_000 });
        expect(commitOutput).toHaveBeenCalledWith(`${PACKAGED_DEPLOYMENT_REVERSE_COMMIT_UI_LINE}\n`);
        const proofRoot = path.join(parent, PACKAGED_DEPLOYMENT_REVERSE_SCREENSHOT_DIRECTORY);
        expect(fs.readdirSync(proofRoot).sort()).toEqual(
            [
                ...PACKAGED_DEPLOYMENT_REVERSE_COMMIT_SCREENSHOT_STAGES.map((stage) => `${stage}.png`),
                PACKAGED_DEPLOYMENT_REVERSE_COMMIT_PROOF,
            ].sort(),
        );
        expect(JSON.parse(fs.readFileSync(path.join(proofRoot, PACKAGED_DEPLOYMENT_REVERSE_COMMIT_PROOF), "utf8"))).toEqual({
            schemaVersion: 1,
            mode: "deployment_reverse_commit",
            proof: reverseCommitProof(),
        });

        const recoveryOutput = vi.fn();
        const recoveryShutdown = vi.fn();
        expect(
            startPackagedWorkbenchProof({
                mode: "deployment_reverse_recovery",
                platform: "win32",
                temporaryRootPath: parent,
                webContents: {
                    executeJavaScript: stagedExecution(reverseRecoveryExecutions()),
                    capturePage: vi.fn(async () => ({ toPNG: () => pngFixture() })),
                },
                writeOutput: recoveryOutput,
                writeError: vi.fn(),
                requestShutdown: recoveryShutdown,
            }),
        ).toBe(true);
        await vi.waitFor(() => expect(recoveryShutdown).toHaveBeenCalledWith(false), { timeout: 5_000 });
        expect(recoveryOutput).toHaveBeenCalledWith(`${PACKAGED_DEPLOYMENT_REVERSE_UI_LINE}\n`);
        expect(fs.readdirSync(proofRoot).sort()).toEqual(
            [
                ...PACKAGED_DEPLOYMENT_REVERSE_SCREENSHOT_STAGES.map((stage) => `${stage}.png`),
                PACKAGED_DEPLOYMENT_REVERSE_COMMIT_PROOF,
                PACKAGED_DEPLOYMENT_SCREENSHOT_MANIFEST,
            ].sort(),
        );
        expect(JSON.parse(fs.readFileSync(path.join(proofRoot, PACKAGED_DEPLOYMENT_SCREENSHOT_MANIFEST), "utf8"))).toMatchObject({
            schemaVersion: 1,
            mode: "deployment_reverse",
            proof: reverseProof(),
        });
    });

    it("rejects malformed or weakened reverse continuation evidence before renderer recovery", async () => {
        const webContents = {
            executeJavaScript: vi.fn(),
            capturePage: vi.fn(async () => ({ toPNG: () => pngFixture() })),
        };
        const invalidPngRoot = createReverseContinuationRoot();
        fs.writeFileSync(
            path.join(invalidPngRoot, `${PACKAGED_DEPLOYMENT_REVERSE_COMMIT_SCREENSHOT_STAGES[0]}.png`),
            "not a PNG",
        );
        await expect(
            runPackagedDeploymentScreenshotProof("deployment_reverse_recovery", invalidPngRoot, webContents),
        ).rejects.toThrow("is not a PNG");

        const invalidEnvelopeRoot = createReverseContinuationRoot([]);
        await expect(
            runPackagedDeploymentScreenshotProof("deployment_reverse_recovery", invalidEnvelopeRoot, webContents),
        ).rejects.toThrow("invalid envelope");

        const invalidShapeRoot = createReverseContinuationRoot({
            schemaVersion: 1,
            mode: "deployment_reverse_commit",
            proof: null,
        });
        await expect(
            runPackagedDeploymentScreenshotProof("deployment_reverse_recovery", invalidShapeRoot, webContents),
        ).rejects.toThrow("invalid shape");

        const weakenedProofRoot = createReverseContinuationRoot({
            schemaVersion: 1,
            mode: "deployment_reverse_commit",
            proof: { ...reverseCommitProof(), committed: false },
        });
        await expect(
            runPackagedDeploymentScreenshotProof("deployment_reverse_recovery", weakenedProofRoot, webContents),
        ).rejects.toThrow("commit proof is invalid");

        const unexpectedEntryRoot = createReverseContinuationRoot();
        fs.writeFileSync(path.join(unexpectedEntryRoot, "unexpected.txt"), "not owned by the continuation");
        await expect(
            runPackagedDeploymentScreenshotProof("deployment_reverse_recovery", unexpectedEntryRoot, webContents),
        ).rejects.toThrow("unexpected entry");
        expect(webContents.executeJavaScript).not.toHaveBeenCalled();
        expect(webContents.capturePage).not.toHaveBeenCalled();
    });
});
