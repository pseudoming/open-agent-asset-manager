import fs from "node:fs";
import path from "node:path";
import {
    PACKAGED_DEPLOYMENT_REPAIR_SCREENSHOT_STAGES,
    PACKAGED_DEPLOYMENT_REPAIR_UI_LINE,
    PACKAGED_DEPLOYMENT_REVERSE_COMMIT_SCREENSHOT_STAGES,
    PACKAGED_DEPLOYMENT_REVERSE_COMMIT_UI_LINE,
    PACKAGED_DEPLOYMENT_REVERSE_RECOVERY_SCREENSHOT_STAGES,
    PACKAGED_DEPLOYMENT_REVERSE_SCREENSHOT_STAGES,
    PACKAGED_DEPLOYMENT_REVERSE_UI_LINE,
    type PackagedDeploymentRepairScreenshotStage,
    type PackagedDeploymentRepairUiProof,
    type PackagedDeploymentReverseCommitScreenshotStage,
    type PackagedDeploymentReverseCommitUiProof,
    type PackagedDeploymentReverseRecoveryScreenshotStage,
    type PackagedDeploymentReverseScreenshotStage,
    type PackagedDeploymentReverseUiProof,
    type PackagedDeploymentUiMode,
    type PackagedDeploymentUiWebContents,
    proveWindowsPackagedDeploymentRepairUi,
    proveWindowsPackagedDeploymentReverseCommitUi,
    proveWindowsPackagedDeploymentReverseRecoveryUi,
} from "./packaged-deployment-operations-ui-smoke";

export {
    proveWindowsPackagedDeploymentRepairUi,
    proveWindowsPackagedDeploymentReverseCommitUi,
    proveWindowsPackagedDeploymentReverseRecoveryUi,
} from "./packaged-deployment-operations-ui-smoke";

export const PACKAGED_DEPLOYMENT_REVERSE_COMMIT_PROOF = "commit.json";
export const PACKAGED_DEPLOYMENT_SCREENSHOT_MANIFEST = "manifest.json";

interface CapturedImage {
    toPNG(): Buffer;
}

export interface PackagedDeploymentScreenshotWebContents {
    capturePage(): Promise<CapturedImage>;
}

type DeploymentStage = PackagedDeploymentRepairScreenshotStage | PackagedDeploymentReverseScreenshotStage;

function captureStagesForMode(mode: PackagedDeploymentUiMode): readonly DeploymentStage[] {
    switch (mode) {
        case "deployment_repair":
            return PACKAGED_DEPLOYMENT_REPAIR_SCREENSHOT_STAGES;
        case "deployment_reverse_commit":
            return PACKAGED_DEPLOYMENT_REVERSE_COMMIT_SCREENSHOT_STAGES;
        case "deployment_reverse_recovery":
            return PACKAGED_DEPLOYMENT_REVERSE_RECOVERY_SCREENSHOT_STAGES;
    }
}

function assertPng(stage: DeploymentStage, bytes: Buffer): void {
    if (bytes.byteLength < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        throw new Error(`packaged Deployment screenshot ${stage} is not a PNG`);
    }
}

function assertDirectDirectory(rootPath: string): void {
    const stat = fs.lstatSync(rootPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("packaged Deployment screenshot root is not a direct directory");
    }
}

function exactObjectKeys(value: object, keys: readonly string[]): boolean {
    const actual = Object.keys(value).sort((left, right) => left.localeCompare(right));
    const expected = [...keys].sort((left, right) => left.localeCompare(right));
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseCommitProof(rootPath: string): PackagedDeploymentReverseCommitUiProof {
    const commitPath = path.join(rootPath, PACKAGED_DEPLOYMENT_REVERSE_COMMIT_PROOF);
    const envelope = JSON.parse(fs.readFileSync(commitPath, "utf8")) as unknown;
    if (
        typeof envelope !== "object" ||
        envelope === null ||
        Array.isArray(envelope) ||
        !exactObjectKeys(envelope, ["mode", "proof", "schemaVersion"])
    ) {
        throw new Error("packaged Deployment reverse commit proof has an invalid envelope");
    }
    const record = envelope as Record<string, unknown>;
    const value = record.proof;
    if (
        record.schemaVersion !== 1 ||
        record.mode !== "deployment_reverse_commit" ||
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        !exactObjectKeys(value, [
            "cancelled",
            "changeCount",
            "committed",
            "mode",
            "ordinaryEntry",
            "prepared",
            "prewriteAction",
            "status",
        ])
    ) {
        throw new Error("packaged Deployment reverse commit proof has an invalid shape");
    }
    const proof = value as Record<string, unknown>;
    if (
        proof.status !== "pending_restart" ||
        proof.mode !== "reverse" ||
        proof.ordinaryEntry !== true ||
        proof.prewriteAction !== "blocked_managed_conflict" ||
        !Number.isSafeInteger(proof.changeCount) ||
        (proof.changeCount as number) < 1 ||
        proof.prepared !== true ||
        proof.cancelled !== true ||
        proof.committed !== true
    ) {
        throw new Error("packaged Deployment reverse commit proof is invalid");
    }
    return Object.freeze(proof as unknown as PackagedDeploymentReverseCommitUiProof);
}

class PackagedDeploymentScreenshotProof {
    readonly #mode: PackagedDeploymentUiMode;
    readonly #rootPath: string;
    readonly #captured = new Set<DeploymentStage>();
    readonly #commitProof: PackagedDeploymentReverseCommitUiProof | undefined;

    private constructor(mode: PackagedDeploymentUiMode, rootPath: string, commitProof?: PackagedDeploymentReverseCommitUiProof) {
        this.#mode = mode;
        this.#rootPath = path.resolve(rootPath);
        this.#commitProof = commitProof;
    }

    public static create(
        mode: "deployment_repair" | "deployment_reverse_commit",
        rootPath: string,
    ): PackagedDeploymentScreenshotProof {
        const proof = new PackagedDeploymentScreenshotProof(mode, rootPath);
        fs.mkdirSync(proof.#rootPath);
        return proof;
    }

    public static resumeReverse(rootPath: string): PackagedDeploymentScreenshotProof {
        const resolvedRoot = path.resolve(rootPath);
        assertDirectDirectory(resolvedRoot);
        const expectedNames = [
            ...PACKAGED_DEPLOYMENT_REVERSE_COMMIT_SCREENSHOT_STAGES.map((stage) => `${stage}.png`),
            PACKAGED_DEPLOYMENT_REVERSE_COMMIT_PROOF,
        ].sort((left, right) => left.localeCompare(right));
        const entries = fs
            .readdirSync(resolvedRoot, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name));
        if (
            entries.length !== expectedNames.length ||
            entries.some((entry, index) => entry.name !== expectedNames[index] || entry.isSymbolicLink() || !entry.isFile())
        ) {
            throw new Error("packaged Deployment reverse continuation inventory is incomplete or contains an unexpected entry");
        }
        for (const stage of PACKAGED_DEPLOYMENT_REVERSE_COMMIT_SCREENSHOT_STAGES) {
            assertPng(stage, fs.readFileSync(path.join(resolvedRoot, `${stage}.png`)));
        }
        const commitProof = parseCommitProof(resolvedRoot);
        const proof = new PackagedDeploymentScreenshotProof("deployment_reverse_recovery", resolvedRoot, commitProof);
        for (const stage of PACKAGED_DEPLOYMENT_REVERSE_COMMIT_SCREENSHOT_STAGES) proof.#captured.add(stage);
        return proof;
    }

    public commitProof(): PackagedDeploymentReverseCommitUiProof {
        if (this.#mode !== "deployment_reverse_recovery" || this.#commitProof === undefined) {
            throw new Error("packaged Deployment reverse continuation has no commit proof");
        }
        return this.#commitProof;
    }

    public async capture(stage: DeploymentStage, webContents: PackagedDeploymentScreenshotWebContents): Promise<void> {
        if (!captureStagesForMode(this.#mode).includes(stage)) {
            throw new Error(`packaged Deployment screenshot ${stage} does not belong to ${this.#mode}`);
        }
        if (this.#captured.has(stage)) throw new Error(`packaged Deployment screenshot ${stage} was captured twice`);
        await new Promise<void>((resolve) => setTimeout(resolve, 225));
        const png = (await webContents.capturePage()).toPNG();
        assertPng(stage, png);
        fs.writeFileSync(path.join(this.#rootPath, `${stage}.png`), png, { flag: "wx" });
        this.#captured.add(stage);
    }

    public finalizeRepair(proof: PackagedDeploymentRepairUiProof): void {
        this.#assertComplete(PACKAGED_DEPLOYMENT_REPAIR_SCREENSHOT_STAGES);
        this.#writeManifest("deployment_repair", PACKAGED_DEPLOYMENT_REPAIR_SCREENSHOT_STAGES, proof);
    }

    public recordReverseCommit(proof: PackagedDeploymentReverseCommitUiProof): void {
        this.#assertComplete(PACKAGED_DEPLOYMENT_REVERSE_COMMIT_SCREENSHOT_STAGES);
        fs.writeFileSync(
            path.join(this.#rootPath, PACKAGED_DEPLOYMENT_REVERSE_COMMIT_PROOF),
            `${JSON.stringify({ schemaVersion: 1, mode: "deployment_reverse_commit", proof }, null, 2)}\n`,
            { flag: "wx" },
        );
    }

    public finalizeReverse(proof: PackagedDeploymentReverseUiProof): void {
        this.#assertComplete(PACKAGED_DEPLOYMENT_REVERSE_SCREENSHOT_STAGES);
        this.#writeManifest("deployment_reverse", PACKAGED_DEPLOYMENT_REVERSE_SCREENSHOT_STAGES, proof);
    }

    #assertComplete(stages: readonly DeploymentStage[]): void {
        const missing = stages.filter((stage) => !this.#captured.has(stage));
        if (missing.length > 0) throw new Error(`packaged Deployment screenshots are incomplete: ${missing.join(",")}`);
    }

    #writeManifest(
        mode: "deployment_repair" | "deployment_reverse",
        stages: readonly DeploymentStage[],
        proof: PackagedDeploymentRepairUiProof | PackagedDeploymentReverseUiProof,
    ): void {
        fs.writeFileSync(
            path.join(this.#rootPath, PACKAGED_DEPLOYMENT_SCREENSHOT_MANIFEST),
            `${JSON.stringify(
                {
                    schemaVersion: 1,
                    mode,
                    stages: stages.map((stage) => ({ stage, fileName: `${stage}.png` })),
                    proof,
                },
                null,
                2,
            )}\n`,
            { flag: "wx" },
        );
    }
}

export async function runPackagedDeploymentScreenshotProof(
    mode: PackagedDeploymentUiMode,
    proofRoot: string,
    webContents: PackagedDeploymentUiWebContents & PackagedDeploymentScreenshotWebContents,
): Promise<string> {
    if (mode === "deployment_repair") {
        const screenshots = PackagedDeploymentScreenshotProof.create(mode, proofRoot);
        const proof = await proveWindowsPackagedDeploymentRepairUi(webContents, {
            capture: (stage) => screenshots.capture(stage, webContents),
        });
        screenshots.finalizeRepair(proof);
        return PACKAGED_DEPLOYMENT_REPAIR_UI_LINE;
    }
    if (mode === "deployment_reverse_commit") {
        const screenshots = PackagedDeploymentScreenshotProof.create(mode, proofRoot);
        const proof = await proveWindowsPackagedDeploymentReverseCommitUi(webContents, {
            capture: (stage: PackagedDeploymentReverseCommitScreenshotStage) => screenshots.capture(stage, webContents),
        });
        screenshots.recordReverseCommit(proof);
        return PACKAGED_DEPLOYMENT_REVERSE_COMMIT_UI_LINE;
    }
    const screenshots = PackagedDeploymentScreenshotProof.resumeReverse(proofRoot);
    const proof = await proveWindowsPackagedDeploymentReverseRecoveryUi(webContents, {
        commitProof: screenshots.commitProof(),
        capture: (stage: PackagedDeploymentReverseRecoveryScreenshotStage) => screenshots.capture(stage, webContents),
    });
    screenshots.finalizeReverse(proof);
    return PACKAGED_DEPLOYMENT_REVERSE_UI_LINE;
}
