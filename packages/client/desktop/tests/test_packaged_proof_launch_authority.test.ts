import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    authorizePackagedProofLaunch,
    PACKAGED_PROOF_FINAL_SUBJECTS_FILE_NAME,
    PACKAGED_PROOF_MARKER_FILE_NAME,
    PACKAGED_PROOF_PROFILE_ROOT_ENVIRONMENT,
    PACKAGED_PROOF_SUBJECTS_FILE_NAME,
    PACKAGED_PROOF_SWITCHES,
    PACKAGED_PROOF_TOKEN_ENVIRONMENT,
    PACKAGED_ZCODE_DEPLOY_SMOKE_SWITCH,
    PACKAGED_ZCODE_REVERSE_SMOKE_SWITCH,
    type PackagedProofOwnership,
    packagedProviderProofLine,
    readPackagedProofFixtureSubjects,
    settlePackagedProof,
    writePackagedProofFinalFixtureSubjects,
    writePackagedProofFixtureSubjects,
} from "../src/main/packaged-proof-launch-authority";

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function linuxProofFixture(): {
    readonly root: string;
    readonly markerPath: string;
    readonly token: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly ownership: PackagedProofOwnership;
} {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-packaged-proof-"));
    roots.push(root);
    const temporaryPath = path.join(root, "tmp");
    fs.mkdirSync(temporaryPath);
    const token = crypto.randomBytes(32).toString("hex");
    const ownership = proofOwnership();
    const markerPath = path.join(root, PACKAGED_PROOF_MARKER_FILE_NAME);
    fs.writeFileSync(
        markerPath,
        JSON.stringify({
            schemaVersion: 2,
            profileRootPath: root,
            token,
            ownership,
        }),
        { flag: "wx" },
    );
    return {
        root,
        markerPath,
        token,
        ownership,
        environment: {
            HOME: root,
            USERPROFILE: root,
            TMPDIR: temporaryPath,
            [PACKAGED_PROOF_PROFILE_ROOT_ENVIRONMENT]: root,
            [PACKAGED_PROOF_TOKEN_ENVIRONMENT]: token,
        },
    };
}

function proofOwnership(): PackagedProofOwnership {
    return Object.freeze({
        ownerId: "fixture_owner",
        inheritance: Object.freeze({ kind: "none" }),
        producerSwitch: PACKAGED_PROOF_SWITCHES[0],
        consumerSwitches: Object.freeze(PACKAGED_PROOF_SWITCHES.slice(1)),
        continuityToken: "c".repeat(64),
    });
}

function proofFileStat(kind: "directory" | "file" | "symlink", size = 128) {
    return {
        size,
        isDirectory: () => kind === "directory",
        isFile: () => kind === "file",
        isSymbolicLink: () => kind === "symlink",
    };
}

describe("packaged proof launch authority", () => {
    it("settles packaged proof success and failure through one bounded lifecycle owner", async () => {
        const output: string[] = [];
        const errors: string[] = [];
        const shutdown: boolean[] = [];
        const io = {
            writeOutput: (value: string) => output.push(value),
            writeError: (value: string) => errors.push(value),
            requestShutdown: (failed: boolean) => shutdown.push(failed),
        };
        settlePackagedProof(Promise.resolve(), "proof passed", "PROOF", io);
        await Promise.resolve();
        settlePackagedProof(Promise.reject(new Error("bounded failure")), "unused", "PROOF", io);
        await Promise.resolve();
        expect(output).toEqual(["proof passed\n"]);
        expect(errors).toEqual(["PROOF failed=proof detail=bounded failure\n"]);
        expect(shutdown).toEqual([false, true]);
    });

    it("allows an ordinary launch only when no proof mode or proof authorization is present", () => {
        expect(authorizePackagedProofLaunch({ argv: ["oaam-desktop", "--oaam-root"], environment: {}, platform: "linux" })).toBe(
            undefined,
        );
        expect(() =>
            authorizePackagedProofLaunch({
                argv: ["oaam-desktop"],
                environment: { [PACKAGED_PROOF_TOKEN_ENVIRONMENT]: "0".repeat(64) },
                platform: "linux",
            }),
        ).toThrow(/without a proof mode/u);
        for (const unknown of ["--oaam-future-smoke", "--oaam-future-proof"]) {
            expect(() =>
                authorizePackagedProofLaunch({ argv: ["oaam-desktop", unknown], environment: {}, platform: "linux" }),
            ).toThrow(/unknown proof switch/u);
        }
    });

    it("accepts every centrally registered proof mode against one direct isolated profile", () => {
        const fixture = linuxProofFixture();
        expect(PACKAGED_PROOF_SWITCHES).toHaveLength(27);
        expect(PACKAGED_PROOF_SWITCHES).not.toContain("--oaam-packaged-empty-import-smoke");
        expect(PACKAGED_PROOF_SWITCHES).not.toContain("--oaam-packaged-project-target-check-smoke");
        expect(new Set(PACKAGED_PROOF_SWITCHES).size).toBe(PACKAGED_PROOF_SWITCHES.length);
        for (const proofSwitch of PACKAGED_PROOF_SWITCHES) {
            expect(
                authorizePackagedProofLaunch({
                    argv: ["oaam-desktop", proofSwitch],
                    environment: fixture.environment,
                    platform: "linux",
                }),
            ).toEqual({ proofSwitch, profileRootPath: fixture.root, ownership: fixture.ownership });
        }
        expect(PACKAGED_PROOF_SWITCHES.map(packagedProviderProofLine).filter((value) => value !== undefined)).toEqual([
            "OAAM_DESKTOP_PROJECT_ASSET_IMPORT passed",
            "OAAM_DESKTOP_PROVIDER_PROJECT_REGISTRATION passed",
            "OAAM_DESKTOP_PROVIDER_SOURCE_IGNORE passed",
        ]);
    });

    it("rejects a proof switch that is not the declared producer or consumer", () => {
        const fixture = linuxProofFixture();
        const ownership = Object.freeze({
            ...fixture.ownership,
            producerSwitch: PACKAGED_ZCODE_DEPLOY_SMOKE_SWITCH,
            consumerSwitches: Object.freeze([PACKAGED_ZCODE_REVERSE_SMOKE_SWITCH]),
        });
        fs.writeFileSync(
            fixture.markerPath,
            JSON.stringify({ schemaVersion: 2, profileRootPath: fixture.root, token: fixture.token, ownership }),
            { flag: "w" },
        );
        expect(() =>
            authorizePackagedProofLaunch({
                argv: [PACKAGED_PROOF_SWITCHES[0]],
                environment: fixture.environment,
                platform: "linux",
            }),
        ).toThrow(/not owned by this profile/u);
    });

    it("rejects malformed ownership and accepts only one exact declared fixture inheritance", () => {
        const fixture = linuxProofFixture();
        const authorize = () =>
            authorizePackagedProofLaunch({
                argv: [PACKAGED_PROOF_SWITCHES[0]],
                environment: fixture.environment,
                platform: "linux",
            });
        const writeOwnership = (ownership: unknown) =>
            fs.writeFileSync(
                fixture.markerPath,
                JSON.stringify({
                    schemaVersion: 2,
                    profileRootPath: fixture.root,
                    token: fixture.token,
                    ownership,
                }),
                { flag: "w" },
            );

        writeOwnership(null);
        expect(authorize).toThrow(/ownership is not an object/u);
        writeOwnership({ ...fixture.ownership, ownerId: "x" });
        expect(authorize).toThrow(/ownership has an invalid shape/u);
        writeOwnership({
            ...fixture.ownership,
            consumerSwitches: [fixture.ownership.producerSwitch],
        });
        expect(authorize).toThrow(/ownership has invalid consumers/u);
        writeOwnership({ ...fixture.ownership, inheritance: null });
        expect(authorize).toThrow(/inheritance has an invalid shape/u);
        writeOwnership({ ...fixture.ownership, inheritance: { kind: "declared_fixture" } });
        expect(authorize).toThrow(/inheritance has an invalid shape/u);

        const inheritance = Object.freeze({
            kind: "declared_fixture" as const,
            sourceOwnerId: "source_owner",
            sourceContinuityToken: "d".repeat(64),
        });
        writeOwnership({ ...fixture.ownership, inheritance });
        expect(authorize()).toEqual({
            proofSwitch: PACKAGED_PROOF_SWITCHES[0],
            profileRootPath: fixture.root,
            ownership: { ...fixture.ownership, inheritance },
        });
    });

    it("binds exact fixture subjects to one owner and lets only the declared reverse consumer finalize them", () => {
        const fixture = linuxProofFixture();
        const ownership = Object.freeze({
            ...fixture.ownership,
            producerSwitch: PACKAGED_ZCODE_DEPLOY_SMOKE_SWITCH,
            consumerSwitches: Object.freeze([PACKAGED_ZCODE_REVERSE_SMOKE_SWITCH]),
        });
        fs.writeFileSync(
            fixture.markerPath,
            JSON.stringify({ schemaVersion: 2, profileRootPath: fixture.root, token: fixture.token, ownership }),
            { flag: "w" },
        );
        const authorize = (proofSwitch: string) =>
            authorizePackagedProofLaunch({ argv: [proofSwitch], environment: fixture.environment, platform: "linux" });
        const producer = authorize(PACKAGED_ZCODE_DEPLOY_SMOKE_SWITCH);
        const consumer = authorize(PACKAGED_ZCODE_REVERSE_SMOKE_SWITCH);
        if (producer === undefined || consumer === undefined) throw new Error("proof authorization was not created");
        const subjects = Object.freeze({
            assetKind: "Guidance" as const,
            source: Object.freeze({ projectId: "source-project", assetId: "source-asset", versionId: "source-version" }),
            target: Object.freeze({
                projectId: "target-project",
                assetId: "target-asset",
                versionId: "target-version",
                deploymentId: "target-deployment",
            }),
        });
        expect(() =>
            writePackagedProofFixtureSubjects(producer, {
                ...subjects,
                source: { ...subjects.source, assetId: " source-asset" },
            }),
        ).toThrow(/invalid identifier/u);
        expect(() =>
            writePackagedProofFixtureSubjects(producer, {
                ...subjects,
                target: { ...subjects.target, deploymentId: "x".repeat(257) },
            }),
        ).toThrow(/invalid identifier/u);
        writePackagedProofFixtureSubjects(producer, subjects);
        expect(readPackagedProofFixtureSubjects(consumer)).toEqual(subjects);
        expect(() => writePackagedProofFixtureSubjects(consumer, subjects)).toThrow(/only the declared ZCode producer/u);
        expect(() =>
            readPackagedProofFixtureSubjects({
                ...consumer,
                ownership: { ...consumer.ownership, continuityToken: "d".repeat(64) },
            }),
        ).toThrow(/does not match this profile owner/u);

        const finalized = Object.freeze({
            assetKind: subjects.assetKind,
            source: subjects.source,
            target: Object.freeze({ ...subjects.target, versionId: "final-version" }),
        });
        expect(() =>
            writePackagedProofFinalFixtureSubjects(consumer, {
                assetKind: subjects.assetKind,
                source: subjects.source,
                target: { ...subjects.target, assetId: "other-asset", versionId: "final-version" },
            }),
        ).toThrow(/changed its declared identity/u);
        writePackagedProofFinalFixtureSubjects(consumer, finalized);
        expect(readPackagedProofFixtureSubjects(consumer)).toEqual(finalized);
        const finalPath = path.join(fixture.root, PACKAGED_PROOF_FINAL_SUBJECTS_FILE_NAME);
        const replacement = path.join(fixture.root, "linked-final.json");
        fs.renameSync(finalPath, replacement);
        fs.symlinkSync(replacement, finalPath);
        fs.rmSync(replacement);
        expect(() => readPackagedProofFixtureSubjects(consumer)).toThrow(/bounded direct file/u);
    });

    it("fails closed for missing and malformed fixture-subject manifests", () => {
        const fixture = linuxProofFixture();
        const ownership = Object.freeze({
            ...fixture.ownership,
            producerSwitch: PACKAGED_ZCODE_DEPLOY_SMOKE_SWITCH,
            consumerSwitches: Object.freeze([PACKAGED_ZCODE_REVERSE_SMOKE_SWITCH]),
        });
        fs.writeFileSync(
            fixture.markerPath,
            JSON.stringify({ schemaVersion: 2, profileRootPath: fixture.root, token: fixture.token, ownership }),
            { flag: "w" },
        );
        const producer = authorizePackagedProofLaunch({
            argv: [PACKAGED_ZCODE_DEPLOY_SMOKE_SWITCH],
            environment: fixture.environment,
            platform: "linux",
        });
        const consumer = authorizePackagedProofLaunch({
            argv: [PACKAGED_ZCODE_REVERSE_SMOKE_SWITCH],
            environment: fixture.environment,
            platform: "linux",
        });
        if (producer === undefined || consumer === undefined) throw new Error("proof authorization was not created");

        expect(() => readPackagedProofFixtureSubjects(consumer)).toThrow(/manifest does not exist/u);
        expect(() =>
            writePackagedProofFinalFixtureSubjects(producer, {
                assetKind: "Guidance",
                source: { projectId: "source-project", assetId: "source-asset", versionId: "source-version" },
                target: {
                    projectId: "target-project",
                    assetId: "target-asset",
                    versionId: "target-version",
                    deploymentId: "target-deployment",
                },
            }),
        ).toThrow(/only the declared ZCode reverse consumer/u);

        const manifestPath = path.join(fixture.root, PACKAGED_PROOF_SUBJECTS_FILE_NAME);
        fs.writeFileSync(manifestPath, "{", { flag: "wx" });
        expect(() => readPackagedProofFixtureSubjects(consumer)).toThrow(/not valid JSON/u);
        fs.writeFileSync(manifestPath, "[]", { flag: "w" });
        expect(() => readPackagedProofFixtureSubjects(consumer)).toThrow(/manifest is not an object/u);
        fs.writeFileSync(
            manifestPath,
            JSON.stringify({
                schemaVersion: 1,
                ownerId: ownership.ownerId,
                continuityToken: ownership.continuityToken,
                subjects: null,
            }),
            { flag: "w" },
        );
        expect(() => readPackagedProofFixtureSubjects(consumer)).toThrow(/subjects are not an object/u);
        fs.writeFileSync(
            manifestPath,
            JSON.stringify({
                schemaVersion: 1,
                ownerId: ownership.ownerId,
                continuityToken: ownership.continuityToken,
                subjects: { source: {}, target: {} },
            }),
            { flag: "w" },
        );
        expect(() => readPackagedProofFixtureSubjects(consumer)).toThrow(/subjects have an invalid shape/u);
    });

    it("rejects duplicate and cross-category proof modes before reading a profile", () => {
        const fixture = linuxProofFixture();
        expect(() =>
            authorizePackagedProofLaunch({
                argv: ["oaam-desktop", PACKAGED_PROOF_SWITCHES[0], PACKAGED_PROOF_SWITCHES[0]],
                environment: fixture.environment,
                platform: "linux",
            }),
        ).toThrow(/exactly one/u);
        expect(() =>
            authorizePackagedProofLaunch({
                argv: ["oaam-desktop", PACKAGED_PROOF_SWITCHES[0], PACKAGED_PROOF_SWITCHES[1]],
                environment: fixture.environment,
                platform: "linux",
            }),
        ).toThrow(/exactly one/u);
    });

    it("requires exact HOME and USERPROFILE plus a child temporary root", () => {
        const fixture = linuxProofFixture();
        for (const [name, value, message] of [
            [PACKAGED_PROOF_PROFILE_ROOT_ENVIRONMENT, undefined, "PROOF_ROOT"],
            [PACKAGED_PROOF_TOKEN_ENVIRONMENT, undefined, "PROOF_TOKEN"],
            ["HOME", undefined, "HOME"],
            ["USERPROFILE", undefined, "USERPROFILE"],
            ["TMPDIR", undefined, "TMPDIR"],
            ["HOME", path.join(fixture.root, "other"), "HOME"],
            ["USERPROFILE", path.join(fixture.root, "other"), "USERPROFILE"],
            ["TMPDIR", fixture.root, "TMPDIR"],
            ["TMPDIR", path.dirname(fixture.root), "TMPDIR"],
        ] as const) {
            expect(() =>
                authorizePackagedProofLaunch({
                    argv: ["oaam-desktop", PACKAGED_PROOF_SWITCHES[0]],
                    environment: { ...fixture.environment, [name]: value },
                    platform: "linux",
                }),
            ).toThrow(new RegExp(message, "u"));
        }
        expect(() =>
            authorizePackagedProofLaunch({
                argv: ["oaam-desktop", PACKAGED_PROOF_SWITCHES[0]],
                environment: {
                    ...fixture.environment,
                    [PACKAGED_PROOF_PROFILE_ROOT_ENVIRONMENT]: "relative",
                },
                platform: "linux",
            }),
        ).toThrow(/absolute target-platform path/u);
    });

    it("confines an explicit Linux XDG configuration to the authorized proof profile", () => {
        const fixture = linuxProofFixture();
        const authorize = (configuration: string | undefined) =>
            authorizePackagedProofLaunch({
                argv: ["oaam-desktop", PACKAGED_PROOF_SWITCHES[0]],
                environment: { ...fixture.environment, XDG_CONFIG_HOME: configuration },
                platform: "linux",
            });
        expect(authorize(undefined)?.profileRootPath).toBe(fixture.root);
        expect(authorize(path.join(fixture.root, ".config"))?.profileRootPath).toBe(fixture.root);
        for (const configuration of [
            fixture.root,
            path.dirname(fixture.root),
            `${fixture.root}-sibling`,
            path.join(fixture.root, "..", "foreign-config"),
            "relative-config",
            "",
            "invalid\0config",
        ]) {
            expect(() => authorize(configuration)).toThrow(/XDG_CONFIG_HOME/u);
        }
        expect(
            authorizePackagedProofLaunch({
                argv: ["oaam-desktop"],
                environment: { XDG_CONFIG_HOME: path.dirname(fixture.root) },
                platform: "linux",
            }),
        ).toBeUndefined();
    });

    it("rejects missing, linked, unbounded and malformed profile markers", () => {
        const missingRoot = path.join(os.tmpdir(), `oaam-missing-proof-${crypto.randomUUID()}`);
        expect(() =>
            authorizePackagedProofLaunch({
                argv: [PACKAGED_PROOF_SWITCHES[0]],
                environment: {
                    HOME: missingRoot,
                    USERPROFILE: missingRoot,
                    TMPDIR: path.join(missingRoot, "tmp"),
                    [PACKAGED_PROOF_PROFILE_ROOT_ENVIRONMENT]: missingRoot,
                    [PACKAGED_PROOF_TOKEN_ENVIRONMENT]: "a".repeat(64),
                },
                platform: "linux",
            }),
        ).toThrow(/profile does not exist/u);

        const missing = linuxProofFixture();
        fs.rmSync(missing.markerPath);
        expect(() =>
            authorizePackagedProofLaunch({
                argv: [PACKAGED_PROOF_SWITCHES[0]],
                environment: missing.environment,
                platform: "linux",
            }),
        ).toThrow(/marker does not exist/u);

        const linked = linuxProofFixture();
        fs.rmSync(linked.markerPath);
        const target = path.join(linked.root, "marker-target.json");
        fs.writeFileSync(target, "{}");
        fs.symlinkSync(target, linked.markerPath);
        expect(() =>
            authorizePackagedProofLaunch({
                argv: [PACKAGED_PROOF_SWITCHES[0]],
                environment: linked.environment,
                platform: "linux",
            }),
        ).toThrow(/bounded direct file/u);

        const malformed = linuxProofFixture();
        fs.writeFileSync(malformed.markerPath, "{", { flag: "w" });
        expect(() =>
            authorizePackagedProofLaunch({
                argv: [PACKAGED_PROOF_SWITCHES[0]],
                environment: malformed.environment,
                platform: "linux",
            }),
        ).toThrow(/valid JSON/u);
        fs.writeFileSync(malformed.markerPath, "[]", { flag: "w" });
        expect(() =>
            authorizePackagedProofLaunch({
                argv: [PACKAGED_PROOF_SWITCHES[0]],
                environment: malformed.environment,
                platform: "linux",
            }),
        ).toThrow(/marker is not an object/u);
        fs.writeFileSync(malformed.markerPath, JSON.stringify({ schemaVersion: 2, token: malformed.token }), { flag: "w" });
        expect(() =>
            authorizePackagedProofLaunch({
                argv: [PACKAGED_PROOF_SWITCHES[0]],
                environment: malformed.environment,
                platform: "linux",
            }),
        ).toThrow(/invalid shape/u);
        fs.writeFileSync(malformed.markerPath, "x".repeat(4_097), { flag: "w" });
        expect(() =>
            authorizePackagedProofLaunch({
                argv: [PACKAGED_PROOF_SWITCHES[0]],
                environment: malformed.environment,
                platform: "linux",
            }),
        ).toThrow(/bounded direct file/u);
    });

    it("rejects linked profile roots and marker mismatches without disclosing the token", () => {
        const linked = linuxProofFixture();
        const rootLink = `${linked.root}-link`;
        roots.push(rootLink);
        fs.symlinkSync(linked.root, rootLink, "dir");
        expect(() =>
            authorizePackagedProofLaunch({
                argv: [PACKAGED_PROOF_SWITCHES[0]],
                environment: {
                    ...linked.environment,
                    HOME: rootLink,
                    USERPROFILE: rootLink,
                    TMPDIR: path.join(rootLink, "tmp"),
                    [PACKAGED_PROOF_PROFILE_ROOT_ENVIRONMENT]: rootLink,
                },
                platform: "linux",
            }),
        ).toThrow(/not a direct directory/u);

        const mismatch = linuxProofFixture();
        fs.writeFileSync(
            mismatch.markerPath,
            JSON.stringify({
                schemaVersion: 2,
                profileRootPath: mismatch.root,
                token: "f".repeat(64),
                ownership: mismatch.ownership,
            }),
            { flag: "w" },
        );
        let message = "";
        try {
            authorizePackagedProofLaunch({
                argv: [PACKAGED_PROOF_SWITCHES[0]],
                environment: mismatch.environment,
                platform: "linux",
            });
        } catch (error) {
            message = error instanceof Error ? error.message : String(error);
        }
        expect(message).toMatch(/does not match/u);
        expect(message).not.toContain(mismatch.token);
        expect(message).not.toContain("f".repeat(64));
    });

    it("enforces all Win32 profile children with case-insensitive path identity", () => {
        const root = "C:\\OAAM\\Proof";
        const token = "a".repeat(64);
        const markerPath = path.win32.join(root, PACKAGED_PROOF_MARKER_FILE_NAME);
        const ownership = proofOwnership();
        const filesystem = {
            lstatSync(filePath: string) {
                if (filePath === root) return proofFileStat("directory");
                if (filePath === markerPath) return proofFileStat("file");
                throw new Error("unexpected path");
            },
            realpathSync: (filePath: string) => filePath,
            readFileSync: () =>
                JSON.stringify({
                    schemaVersion: 2,
                    profileRootPath: "c:\\oaam\\proof",
                    token,
                    ownership,
                }),
        };
        const environment = {
            HOME: "c:\\oaam\\proof",
            USERPROFILE: root,
            APPDATA: `${root}\\AppData\\Roaming`,
            LOCALAPPDATA: `${root}\\AppData\\Local`,
            TEMP: `${root}\\AppData\\Local\\Temp`,
            TMP: `${root}\\tmp`,
            [PACKAGED_PROOF_PROFILE_ROOT_ENVIRONMENT]: root,
            [PACKAGED_PROOF_TOKEN_ENVIRONMENT]: token,
        };
        expect(
            authorizePackagedProofLaunch({
                argv: [PACKAGED_PROOF_SWITCHES[0]],
                environment,
                platform: "win32",
                filesystem,
            }),
        ).toEqual({ proofSwitch: PACKAGED_PROOF_SWITCHES[0], profileRootPath: root, ownership });
        for (const name of ["APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]) {
            expect(() =>
                authorizePackagedProofLaunch({
                    argv: [PACKAGED_PROOF_SWITCHES[0]],
                    environment: { ...environment, [name]: "C:\\ordinary-profile" },
                    platform: "win32",
                    filesystem,
                }),
            ).toThrow(new RegExp(name, "u"));
        }
    });

    it("rejects filesystem aliases and non-directory profile objects through the filesystem boundary", () => {
        const root = "/proof";
        const markerPath = path.posix.join(root, PACKAGED_PROOF_MARKER_FILE_NAME);
        const token = "b".repeat(64);
        const ownership = proofOwnership();
        const environment = {
            HOME: root,
            USERPROFILE: root,
            TMPDIR: `${root}/tmp`,
            [PACKAGED_PROOF_PROFILE_ROOT_ENVIRONMENT]: root,
            [PACKAGED_PROOF_TOKEN_ENVIRONMENT]: token,
        };
        const filesystem = {
            lstatSync(filePath: string) {
                return filePath === root ? proofFileStat("file") : proofFileStat("file");
            },
            realpathSync: (filePath: string) => filePath,
            readFileSync: () => JSON.stringify({ schemaVersion: 2, profileRootPath: root, token, ownership }),
        };
        expect(() =>
            authorizePackagedProofLaunch({
                argv: [PACKAGED_PROOF_SWITCHES[0]],
                environment,
                platform: "linux",
                filesystem,
            }),
        ).toThrow(/not a direct directory/u);

        const aliasFilesystem = {
            ...filesystem,
            lstatSync(filePath: string) {
                return filePath === root ? proofFileStat("directory") : proofFileStat("file");
            },
            realpathSync(filePath: string) {
                return filePath === root ? "/aliased-proof" : markerPath;
            },
        };
        expect(() =>
            authorizePackagedProofLaunch({
                argv: [PACKAGED_PROOF_SWITCHES[0]],
                environment,
                platform: "linux",
                filesystem: aliasFilesystem,
            }),
        ).toThrow(/alias or link/u);

        const markerAliasFilesystem = {
            ...aliasFilesystem,
            realpathSync(filePath: string) {
                return filePath === root ? root : "/aliased-marker";
            },
        };
        expect(() =>
            authorizePackagedProofLaunch({
                argv: [PACKAGED_PROOF_SWITCHES[0]],
                environment,
                platform: "linux",
                filesystem: markerAliasFilesystem,
            }),
        ).toThrow(/marker resolves through an alias or link/u);
    });
});
