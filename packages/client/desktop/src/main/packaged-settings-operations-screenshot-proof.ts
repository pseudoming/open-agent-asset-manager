import fs from "node:fs";
import path from "node:path";
import {
    PACKAGED_SETTINGS_OPERATIONS_SCREENSHOT_STAGES,
    PACKAGED_SETTINGS_OPERATIONS_UI_LINE,
    type PackagedSettingsOperationsScreenshotStage,
    type PackagedSettingsOperationsUiProof,
    type PackagedSettingsOperationsUiWebContents,
    proveWindowsPackagedSettingsOperationsUi,
} from "./packaged-settings-operations-ui-smoke";

export const PACKAGED_SETTINGS_OPERATIONS_SCREENSHOT_MANIFEST = "manifest.json";

interface CapturedImage {
    toPNG(): Buffer;
}

export interface PackagedSettingsOperationsScreenshotWebContents {
    capturePage(): Promise<CapturedImage>;
}

function assertPng(stage: string, bytes: Buffer): void {
    if (bytes.byteLength < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        throw new Error(`packaged Settings operations screenshot ${stage} is not a PNG`);
    }
}

export class PackagedSettingsOperationsScreenshotProof {
    readonly #rootPath: string;
    readonly #captured = new Set<PackagedSettingsOperationsScreenshotStage>();

    private constructor(rootPath: string) {
        this.#rootPath = path.resolve(rootPath);
    }

    public static create(rootPath: string): PackagedSettingsOperationsScreenshotProof {
        const proof = new PackagedSettingsOperationsScreenshotProof(rootPath);
        fs.mkdirSync(proof.#rootPath);
        return proof;
    }

    public async capture(
        stage: PackagedSettingsOperationsScreenshotStage,
        webContents: PackagedSettingsOperationsScreenshotWebContents,
    ): Promise<void> {
        if (this.#captured.has(stage)) {
            throw new Error(`packaged Settings operations screenshot ${stage} was captured twice`);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 225));
        const png = (await webContents.capturePage()).toPNG();
        assertPng(stage, png);
        fs.writeFileSync(path.join(this.#rootPath, `${stage}.png`), png, { flag: "wx" });
        this.#captured.add(stage);
    }

    public finalize(proof: PackagedSettingsOperationsUiProof): void {
        const missing = PACKAGED_SETTINGS_OPERATIONS_SCREENSHOT_STAGES.filter((stage) => !this.#captured.has(stage));
        if (missing.length > 0) {
            throw new Error(`packaged Settings operations screenshots are incomplete: ${missing.join(",")}`);
        }
        fs.writeFileSync(
            path.join(this.#rootPath, PACKAGED_SETTINGS_OPERATIONS_SCREENSHOT_MANIFEST),
            `${JSON.stringify(
                {
                    schemaVersion: 1,
                    stages: PACKAGED_SETTINGS_OPERATIONS_SCREENSHOT_STAGES.map((stage) => ({
                        stage,
                        fileName: `${stage}.png`,
                    })),
                    proof,
                },
                null,
                2,
            )}\n`,
            { flag: "wx" },
        );
    }
}

export async function runPackagedSettingsOperationsScreenshotProof(
    proofRoot: string,
    webContents: PackagedSettingsOperationsUiWebContents & PackagedSettingsOperationsScreenshotWebContents,
): Promise<string> {
    const screenshots = PackagedSettingsOperationsScreenshotProof.create(proofRoot);
    const proof = await proveWindowsPackagedSettingsOperationsUi(webContents, {
        capture: (stage) => screenshots.capture(stage, webContents),
    });
    screenshots.finalize(proof);
    return PACKAGED_SETTINGS_OPERATIONS_UI_LINE;
}
