import { win32 } from "node:path";

/** Resolve the system executable before the caller performs its no-follow identity check. */
export function requireRestrictedWslExecutable(candidate: string, environment: NodeJS.ProcessEnv): string {
    const executable = resolveRestrictedWslExecutable(environment);
    if (
        typeof candidate !== "string" ||
        candidate.includes("\0") ||
        !win32.isAbsolute(candidate) ||
        win32.normalize(candidate).toLowerCase() !== executable.toLowerCase()
    )
        throw new Error("untrusted WSL executable path");
    return executable;
}

export function resolveRestrictedWslExecutable(environment: NodeJS.ProcessEnv): string {
    const directories = Object.entries(environment)
        .filter(([key, value]) => /^(?:systemroot|windir)$/iu.test(key) && value !== undefined)
        .map(([, value]) => value!);
    const systemRoot = directories[0];
    if (systemRoot === undefined || systemRoot.includes("\0") || !win32.isAbsolute(systemRoot))
        throw new Error("trusted Windows system directory is unavailable");
    const normalized = win32.normalize(systemRoot);
    const drive = win32.parse(normalized).root;
    if (
        !/^[a-z]:\\$/iu.test(drive) ||
        normalized.toLowerCase() !== win32.join(drive, "Windows").toLowerCase() ||
        directories.some((value) => win32.normalize(value).toLowerCase() !== normalized.toLowerCase())
    )
        throw new Error("trusted Windows system directories disagree or are noncanonical");
    return win32.join(normalized, "System32", "wsl.exe");
}
