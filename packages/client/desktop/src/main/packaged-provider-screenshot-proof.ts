import fs from "node:fs";
import path from "node:path";

interface CapturedImage {
    toPNG(): Buffer;
}

export interface PackagedProviderScreenshotWebContents {
    capturePage(): Promise<CapturedImage>;
}

export class PackagedProviderScreenshotProof<Stage extends string, Proof> {
    readonly #rootPath: string;
    readonly #stages: readonly Stage[];
    readonly #label: string;
    readonly #captured = new Set<Stage>();

    public constructor(rootPath: string, stages: readonly Stage[], label: string) {
        this.#rootPath = path.resolve(rootPath);
        this.#stages = stages;
        this.#label = label;
        fs.mkdirSync(this.#rootPath);
    }

    public async capture(
        stage: Stage,
        webContents: PackagedProviderScreenshotWebContents,
        settleMilliseconds = 225,
    ): Promise<void> {
        if (this.#captured.has(stage)) throw new Error(`packaged ${this.#label} screenshot ${stage} was captured twice`);
        if (settleMilliseconds > 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, settleMilliseconds));
        }
        const png = (await webContents.capturePage()).toPNG();
        if (png.byteLength < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
            throw new Error(`packaged ${this.#label} screenshot ${stage} is not a PNG`);
        }
        fs.writeFileSync(path.join(this.#rootPath, `${stage}.png`), png, { flag: "wx" });
        this.#captured.add(stage);
    }

    public recordAuthorityChange(value: unknown): void {
        fs.writeFileSync(path.join(this.#rootPath, "authority-change.json"), `${JSON.stringify(value)}\n`, { flag: "wx" });
    }

    protected writeBoundedEvidence(fileName: string, value: unknown, maximumBytes: number): void {
        const encoded = `${JSON.stringify(value, null, 2)}\n`;
        if (Buffer.byteLength(encoded, "utf8") > maximumBytes) throw new Error(`packaged ${this.#label} evidence is oversized`);
        fs.writeFileSync(path.join(this.#rootPath, fileName), encoded, { flag: "wx" });
    }

    public finalize(proof: Proof): void {
        const missing = this.#stages.filter((stage) => !this.#captured.has(stage));
        if (missing.length > 0) throw new Error(`packaged ${this.#label} screenshots are incomplete: ${missing.join(",")}`);
        fs.writeFileSync(
            path.join(this.#rootPath, "manifest.json"),
            `${JSON.stringify(
                { schemaVersion: 1, stages: this.#stages.map((stage) => ({ stage, fileName: `${stage}.png` })), proof },
                null,
                2,
            )}\n`,
            { flag: "wx" },
        );
    }
}
