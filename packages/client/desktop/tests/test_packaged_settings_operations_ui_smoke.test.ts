import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    PACKAGED_SETTINGS_OPERATIONS_SCREENSHOT_MANIFEST,
    PackagedSettingsOperationsScreenshotProof,
} from "../src/main/packaged-settings-operations-screenshot-proof";
import {
    PACKAGED_SETTINGS_OPERATIONS_SCREENSHOT_DIRECTORY,
    PACKAGED_SETTINGS_OPERATIONS_SCREENSHOT_STAGES,
    PACKAGED_SETTINGS_OPERATIONS_UI_LINE,
    type PackagedSettingsOperationsUiProof,
    proveWindowsPackagedSettingsOperationsUi,
} from "../src/main/packaged-settings-operations-ui-smoke";
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

function settingsOperationsProof(): PackagedSettingsOperationsUiProof {
    return {
        status: "complete",
        ordinarySettingsEntry: true,
        state: {
            inventoryBefore: 3,
            availableBefore: 3,
            backupReviewed: true,
            backupCreated: true,
            inventoryAfter: 4,
            restoreReviewed: true,
            restoreActivationGuarded: true,
        },
        diagnostics: {
            healthStatus: "healthy",
            supportReviewed: true,
            supportEntryCount: 5,
            maintenanceLocationCount: 5,
        },
    };
}

function successfulExecutions(): readonly unknown[] {
    return [
        true,
        { inventoryBefore: 3, availableBefore: 3 },
        true,
        4,
        { restoreReviewed: true, restoreActivationGuarded: true },
        true,
        "healthy",
        5,
        true,
        5,
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

describe("packaged State, Diagnostics, and Maintenance UI smoke", () => {
    it("proves ordinary Settings, backup review/create, guarded restore review, diagnostics, and maintenance", async () => {
        const executeJavaScript = stagedExecution(successfulExecutions());
        const capture = vi.fn(async () => undefined);
        await expect(proveWindowsPackagedSettingsOperationsUi({ executeJavaScript }, { capture })).resolves.toEqual(
            settingsOperationsProof(),
        );
        expect(capture.mock.calls.map(([stage]) => stage)).toEqual(PACKAGED_SETTINGS_OPERATIONS_SCREENSHOT_STAGES);
        expect(executeJavaScript).toHaveBeenCalledTimes(10);
        const ordinarySettingsEntryScript = String(executeJavaScript.mock.calls[0]?.[0]);
        expect(ordinarySettingsEntryScript).toContain('data-oaam-route="onboarding"');
        expect(ordinarySettingsEntryScript).toContain(".onboarding-actions .library-secondary-button");
        expect(ordinarySettingsEntryScript).toContain("data-oaam-settings-category");
        expect(String(executeJavaScript.mock.calls[1]?.[0])).toContain("data-oaam-backup-entry");
        expect(String(executeJavaScript.mock.calls[2]?.[0])).toContain("backup.inspect");
        expect(String(executeJavaScript.mock.calls[3]?.[0])).toContain("backup.create");
        expect(String(executeJavaScript.mock.calls[4]?.[0])).toContain("activate.disabled");
        expect(String(executeJavaScript.mock.calls[6]?.[0])).toContain("oaamHealthStatus");
        expect(String(executeJavaScript.mock.calls[7]?.[0])).toContain("data-oaam-support-review");
        expect(String(executeJavaScript.mock.calls[9]?.[0])).toContain("oaamMaintenanceLocationCount");
    });

    it("rejects missing State authority, unguarded restore, unhealthy diagnostics, and empty maintenance", async () => {
        const cases = [
            [1, { inventoryBefore: 3, availableBefore: 0 }, "State inventory"],
            [3, 3, "State backup creation"],
            [4, { restoreReviewed: true, restoreActivationGuarded: false }, "State restore review"],
            [6, "degraded", "Diagnostics health"],
            [7, 0, "support-bundle review"],
            [9, 0, "Maintenance"],
        ] as const;
        for (const [index, replacement, message] of cases) {
            const values = [...successfulExecutions()];
            values[index] = replacement;
            await expect(
                proveWindowsPackagedSettingsOperationsUi(
                    { executeJavaScript: stagedExecution(values) },
                    { capture: vi.fn(async () => undefined) },
                ),
            ).rejects.toThrow(message);
        }
    });

    it("owns the mutually exclusive packaged switch, immutable screenshots, and shutdown result", async () => {
        expect(packagedWorkbenchProofMode(["--oaam-packaged-settings-operations-ui-smoke"])).toBe("settings_operations");
        expect(() =>
            packagedWorkbenchProofMode(["--oaam-packaged-library-ui-smoke", "--oaam-packaged-settings-operations-ui-smoke"]),
        ).toThrow("mutually exclusive");

        const parent = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-packaged-settings-operations-runner-"));
        roots.push(parent);
        const writeOutput = vi.fn();
        const writeError = vi.fn();
        const requestShutdown = vi.fn();
        expect(
            startPackagedWorkbenchProof({
                mode: "settings_operations",
                platform: "win32",
                temporaryRootPath: parent,
                webContents: {
                    executeJavaScript: stagedExecution(successfulExecutions()),
                    capturePage: vi.fn(async () => ({ toPNG: () => pngFixture() })),
                },
                writeOutput,
                writeError,
                requestShutdown,
            }),
        ).toBe(true);
        await vi.waitFor(() => expect(requestShutdown).toHaveBeenCalledWith(false), { timeout: 5_000 });
        expect(writeOutput).toHaveBeenCalledWith(`${PACKAGED_SETTINGS_OPERATIONS_UI_LINE}\n`);
        expect(writeError).not.toHaveBeenCalled();
        expect(
            fs.existsSync(
                path.join(
                    parent,
                    PACKAGED_SETTINGS_OPERATIONS_SCREENSHOT_DIRECTORY,
                    PACKAGED_SETTINGS_OPERATIONS_SCREENSHOT_MANIFEST,
                ),
            ),
        ).toBe(true);
    });

    it("rejects non-PNG, duplicate, and incomplete Settings-operation screenshot evidence", async () => {
        const parent = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-packaged-settings-operations-screenshots-"));
        roots.push(parent);
        const invalidRoot = path.join(parent, "invalid");
        const invalid = PackagedSettingsOperationsScreenshotProof.create(invalidRoot);
        await expect(
            invalid.capture("state-inventory", {
                capturePage: vi.fn(async () => ({ toPNG: () => Buffer.alloc(24) })),
            }),
        ).rejects.toThrow("is not a PNG");
        expect(() => invalid.finalize(settingsOperationsProof())).toThrow("screenshots are incomplete");

        const proofRoot = path.join(parent, "complete");
        const proof = PackagedSettingsOperationsScreenshotProof.create(proofRoot);
        const capturePage = vi.fn(async () => ({ toPNG: () => pngFixture() }));
        for (const stage of PACKAGED_SETTINGS_OPERATIONS_SCREENSHOT_STAGES) {
            await proof.capture(stage, { capturePage });
        }
        await expect(proof.capture("state-inventory", { capturePage })).rejects.toThrow("was captured twice");
        proof.finalize(settingsOperationsProof());
        expect(fs.readdirSync(proofRoot).sort()).toEqual(
            [...PACKAGED_SETTINGS_OPERATIONS_SCREENSHOT_STAGES.map((stage) => `${stage}.png`), "manifest.json"].sort(),
        );
        expect(JSON.parse(fs.readFileSync(path.join(proofRoot, "manifest.json"), "utf8"))).toMatchObject({
            schemaVersion: 1,
            proof: settingsOperationsProof(),
        });
    });
});
