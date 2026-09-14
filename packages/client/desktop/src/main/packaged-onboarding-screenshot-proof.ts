import fs from "node:fs";
import path from "node:path";
import type {
    PackagedAssetUsageAuthorityChangeReceipt,
    PackagedAssetUsageProofTerminalReceipt,
} from "./packaged-asset-usage-ui-smoke";
import {
    PACKAGED_ONBOARDING_SCREENSHOT_STAGES,
    type PackagedOnboardingScreenshotStage,
    type PackagedOnboardingUiProof,
} from "./packaged-onboarding-ui-smoke";

export const PACKAGED_ONBOARDING_SCREENSHOT_MANIFEST = "manifest.json";
export const PACKAGED_ASSET_USAGE_AUTHORITY_CHANGE_RECEIPT = "asset-usage-authority-change.json";
export const PACKAGED_ASSET_USAGE_TERMINAL_OBSERVATION_RECEIPT = "asset-usage-terminal-observation.json";

const UNKNOWN_VIZ_ERROR_MESSAGE = "UnknownVizError";
const UNKNOWN_VIZ_ERROR_CAPTURE_ATTEMPT_LIMIT = 4;
const UNKNOWN_VIZ_ERROR_RETRY_DELAY_MILLISECONDS = 125;

interface CapturedImage {
    toPNG(): Buffer;
}

export interface PackagedOnboardingScreenshotWebContents {
    capturePage(): Promise<CapturedImage>;
}

function isExactUnknownVizError(error: unknown): error is Error {
    return (
        error instanceof Error &&
        error.constructor === Error &&
        error.name === "Error" &&
        error.message === UNKNOWN_VIZ_ERROR_MESSAGE
    );
}

async function capturePageWithBoundedUnknownVizRetry(
    webContents: PackagedOnboardingScreenshotWebContents,
): Promise<CapturedImage> {
    let attempt = 0;
    for (;;) {
        attempt += 1;
        try {
            return await webContents.capturePage();
        } catch (error) {
            if (!isExactUnknownVizError(error) || attempt >= UNKNOWN_VIZ_ERROR_CAPTURE_ATTEMPT_LIMIT) throw error;
            await new Promise<void>((resolve) => setTimeout(resolve, UNKNOWN_VIZ_ERROR_RETRY_DELAY_MILLISECONDS));
        }
    }
}

export class PackagedOnboardingScreenshotProof {
    readonly #rootPath: string;
    readonly #captured = new Set<PackagedOnboardingScreenshotStage>();

    public constructor(rootPath: string) {
        this.#rootPath = path.resolve(rootPath);
        fs.mkdirSync(this.#rootPath);
    }

    public async capture(
        stage: PackagedOnboardingScreenshotStage,
        webContents: PackagedOnboardingScreenshotWebContents,
    ): Promise<void> {
        if (this.#captured.has(stage)) throw new Error(`packaged onboarding screenshot ${stage} was captured twice`);
        await new Promise<void>((resolve) => setTimeout(resolve, 225));
        const png = (await capturePageWithBoundedUnknownVizRetry(webContents)).toPNG();
        if (png.byteLength < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
            throw new Error(`packaged onboarding screenshot ${stage} is not a PNG`);
        }
        fs.writeFileSync(path.join(this.#rootPath, `${stage}.png`), png, { flag: "wx" });
        this.#captured.add(stage);
    }

    public recordAssetUsageAuthorityChange(receipt: PackagedAssetUsageAuthorityChangeReceipt): void {
        fs.writeFileSync(
            path.join(this.#rootPath, PACKAGED_ASSET_USAGE_AUTHORITY_CHANGE_RECEIPT),
            `${JSON.stringify(receipt, null, 2)}\n`,
            { flag: "wx" },
        );
    }

    public recordAssetUsageTerminalObservation(receipt: PackagedAssetUsageProofTerminalReceipt): void {
        fs.writeFileSync(
            path.join(this.#rootPath, PACKAGED_ASSET_USAGE_TERMINAL_OBSERVATION_RECEIPT),
            `${JSON.stringify(receipt, null, 2)}\n`,
            { flag: "wx" },
        );
    }

    public finalize(proof: PackagedOnboardingUiProof): void {
        const missing = PACKAGED_ONBOARDING_SCREENSHOT_STAGES.filter((stage) => !this.#captured.has(stage));
        if (missing.length > 0) throw new Error(`packaged onboarding screenshots are incomplete: ${missing.join(",")}`);
        fs.writeFileSync(
            path.join(this.#rootPath, PACKAGED_ONBOARDING_SCREENSHOT_MANIFEST),
            `${JSON.stringify(
                {
                    schemaVersion: 10,
                    stages: PACKAGED_ONBOARDING_SCREENSHOT_STAGES.map((stage) => ({
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
