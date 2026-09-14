/** Locate the shipped Linux package only when an authorized selected-WSL operation needs it. */
import { randomBytes } from "node:crypto";
import { posix, win32 } from "node:path";
import { inspectRegularFileNoFollow, readRegularFileNoFollow } from "@oaam/shared/filesystem";
import {
    createSelectedWslPathProjection,
    invokeLocalExecutableTreeBounded,
    resolveWin32PackagedWorkerPath,
} from "@oaam/shared/paths";
import { requireRestrictedArtifactManifest } from "./restricted-artifact-package";
import { type RestrictedCodePackage, requireRestrictedCodePackage } from "./restricted-code-package";
import { RestrictedProcessStartError } from "./restricted-process-client";
import { resolveRestrictedWslExecutable } from "./restricted-process-launch";

export interface InstalledRestrictedCode {
    readonly wslExecutablePath: string;
    readonly windowsCodeRootPath: string;
    readonly code: RestrictedCodePackage;
}

interface LocationDependencies {
    readonly packageRootPath: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly readManifest: typeof readRegularFileNoFollow;
    readonly inspectExecutable: typeof inspectRegularFileNoFollow;
    readonly invoke: typeof invokeLocalExecutableTreeBounded;
}

export async function resolveInstalledRestrictedCode(distroName: string): Promise<InstalledRestrictedCode> {
    if (process.platform !== "win32") throw new Error("mapped restricted code is owned by the Windows Host");
    return resolveInstalledRestrictedCodeForTest(distroName, {
        packageRootPath: resolveWin32PackagedWorkerPath(win32.join(__dirname, "restricted-wsl")),
        environment: process.env,
        readManifest: readRegularFileNoFollow,
        inspectExecutable: inspectRegularFileNoFollow,
        invoke: invokeLocalExecutableTreeBounded,
    });
}

/** @internal Filesystem and process seams preserve the real package/parser/cleanup gates. */
export async function resolveInstalledRestrictedCodeForTest(
    distroName: string,
    dependencies: LocationDependencies,
): Promise<InstalledRestrictedCode> {
    let setup: {
        wslExecutablePath: string;
        wslIdentity: ReturnType<typeof inspectRegularFileNoFollow> & { entryKind: "file" };
        manifest: RestrictedCodePackage["manifest"];
    };
    try {
        createSelectedWslPathProjection(distroName, `\\\\wsl.localhost\\${distroName}\\`);
        const root = dependencies.packageRootPath;
        if (
            !/^[a-z]:\\/iu.test(root) ||
            win32.normalize(root) !== root ||
            root.includes("\0") ||
            resolveWin32PackagedWorkerPath(root) !== root
        )
            throw new Error("restricted package requires one physical Windows installation directory");
        const raw = dependencies.readManifest(win32.join(root, "manifest.json"), 64 * 1024).bytes;
        const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
        requireRestrictedArtifactManifest(parsed);
        const manifest = Object.freeze({
            ...parsed,
            files: Object.freeze(parsed.files.map((file) => Object.freeze({ ...file }))),
        });
        const wslExecutablePath = resolveRestrictedWslExecutable(dependencies.environment);
        const wslIdentity = dependencies.inspectExecutable(wslExecutablePath);
        if (wslIdentity.entryKind !== "file") throw new Error("WSL executable is not a regular file");
        setup = { wslExecutablePath, wslIdentity: { ...wslIdentity, entryKind: "file" }, manifest };
    } catch (error) {
        throw new RestrictedProcessStartError(true, error);
    }
    let result: Awaited<ReturnType<LocationDependencies["invoke"]>>;
    try {
        const systemRoot = win32.dirname(win32.dirname(setup.wslExecutablePath));
        // Match Shared's fixed wslpath lookup owner. A short OS path conversion need not
        // survive a Linux process sample; the later service retains that stronger gate.
        result = await dependencies.invoke(
            setup.wslExecutablePath,
            setup.wslIdentity,
            [
                "-d",
                distroName,
                "--exec",
                "/usr/bin/env",
                "-i",
                "LC_ALL=C",
                "/usr/bin/wslpath",
                "-a",
                "-u",
                "--",
                win32.join(dependencies.packageRootPath, "code"),
            ],
            win32.dirname(setup.wslExecutablePath),
            [
                { name: "SystemRoot", value: systemRoot },
                { name: "WINDIR", value: systemRoot },
            ],
            randomBytes(32).toString("hex"),
            10_000,
            32_768,
        );
    } catch (error) {
        throw new RestrictedProcessStartError(false, error);
    }
    if (
        result.status !== "complete" ||
        result.exitCode !== 0 ||
        result.signal !== null ||
        result.failureCode !== "" ||
        !result.cleanupComplete ||
        !result.invocationTokenAbsent ||
        result.stderr.byteLength !== 0
    )
        throw new RestrictedProcessStartError(
            result.cleanupComplete && result.invocationTokenAbsent,
            new Error(`restricted package path mapping failed: ${result.failureCode}`),
        );
    try {
        const output = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
        if (!output.endsWith("\n")) throw new Error("restricted package mapping lacks its line terminator");
        const rootPath = output.slice(0, -1);
        if (
            rootPath.includes("\n") ||
            rootPath.includes("\r") ||
            rootPath.normalize("NFC") !== rootPath ||
            posix.normalize(rootPath) !== rootPath
        )
            throw new Error("restricted package mapping is not canonical");
        const code = Object.freeze({ rootPath, manifest: setup.manifest });
        requireRestrictedCodePackage(code);
        return Object.freeze({
            wslExecutablePath: setup.wslExecutablePath,
            windowsCodeRootPath: win32.join(dependencies.packageRootPath, "code"),
            code,
        });
    } catch (error) {
        throw new RestrictedProcessStartError(true, error);
    }
}
