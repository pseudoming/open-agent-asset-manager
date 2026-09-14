import fs from "node:fs";
import path from "node:path";
import type { PackagedProofSubjectIdentity } from "../bridge/desktop-bridge";
import { runPackagedDeploymentScreenshotProof } from "./packaged-deployment-operations-screenshot-proof";
import {
    PACKAGED_DEPLOYMENT_REPAIR_SCREENSHOT_DIRECTORY,
    PACKAGED_DEPLOYMENT_REPAIR_UI_SMOKE_SWITCH,
    PACKAGED_DEPLOYMENT_REVERSE_RECOVERY_UI_SMOKE_SWITCH,
    PACKAGED_DEPLOYMENT_REVERSE_SCREENSHOT_DIRECTORY,
    PACKAGED_DEPLOYMENT_REVERSE_UI_SMOKE_SWITCH,
} from "./packaged-deployment-operations-ui-smoke";
import { type PackagedProofLaunchAuthorization, readPackagedProofFixtureSubjects } from "./packaged-proof-launch-authority";
import { runPackagedSettingsOperationsScreenshotProof } from "./packaged-settings-operations-screenshot-proof";
import {
    PACKAGED_SETTINGS_OPERATIONS_SCREENSHOT_DIRECTORY,
    PACKAGED_SETTINGS_OPERATIONS_UI_SMOKE_SWITCH,
} from "./packaged-settings-operations-ui-smoke";
import {
    PACKAGED_LIBRARY_SCREENSHOT_DIRECTORY,
    PACKAGED_LIBRARY_SCREENSHOT_STAGES,
    PACKAGED_LIBRARY_UI_LINE,
    PACKAGED_LIBRARY_UI_SMOKE_SWITCH,
    PACKAGED_WORKBENCH_JOURNEY_SCREENSHOT_STAGES,
    PACKAGED_WORKBENCH_PERSISTENCE_LINE,
    PACKAGED_WORKBENCH_PERSISTENCE_SCREENSHOT_STAGE,
    PACKAGED_WORKBENCH_PERSISTENCE_SMOKE_SWITCH,
    PACKAGED_WORKBENCH_SCREENSHOT_DIRECTORY,
    PACKAGED_WORKBENCH_SCREENSHOT_STAGES,
    PACKAGED_WORKBENCH_UI_LINE,
    PACKAGED_WORKBENCH_UI_SMOKE_SWITCH,
    type PackagedLibraryScreenshotStage,
    type PackagedLibraryUiProof,
    type PackagedWorkbenchPersistenceProof,
    type PackagedWorkbenchScreenshotStage,
    type PackagedWorkbenchUiProof,
    type PackagedWorkbenchUiSmokeWebContents,
    proveWindowsPackagedLibraryUi,
    proveWindowsPackagedWorkbenchPersistence,
    proveWindowsPackagedWorkbenchUi,
} from "./packaged-workbench-ui-smoke";

export const PACKAGED_WORKBENCH_JOURNEY_PROOF_FILE = "journey.json";
export const PACKAGED_WORKBENCH_SCREENSHOT_MANIFEST = "manifest.json";

interface CapturedImage {
    toPNG(): Buffer;
}

export interface PackagedWorkbenchScreenshotWebContents {
    capturePage(): Promise<CapturedImage>;
}

export type PackagedWorkbenchProofMode =
    | "journey"
    | "library"
    | "persistence"
    | "settings_operations"
    | "deployment_repair"
    | "deployment_reverse_commit"
    | "deployment_reverse_recovery";

interface StartPackagedWorkbenchProofOptions {
    readonly mode: PackagedWorkbenchProofMode | undefined;
    readonly platform: NodeJS.Platform;
    readonly temporaryRootPath: string;
    readonly webContents: PackagedWorkbenchUiSmokeWebContents & PackagedWorkbenchScreenshotWebContents;
    readonly writeOutput: (text: string) => void;
    readonly writeError: (text: string) => void;
    readonly requestShutdown: (failed: boolean) => void;
    readonly librarySubject?: PackagedProofSubjectIdentity;
    readonly runProof?: (
        mode: PackagedWorkbenchProofMode,
        proofRoot: string,
        webContents: PackagedWorkbenchUiSmokeWebContents & PackagedWorkbenchScreenshotWebContents,
        librarySubject: PackagedProofSubjectIdentity | undefined,
    ) => Promise<string>;
}

function assertPng(stage: string, bytes: Buffer): void {
    if (bytes.byteLength < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        throw new Error(`packaged workbench screenshot ${stage} is not a PNG`);
    }
}

export function packagedWorkbenchProofMode(argv: readonly string[]): PackagedWorkbenchProofMode | undefined {
    const journey = argv.includes(PACKAGED_WORKBENCH_UI_SMOKE_SWITCH);
    const library = argv.includes(PACKAGED_LIBRARY_UI_SMOKE_SWITCH);
    const persistence = argv.includes(PACKAGED_WORKBENCH_PERSISTENCE_SMOKE_SWITCH);
    const settingsOperations = argv.includes(PACKAGED_SETTINGS_OPERATIONS_UI_SMOKE_SWITCH);
    const deploymentRepair = argv.includes(PACKAGED_DEPLOYMENT_REPAIR_UI_SMOKE_SWITCH);
    const deploymentReverseCommit = argv.includes(PACKAGED_DEPLOYMENT_REVERSE_UI_SMOKE_SWITCH);
    const deploymentReverseRecovery = argv.includes(PACKAGED_DEPLOYMENT_REVERSE_RECOVERY_UI_SMOKE_SWITCH);
    if (
        [
            journey,
            library,
            persistence,
            settingsOperations,
            deploymentRepair,
            deploymentReverseCommit,
            deploymentReverseRecovery,
        ].filter(Boolean).length > 1
    ) {
        throw new TypeError("Packaged workbench proof switches are mutually exclusive");
    }
    return journey
        ? "journey"
        : library
          ? "library"
          : persistence
            ? "persistence"
            : settingsOperations
              ? "settings_operations"
              : deploymentRepair
                ? "deployment_repair"
                : deploymentReverseCommit
                  ? "deployment_reverse_commit"
                  : deploymentReverseRecovery
                    ? "deployment_reverse_recovery"
                    : undefined;
}

export function packagedLibraryProofSubject(
    mode: PackagedWorkbenchProofMode | undefined,
    authorization: PackagedProofLaunchAuthorization | undefined,
): PackagedProofSubjectIdentity | undefined {
    return mode === "library" && authorization !== undefined ? readPackagedProofFixtureSubjects(authorization).target : undefined;
}

async function runPackagedWorkbenchProof(
    mode: PackagedWorkbenchProofMode,
    proofRoot: string,
    webContents: PackagedWorkbenchUiSmokeWebContents & PackagedWorkbenchScreenshotWebContents,
    librarySubject: PackagedProofSubjectIdentity | undefined,
): Promise<string> {
    if (mode === "journey") {
        const screenshots = PackagedWorkbenchScreenshotProof.create(proofRoot);
        const proof = await proveWindowsPackagedWorkbenchUi(webContents, {
            capture: (stage) => screenshots.capture(stage, webContents),
        });
        screenshots.recordJourney(proof);
        return PACKAGED_WORKBENCH_UI_LINE;
    }
    if (mode === "library") {
        if (librarySubject === undefined) throw new Error("packaged library proof has no exact fixture subject");
        const screenshots = PackagedLibraryScreenshotProof.create(proofRoot);
        const proof = await proveWindowsPackagedLibraryUi(webContents, {
            capture: (stage) => screenshots.capture(stage, webContents),
            subject: librarySubject,
        });
        screenshots.finalize(proof);
        return PACKAGED_LIBRARY_UI_LINE;
    }
    if (mode === "settings_operations") {
        return runPackagedSettingsOperationsScreenshotProof(proofRoot, webContents);
    }
    if (mode === "deployment_repair" || mode === "deployment_reverse_commit" || mode === "deployment_reverse_recovery") {
        return runPackagedDeploymentScreenshotProof(mode, proofRoot, webContents);
    }
    const screenshots = PackagedWorkbenchScreenshotProof.resume(proofRoot);
    const proof = await proveWindowsPackagedWorkbenchPersistence(webContents, {
        capture: (stage) => screenshots.capture(stage, webContents),
    });
    screenshots.finalize(proof);
    return PACKAGED_WORKBENCH_PERSISTENCE_LINE;
}

export function startPackagedWorkbenchProof(options: StartPackagedWorkbenchProofOptions): boolean {
    if (options.mode === undefined) return false;
    if (options.platform !== "win32") {
        options.writeError("OAAM_DESKTOP_WORKBENCH_UI_SMOKE failed=unsupported_platform\n");
        options.requestShutdown(true);
        return true;
    }
    if (options.mode === "library" && options.librarySubject === undefined) {
        options.writeError("OAAM_DESKTOP_WORKBENCH_UI_SMOKE failed=missing_library_subject\n");
        options.requestShutdown(true);
        return true;
    }
    const proofRoot = path.join(
        options.temporaryRootPath,
        options.mode === "library"
            ? PACKAGED_LIBRARY_SCREENSHOT_DIRECTORY
            : options.mode === "settings_operations"
              ? PACKAGED_SETTINGS_OPERATIONS_SCREENSHOT_DIRECTORY
              : options.mode === "deployment_repair"
                ? PACKAGED_DEPLOYMENT_REPAIR_SCREENSHOT_DIRECTORY
                : options.mode === "deployment_reverse_commit" || options.mode === "deployment_reverse_recovery"
                  ? PACKAGED_DEPLOYMENT_REVERSE_SCREENSHOT_DIRECTORY
                  : PACKAGED_WORKBENCH_SCREENSHOT_DIRECTORY,
    );
    void (options.runProof ?? runPackagedWorkbenchProof)(
        options.mode,
        proofRoot,
        options.webContents,
        options.librarySubject,
    ).then(
        (line) => {
            options.writeOutput(`${line}\n`);
            options.requestShutdown(false);
        },
        (error) => {
            options.writeError(
                `OAAM_DESKTOP_WORKBENCH_UI_SMOKE failed=proof detail=${error instanceof Error ? error.message : String(error)}\n`,
            );
            options.requestShutdown(true);
        },
    );
    return true;
}

function assertDirectDirectory(rootPath: string): void {
    const stat = fs.lstatSync(rootPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("packaged workbench screenshot root is not a direct directory");
    }
}

export class PackagedWorkbenchScreenshotProof {
    readonly #rootPath: string;
    readonly #captured = new Set<PackagedWorkbenchScreenshotStage>();

    private constructor(rootPath: string) {
        this.#rootPath = path.resolve(rootPath);
    }

    public static create(rootPath: string): PackagedWorkbenchScreenshotProof {
        const proof = new PackagedWorkbenchScreenshotProof(rootPath);
        fs.mkdirSync(proof.#rootPath);
        return proof;
    }

    public static resume(rootPath: string): PackagedWorkbenchScreenshotProof {
        const proof = new PackagedWorkbenchScreenshotProof(rootPath);
        assertDirectDirectory(proof.#rootPath);
        const expectedNames = [
            ...PACKAGED_WORKBENCH_JOURNEY_SCREENSHOT_STAGES.map((stage) => `${stage}.png`),
            PACKAGED_WORKBENCH_JOURNEY_PROOF_FILE,
        ].sort((left, right) => left.localeCompare(right));
        const entries = fs
            .readdirSync(proof.#rootPath, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name));
        if (
            entries.length !== expectedNames.length ||
            entries.some((entry, index) => entry.name !== expectedNames[index] || entry.isSymbolicLink() || !entry.isFile())
        ) {
            throw new Error("packaged workbench continuation inventory is incomplete or contains an unexpected entry");
        }
        for (const stage of PACKAGED_WORKBENCH_JOURNEY_SCREENSHOT_STAGES) {
            assertPng(stage, fs.readFileSync(path.join(proof.#rootPath, `${stage}.png`)));
            proof.#captured.add(stage);
        }
        return proof;
    }

    public async capture(
        stage: PackagedWorkbenchScreenshotStage,
        webContents: PackagedWorkbenchScreenshotWebContents,
    ): Promise<void> {
        if (this.#captured.has(stage)) throw new Error(`packaged workbench screenshot ${stage} was captured twice`);
        await new Promise<void>((resolve) => setTimeout(resolve, 225));
        const png = (await webContents.capturePage()).toPNG();
        assertPng(stage, png);
        fs.writeFileSync(path.join(this.#rootPath, `${stage}.png`), png, { flag: "wx" });
        this.#captured.add(stage);
    }

    public recordJourney(proof: PackagedWorkbenchUiProof): void {
        const missing = PACKAGED_WORKBENCH_JOURNEY_SCREENSHOT_STAGES.filter((stage) => !this.#captured.has(stage));
        if (missing.length > 0) throw new Error(`packaged workbench journey screenshots are incomplete: ${missing.join(",")}`);
        fs.writeFileSync(
            path.join(this.#rootPath, PACKAGED_WORKBENCH_JOURNEY_PROOF_FILE),
            `${JSON.stringify(proof, null, 2)}\n`,
            { flag: "wx" },
        );
    }

    public finalize(persistence: PackagedWorkbenchPersistenceProof): void {
        if (!this.#captured.has(PACKAGED_WORKBENCH_PERSISTENCE_SCREENSHOT_STAGE)) {
            throw new Error("packaged workbench persistence screenshot is incomplete");
        }
        const journey = JSON.parse(
            fs.readFileSync(path.join(this.#rootPath, PACKAGED_WORKBENCH_JOURNEY_PROOF_FILE), "utf8"),
        ) as unknown;
        fs.writeFileSync(
            path.join(this.#rootPath, PACKAGED_WORKBENCH_SCREENSHOT_MANIFEST),
            `${JSON.stringify(
                {
                    schemaVersion: 1,
                    stages: PACKAGED_WORKBENCH_SCREENSHOT_STAGES.map((stage) => ({
                        stage,
                        fileName: `${stage}.png`,
                    })),
                    proof: {
                        journey,
                        persistence,
                    },
                },
                null,
                2,
            )}\n`,
            { flag: "wx" },
        );
    }
}

export class PackagedLibraryScreenshotProof {
    readonly #rootPath: string;
    readonly #captured = new Set<PackagedLibraryScreenshotStage>();

    private constructor(rootPath: string) {
        this.#rootPath = path.resolve(rootPath);
    }

    public static create(rootPath: string): PackagedLibraryScreenshotProof {
        const proof = new PackagedLibraryScreenshotProof(rootPath);
        fs.mkdirSync(proof.#rootPath);
        return proof;
    }

    public async capture(
        stage: PackagedLibraryScreenshotStage,
        webContents: PackagedWorkbenchScreenshotWebContents,
    ): Promise<void> {
        if (this.#captured.has(stage)) throw new Error(`packaged library screenshot ${stage} was captured twice`);
        await new Promise<void>((resolve) => setTimeout(resolve, 225));
        const png = (await webContents.capturePage()).toPNG();
        assertPng(stage, png);
        fs.writeFileSync(path.join(this.#rootPath, `${stage}.png`), png, { flag: "wx" });
        this.#captured.add(stage);
    }

    public finalize(proof: PackagedLibraryUiProof): void {
        const missing = PACKAGED_LIBRARY_SCREENSHOT_STAGES.filter((stage) => !this.#captured.has(stage));
        if (missing.length > 0) throw new Error(`packaged library screenshots are incomplete: ${missing.join(",")}`);
        fs.writeFileSync(
            path.join(this.#rootPath, PACKAGED_WORKBENCH_SCREENSHOT_MANIFEST),
            `${JSON.stringify(
                {
                    schemaVersion: 2,
                    stages: PACKAGED_LIBRARY_SCREENSHOT_STAGES.map((stage) => ({
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
