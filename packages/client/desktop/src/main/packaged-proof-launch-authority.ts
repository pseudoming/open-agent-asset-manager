import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PackagedZcodeTargetFixtureSubjects } from "../bridge/desktop-bridge";

export const PACKAGED_ASSET_LIFECYCLE_SMOKE_SWITCH = "--oaam-packaged-asset-lifecycle-smoke";
export const PACKAGED_DEPLOYMENT_REPAIR_UI_SMOKE_SWITCH = "--oaam-packaged-deployment-repair-ui-smoke";
export const PACKAGED_DEPLOYMENT_REVERSE_UI_SMOKE_SWITCH = "--oaam-packaged-deployment-reverse-ui-smoke";
export const PACKAGED_DEPLOYMENT_REVERSE_RECOVERY_UI_SMOKE_SWITCH = "--oaam-packaged-deployment-reverse-recovery-ui-smoke";
export const PACKAGED_DIAGNOSTICS_SMOKE_SWITCH = "--oaam-packaged-diagnostics-smoke";
export const PACKAGED_LIBRARY_UI_SMOKE_SWITCH = "--oaam-packaged-library-ui-smoke";
export const PACKAGED_OPENCODE_NATIVE_PROJECT_SMOKE_SWITCH = "--oaam-packaged-opencode-native-project-smoke";
export const PACKAGED_OPENCODE_WSL_PROJECT_SMOKE_SWITCH = "--oaam-packaged-opencode-wsl-project-smoke";
export const PACKAGED_PROJECT_LIFECYCLE_SMOKE_SWITCH = "--oaam-packaged-project-lifecycle-smoke";
export const PACKAGED_PROJECT_RESTORE_SMOKE_SWITCH = "--oaam-packaged-project-restore-smoke";
export const PACKAGED_PROJECT_STOP_SMOKE_SWITCH = "--oaam-packaged-project-stop-smoke";
export const PACKAGED_PROJECT_ASSET_IMPORT_SMOKE_SWITCH = "--oaam-packaged-project-asset-import-smoke";
export const PACKAGED_PROVIDER_DISCOVERY_REVIEW_SMOKE_SWITCH = "--oaam-packaged-provider-discovery-review-smoke";
export const PACKAGED_PROVIDER_PROJECT_REGISTRATION_SMOKE_SWITCH = "--oaam-packaged-provider-project-registration-smoke";
export const PACKAGED_PROVIDER_SOURCE_IGNORE_SMOKE_SWITCH = "--oaam-packaged-provider-source-ignore-smoke";
export const PACKAGED_RUNTIME_SMOKE_SWITCH = "--oaam-packaged-runtime-smoke";
export const PACKAGED_RUNTIME_SINGLE_INSTANCE_PROBE_SWITCH = "--oaam-single-instance-probe";
export const PACKAGED_SETTINGS_OPERATIONS_UI_SMOKE_SWITCH = "--oaam-packaged-settings-operations-ui-smoke";
export const PACKAGED_STARTUP_RECOVERY_SMOKE_SWITCH = "--oaam-packaged-startup-recovery-smoke";
export const PACKAGED_STATE_BACKUP_SMOKE_SWITCH = "--oaam-packaged-state-backup-smoke";
export const PACKAGED_STATE_REOPEN_SMOKE_SWITCH = "--oaam-packaged-state-reopen-smoke";
export const PACKAGED_STATE_RESTORE_SMOKE_SWITCH = "--oaam-packaged-state-restore-smoke";
export const PACKAGED_STATE_TRASH_SMOKE_SWITCH = "--oaam-packaged-state-trash-smoke";
export const PACKAGED_WORKBENCH_PERSISTENCE_SMOKE_SWITCH = "--oaam-packaged-workbench-persistence-smoke";
export const PACKAGED_WORKBENCH_UI_SMOKE_SWITCH = "--oaam-packaged-workbench-ui-smoke";
export const PACKAGED_ZCODE_DEPLOY_SMOKE_SWITCH = "--oaam-packaged-zcode-target-deploy-smoke";
export const PACKAGED_ZCODE_REVERSE_SMOKE_SWITCH = "--oaam-packaged-zcode-target-reverse-smoke";

export function packagedProviderProofLine(proofSwitch: string | undefined): string | undefined {
    if (proofSwitch === PACKAGED_PROVIDER_SOURCE_IGNORE_SMOKE_SWITCH) return "OAAM_DESKTOP_PROVIDER_SOURCE_IGNORE passed";
    if (proofSwitch === PACKAGED_PROJECT_ASSET_IMPORT_SMOKE_SWITCH) return "OAAM_DESKTOP_PROJECT_ASSET_IMPORT passed";
    if (proofSwitch === PACKAGED_PROVIDER_PROJECT_REGISTRATION_SMOKE_SWITCH)
        return "OAAM_DESKTOP_PROVIDER_PROJECT_REGISTRATION passed";
    return undefined;
}

export const PACKAGED_PROOF_PROFILE_ROOT_ENVIRONMENT = "OAAM_PACKAGED_PROOF_ROOT";
export const PACKAGED_PROOF_TOKEN_ENVIRONMENT = "OAAM_PACKAGED_PROOF_TOKEN";
export const PACKAGED_PROOF_MARKER_FILE_NAME = ".oaam-packaged-proof.json";
export const PACKAGED_PROOF_SUBJECTS_FILE_NAME = ".oaam-packaged-proof-subjects.json";
export const PACKAGED_PROOF_FINAL_SUBJECTS_FILE_NAME = ".oaam-packaged-proof-subjects-final.json";

export const PACKAGED_PROOF_SWITCHES = Object.freeze([
    PACKAGED_ASSET_LIFECYCLE_SMOKE_SWITCH,
    PACKAGED_DEPLOYMENT_REPAIR_UI_SMOKE_SWITCH,
    PACKAGED_DEPLOYMENT_REVERSE_UI_SMOKE_SWITCH,
    PACKAGED_DEPLOYMENT_REVERSE_RECOVERY_UI_SMOKE_SWITCH,
    PACKAGED_DIAGNOSTICS_SMOKE_SWITCH,
    PACKAGED_LIBRARY_UI_SMOKE_SWITCH,
    PACKAGED_OPENCODE_NATIVE_PROJECT_SMOKE_SWITCH,
    PACKAGED_OPENCODE_WSL_PROJECT_SMOKE_SWITCH,
    PACKAGED_PROJECT_LIFECYCLE_SMOKE_SWITCH,
    PACKAGED_PROJECT_RESTORE_SMOKE_SWITCH,
    PACKAGED_PROJECT_STOP_SMOKE_SWITCH,
    PACKAGED_PROJECT_ASSET_IMPORT_SMOKE_SWITCH,
    PACKAGED_PROVIDER_DISCOVERY_REVIEW_SMOKE_SWITCH,
    PACKAGED_PROVIDER_PROJECT_REGISTRATION_SMOKE_SWITCH,
    PACKAGED_PROVIDER_SOURCE_IGNORE_SMOKE_SWITCH,
    PACKAGED_RUNTIME_SMOKE_SWITCH,
    PACKAGED_RUNTIME_SINGLE_INSTANCE_PROBE_SWITCH,
    PACKAGED_SETTINGS_OPERATIONS_UI_SMOKE_SWITCH,
    PACKAGED_STARTUP_RECOVERY_SMOKE_SWITCH,
    PACKAGED_STATE_BACKUP_SMOKE_SWITCH,
    PACKAGED_STATE_REOPEN_SMOKE_SWITCH,
    PACKAGED_STATE_RESTORE_SMOKE_SWITCH,
    PACKAGED_STATE_TRASH_SMOKE_SWITCH,
    PACKAGED_WORKBENCH_PERSISTENCE_SMOKE_SWITCH,
    PACKAGED_WORKBENCH_UI_SMOKE_SWITCH,
    PACKAGED_ZCODE_DEPLOY_SMOKE_SWITCH,
    PACKAGED_ZCODE_REVERSE_SMOKE_SWITCH,
]);

export interface PackagedProofSettlementIo {
    readonly writeOutput: (text: string) => void;
    readonly writeError: (text: string) => void;
    readonly requestShutdown: (failed: boolean) => void;
}

export function settlePackagedProof(
    proof: Promise<unknown>,
    successLine: string,
    errorPrefix: string,
    io: PackagedProofSettlementIo,
): void {
    void proof.then(
        () => {
            io.writeOutput(`${successLine}\n`);
            io.requestShutdown(false);
        },
        (error) => {
            io.writeError(`${errorPrefix} failed=proof detail=${error instanceof Error ? error.message : String(error)}\n`);
            io.requestShutdown(true);
        },
    );
}

type SupportedDesktopPlatform = "darwin" | "linux" | "win32";

export interface PackagedProofLaunchAuthorization {
    readonly proofSwitch: (typeof PACKAGED_PROOF_SWITCHES)[number];
    readonly profileRootPath: string;
    readonly ownership: PackagedProofOwnership;
}

export interface PackagedProofOwnership {
    readonly ownerId: string;
    readonly inheritance:
        | { readonly kind: "none" }
        | {
              readonly kind: "declared_fixture";
              readonly sourceOwnerId: string;
              readonly sourceContinuityToken: string;
          };
    readonly producerSwitch: (typeof PACKAGED_PROOF_SWITCHES)[number];
    readonly consumerSwitches: readonly (typeof PACKAGED_PROOF_SWITCHES)[number][];
    readonly continuityToken: string;
}

interface PackagedProofMarker {
    readonly schemaVersion: 2;
    readonly profileRootPath: string;
    readonly token: string;
    readonly ownership: PackagedProofOwnership;
}

interface AuthorizePackagedProofLaunchInput {
    readonly argv: readonly string[];
    readonly environment: NodeJS.ProcessEnv;
    readonly platform?: SupportedDesktopPlatform;
    readonly filesystem?: PackagedProofFilesystem;
}

interface PackagedProofFilesystem {
    lstatSync(filePath: string): Pick<fs.Stats, "isDirectory" | "isFile" | "isSymbolicLink" | "size">;
    realpathSync(filePath: string): string;
    readFileSync(filePath: string): string;
}

const NODE_FILESYSTEM: PackagedProofFilesystem = Object.freeze({
    lstatSync: (filePath: string) => fs.lstatSync(filePath),
    realpathSync: (filePath: string) => fs.realpathSync.native(filePath),
    readFileSync: (filePath: string) => fs.readFileSync(filePath, "utf8"),
});

function fail(message: string): never {
    throw new Error(`Packaged proof launch rejected: ${message}`);
}

function isProofLikeSwitch(argument: string): boolean {
    return (
        argument.startsWith("--oaam-") &&
        (argument.includes("smoke") || argument.includes("proof") || argument === PACKAGED_RUNTIME_SINGLE_INSTANCE_PROBE_SWITCH)
    );
}

function pathApi(platform: SupportedDesktopPlatform): path.PlatformPath {
    return platform === "win32" ? path.win32 : path.posix;
}

function comparisonPath(value: string, platform: SupportedDesktopPlatform): string {
    const resolved = pathApi(platform).resolve(value);
    return platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

function samePath(left: string, right: string, platform: SupportedDesktopPlatform): boolean {
    return comparisonPath(left, platform) === comparisonPath(right, platform);
}

function requiredEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): string {
    const value = environment[name];
    if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
        fail(`${name} is missing or invalid`);
    }
    return value;
}

function requiredAbsoluteEnvironmentPath(
    environment: NodeJS.ProcessEnv,
    name: string,
    platform: SupportedDesktopPlatform,
): string {
    const value = requiredEnvironmentValue(environment, name);
    if (!pathApi(platform).isAbsolute(value)) fail(`${name} is not an absolute target-platform path`);
    return value;
}

function assertExactProfilePath(
    environment: NodeJS.ProcessEnv,
    name: string,
    profileRootPath: string,
    platform: SupportedDesktopPlatform,
): void {
    const candidate = requiredAbsoluteEnvironmentPath(environment, name, platform);
    if (!samePath(candidate, profileRootPath, platform)) fail(`${name} does not identify the isolated proof profile`);
}

function assertProfileChildPath(
    environment: NodeJS.ProcessEnv,
    name: string,
    profileRootPath: string,
    platform: SupportedDesktopPlatform,
): void {
    const candidate = requiredAbsoluteEnvironmentPath(environment, name, platform);
    const platformPath = pathApi(platform);
    const relative = platformPath.relative(profileRootPath, candidate);
    if (
        relative.length === 0 ||
        relative === ".." ||
        relative.startsWith(`..${platformPath.sep}`) ||
        platformPath.isAbsolute(relative)
    ) {
        fail(`${name} is not a child of the isolated proof profile`);
    }
}

function readDirectMarker(
    profileRootPath: string,
    platform: SupportedDesktopPlatform,
    filesystem: PackagedProofFilesystem,
): PackagedProofMarker {
    let rootStat: ReturnType<PackagedProofFilesystem["lstatSync"]>;
    try {
        rootStat = filesystem.lstatSync(profileRootPath);
    } catch {
        fail("the isolated proof profile does not exist");
    }
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        fail("the isolated proof profile is not a direct directory");
    }
    const realRoot = filesystem.realpathSync(profileRootPath);
    if (!samePath(realRoot, profileRootPath, platform)) {
        fail("the isolated proof profile resolves through an alias or link");
    }

    const markerPath = pathApi(platform).join(profileRootPath, PACKAGED_PROOF_MARKER_FILE_NAME);
    let markerStat: ReturnType<PackagedProofFilesystem["lstatSync"]>;
    try {
        markerStat = filesystem.lstatSync(markerPath);
    } catch {
        fail("the isolated proof marker does not exist");
    }
    if (markerStat.isSymbolicLink() || !markerStat.isFile() || markerStat.size === 0 || markerStat.size > 4_096) {
        fail("the isolated proof marker is not one bounded direct file");
    }
    const realMarker = filesystem.realpathSync(markerPath);
    if (!samePath(realMarker, markerPath, platform)) {
        fail("the isolated proof marker resolves through an alias or link");
    }

    let value: unknown;
    try {
        value = JSON.parse(filesystem.readFileSync(markerPath));
    } catch {
        fail("the isolated proof marker is not valid JSON");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail("the isolated proof marker is not an object");
    }
    const record = value as Record<string, unknown>;
    if (
        Object.keys(record).sort().join(",") !== "ownership,profileRootPath,schemaVersion,token" ||
        record.schemaVersion !== 2 ||
        typeof record.profileRootPath !== "string" ||
        typeof record.token !== "string"
    ) {
        fail("the isolated proof marker has an invalid shape");
    }
    const ownership = parseOwnership(record.ownership);
    return Object.freeze({
        schemaVersion: 2,
        profileRootPath: record.profileRootPath,
        token: record.token,
        ownership,
    });
}

function isBoundedOwnerId(value: unknown): value is string {
    return typeof value === "string" && /^[a-z][a-z0-9_-]{2,63}$/u.test(value);
}

function parseOwnership(value: unknown): PackagedProofOwnership {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail("the isolated proof ownership is not an object");
    }
    const record = value as Record<string, unknown>;
    if (
        Object.keys(record).sort().join(",") !== "consumerSwitches,continuityToken,inheritance,ownerId,producerSwitch" ||
        !isBoundedOwnerId(record.ownerId) ||
        typeof record.producerSwitch !== "string" ||
        !PACKAGED_PROOF_SWITCHES.includes(record.producerSwitch as (typeof PACKAGED_PROOF_SWITCHES)[number]) ||
        typeof record.continuityToken !== "string" ||
        !/^[0-9a-f]{64}$/u.test(record.continuityToken) ||
        !Array.isArray(record.consumerSwitches)
    ) {
        fail("the isolated proof ownership has an invalid shape");
    }
    const consumerSwitches = record.consumerSwitches;
    if (
        consumerSwitches.some(
            (entry) =>
                typeof entry !== "string" ||
                !PACKAGED_PROOF_SWITCHES.includes(entry as (typeof PACKAGED_PROOF_SWITCHES)[number]) ||
                entry === record.producerSwitch,
        ) ||
        new Set(consumerSwitches).size !== consumerSwitches.length
    ) {
        fail("the isolated proof ownership has invalid consumers");
    }
    if (typeof record.inheritance !== "object" || record.inheritance === null || Array.isArray(record.inheritance)) {
        fail("the isolated proof inheritance has an invalid shape");
    }
    const inheritanceRecord = record.inheritance as Record<string, unknown>;
    let inheritance: PackagedProofOwnership["inheritance"];
    if (Object.keys(inheritanceRecord).sort().join(",") === "kind" && inheritanceRecord.kind === "none") {
        inheritance = Object.freeze({ kind: "none" });
    } else if (
        Object.keys(inheritanceRecord).sort().join(",") === "kind,sourceContinuityToken,sourceOwnerId" &&
        inheritanceRecord.kind === "declared_fixture" &&
        isBoundedOwnerId(inheritanceRecord.sourceOwnerId) &&
        typeof inheritanceRecord.sourceContinuityToken === "string" &&
        /^[0-9a-f]{64}$/u.test(inheritanceRecord.sourceContinuityToken)
    ) {
        inheritance = Object.freeze({
            kind: "declared_fixture",
            sourceOwnerId: inheritanceRecord.sourceOwnerId,
            sourceContinuityToken: inheritanceRecord.sourceContinuityToken,
        });
    } else {
        fail("the isolated proof inheritance has an invalid shape");
    }
    return Object.freeze({
        ownerId: record.ownerId,
        inheritance,
        producerSwitch: record.producerSwitch as (typeof PACKAGED_PROOF_SWITCHES)[number],
        consumerSwitches: Object.freeze([...(consumerSwitches as (typeof PACKAGED_PROOF_SWITCHES)[number][])]),
        continuityToken: record.continuityToken,
    });
}

function tokensEqual(left: string, right: string): boolean {
    if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) return false;
    return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function isBoundedSubjectId(value: unknown): value is string {
    return (
        typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && !value.includes("\0")
    );
}

function parseFixtureSubjects(value: unknown): PackagedZcodeTargetFixtureSubjects {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail("the packaged proof subjects are not an object");
    }
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join(",") !== "assetKind,source,target") {
        fail("the packaged proof subjects have an invalid shape");
    }
    const assetKind = record.assetKind;
    const source = record.source;
    const target = record.target;
    if (
        (assetKind !== "Guidance" &&
            assetKind !== "Workflow" &&
            assetKind !== "Skill" &&
            assetKind !== "Subagent" &&
            assetKind !== "Memory") ||
        typeof source !== "object" ||
        source === null ||
        Array.isArray(source) ||
        Object.keys(source).sort().join(",") !== "assetId,projectId,versionId" ||
        typeof target !== "object" ||
        target === null ||
        Array.isArray(target) ||
        Object.keys(target).sort().join(",") !== "assetId,deploymentId,projectId,versionId"
    ) {
        fail("the packaged proof subjects have an invalid shape");
    }
    const sourceRecord = source as Record<string, unknown>;
    const targetRecord = target as Record<string, unknown>;
    if (
        !isBoundedSubjectId(sourceRecord.projectId) ||
        !isBoundedSubjectId(sourceRecord.assetId) ||
        !isBoundedSubjectId(sourceRecord.versionId) ||
        !isBoundedSubjectId(targetRecord.projectId) ||
        !isBoundedSubjectId(targetRecord.assetId) ||
        !isBoundedSubjectId(targetRecord.versionId) ||
        !isBoundedSubjectId(targetRecord.deploymentId)
    ) {
        fail("the packaged proof subjects contain an invalid identifier");
    }
    return Object.freeze({
        assetKind,
        source: Object.freeze({
            projectId: sourceRecord.projectId,
            assetId: sourceRecord.assetId,
            versionId: sourceRecord.versionId,
        }),
        target: Object.freeze({
            projectId: targetRecord.projectId,
            assetId: targetRecord.assetId,
            versionId: targetRecord.versionId,
            deploymentId: targetRecord.deploymentId,
        }),
    });
}

export function writePackagedProofFixtureSubjects(
    authorization: PackagedProofLaunchAuthorization,
    subjects: PackagedZcodeTargetFixtureSubjects,
): void {
    if (authorization.proofSwitch !== PACKAGED_ZCODE_DEPLOY_SMOKE_SWITCH) {
        fail("only the declared ZCode producer may write fixture subjects");
    }
    const filePath = path.join(authorization.profileRootPath, PACKAGED_PROOF_SUBJECTS_FILE_NAME);
    fs.writeFileSync(
        filePath,
        `${JSON.stringify({
            schemaVersion: 1,
            ownerId: authorization.ownership.ownerId,
            continuityToken: authorization.ownership.continuityToken,
            subjects: parseFixtureSubjects(subjects),
        })}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
}

export function writePackagedProofFinalFixtureSubjects(
    authorization: PackagedProofLaunchAuthorization,
    subjects: PackagedZcodeTargetFixtureSubjects,
): void {
    if (authorization.proofSwitch !== PACKAGED_ZCODE_REVERSE_SMOKE_SWITCH) {
        fail("only the declared ZCode reverse consumer may finalize fixture subjects");
    }
    const original = readPackagedProofFixtureSubjects(authorization);
    if (
        original.assetKind !== subjects.assetKind ||
        original.source.projectId !== subjects.source.projectId ||
        original.source.assetId !== subjects.source.assetId ||
        original.source.versionId !== subjects.source.versionId ||
        original.target.projectId !== subjects.target.projectId ||
        original.target.assetId !== subjects.target.assetId ||
        original.target.deploymentId !== subjects.target.deploymentId
    ) {
        fail("the finalized packaged proof subject changed its declared identity");
    }
    const filePath = path.join(authorization.profileRootPath, PACKAGED_PROOF_FINAL_SUBJECTS_FILE_NAME);
    fs.writeFileSync(
        filePath,
        `${JSON.stringify({
            schemaVersion: 1,
            ownerId: authorization.ownership.ownerId,
            continuityToken: authorization.ownership.continuityToken,
            subjects: parseFixtureSubjects(subjects),
        })}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
}

export function readPackagedProofFixtureSubjects(
    authorization: PackagedProofLaunchAuthorization,
): PackagedZcodeTargetFixtureSubjects {
    const finalPath = path.join(authorization.profileRootPath, PACKAGED_PROOF_FINAL_SUBJECTS_FILE_NAME);
    let finalEntryExists = false;
    try {
        fs.lstatSync(finalPath);
        finalEntryExists = true;
    } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
            fail("the packaged proof final subject manifest cannot be inspected");
        }
    }
    const filePath = finalEntryExists ? finalPath : path.join(authorization.profileRootPath, PACKAGED_PROOF_SUBJECTS_FILE_NAME);
    let stat: fs.Stats;
    try {
        stat = fs.lstatSync(filePath);
    } catch {
        fail("the packaged proof subject manifest does not exist");
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0 || stat.size > 8_192) {
        fail("the packaged proof subject manifest is not one bounded direct file");
    }
    if (!samePath(fs.realpathSync.native(filePath), filePath, process.platform === "win32" ? "win32" : "linux")) {
        fail("the packaged proof subject manifest resolves through an alias or link");
    }
    let value: unknown;
    try {
        value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
        fail("the packaged proof subject manifest is not valid JSON");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail("the packaged proof subject manifest is not an object");
    }
    const record = value as Record<string, unknown>;
    if (
        Object.keys(record).sort().join(",") !== "continuityToken,ownerId,schemaVersion,subjects" ||
        record.schemaVersion !== 1 ||
        record.ownerId !== authorization.ownership.ownerId ||
        typeof record.continuityToken !== "string" ||
        !tokensEqual(record.continuityToken, authorization.ownership.continuityToken)
    ) {
        fail("the packaged proof subject manifest does not match this profile owner");
    }
    return parseFixtureSubjects(record.subjects);
}

export function authorizePackagedProofLaunch(
    input: AuthorizePackagedProofLaunchInput,
): PackagedProofLaunchAuthorization | undefined {
    const knownSwitches = new Set<string>(PACKAGED_PROOF_SWITCHES);
    const unknownProofSwitch = input.argv.find((argument) => isProofLikeSwitch(argument) && !knownSwitches.has(argument));
    if (unknownProofSwitch !== undefined) fail("an unknown proof switch was supplied");

    const matches = input.argv.filter((argument) => knownSwitches.has(argument));
    const hasProofEnvironment =
        input.environment[PACKAGED_PROOF_PROFILE_ROOT_ENVIRONMENT] !== undefined ||
        input.environment[PACKAGED_PROOF_TOKEN_ENVIRONMENT] !== undefined;
    if (matches.length === 0) {
        if (hasProofEnvironment) fail("proof authorization was supplied without a proof mode");
        return undefined;
    }
    if (matches.length !== 1) fail("exactly one known proof mode is required");

    const platform =
        input.platform ?? (process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux");
    const profileRootPath = requiredAbsoluteEnvironmentPath(input.environment, PACKAGED_PROOF_PROFILE_ROOT_ENVIRONMENT, platform);
    const token = requiredEnvironmentValue(input.environment, PACKAGED_PROOF_TOKEN_ENVIRONMENT);
    assertExactProfilePath(input.environment, "HOME", profileRootPath, platform);
    assertExactProfilePath(input.environment, "USERPROFILE", profileRootPath, platform);
    if (platform === "win32") {
        for (const name of ["APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]) {
            assertProfileChildPath(input.environment, name, profileRootPath, platform);
        }
    } else {
        assertProfileChildPath(input.environment, "TMPDIR", profileRootPath, platform);
        if (platform === "linux" && input.environment.XDG_CONFIG_HOME !== undefined) {
            assertProfileChildPath(input.environment, "XDG_CONFIG_HOME", profileRootPath, platform);
        }
    }

    const marker = readDirectMarker(profileRootPath, platform, input.filesystem ?? NODE_FILESYSTEM);
    if (!samePath(marker.profileRootPath, profileRootPath, platform) || !tokensEqual(marker.token, token)) {
        fail("the isolated proof marker does not match this launch");
    }
    const proofSwitch = matches[0] as (typeof PACKAGED_PROOF_SWITCHES)[number];
    if (proofSwitch !== marker.ownership.producerSwitch && !marker.ownership.consumerSwitches.includes(proofSwitch)) {
        fail("the proof mode is not owned by this profile");
    }
    return Object.freeze({
        proofSwitch,
        profileRootPath,
        ownership: marker.ownership,
    });
}
