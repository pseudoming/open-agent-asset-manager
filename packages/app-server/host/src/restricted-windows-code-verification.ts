import { win32 } from "node:path";
import { performance } from "node:perf_hooks";
import { readRegularFileNoFollow } from "@oaam/shared/filesystem";
import { requireRestrictedArtifactManifest } from "./restricted-artifact-package";
import { restrictedCodeLaunchBinding, type WindowsRestrictedCodeVerification } from "./restricted-code-admission";
import { verifyRestrictedCodeInventory, type RestrictedCodeVerificationTiming } from "./restricted-code-inventory";
import { requireRestrictedCodePackage, type RestrictedCodePackage } from "./restricted-code-package";
import type { RestrictedPipeSession } from "./restricted-pipe-dispatch";

/** The Windows process verifies current local files immediately before creating its owned WSL child. */
export function verifyWindowsRestrictedCodePackage(
    windowsCodeRootPath: string,
    code: RestrictedCodePackage,
    session: RestrictedPipeSession,
): { readonly verification: WindowsRestrictedCodeVerification; readonly timing: RestrictedCodeVerificationTiming } {
    const started = performance.now();
    if (
        process.platform !== "win32" ||
        typeof windowsCodeRootPath !== "string" ||
        !/^[a-z]:\\/iu.test(windowsCodeRootPath) ||
        win32.normalize(windowsCodeRootPath) !== windowsCodeRootPath ||
        windowsCodeRootPath.endsWith("\\") ||
        windowsCodeRootPath.includes("\0") ||
        win32.basename(windowsCodeRootPath) !== "code"
    )
        throw new Error("Windows code verification requires the exact physical installed code directory");
    requireRestrictedCodePackage(code);
    const readStarted = performance.now();
    const currentBytes = readRegularFileNoFollow(
        win32.join(win32.dirname(windowsCodeRootPath), "manifest.json"),
        64 * 1024,
    ).bytes;
    const manifestReadMilliseconds = performance.now() - readStarted;
    const manifest: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(currentBytes));
    requireRestrictedArtifactManifest(manifest);
    const bindingHash = restrictedCodeLaunchBinding({ rootPath: code.rootPath, manifest }, session);
    if (bindingHash !== restrictedCodeLaunchBinding(code, session))
        throw new Error("restricted package manifest changed before its process launch");
    const timing = verifyRestrictedCodeInventory(windowsCodeRootPath, manifest, win32, false);
    return Object.freeze({
        verification: Object.freeze({ bindingHash }),
        timing: Object.freeze({
            ...timing,
            stableReadMilliseconds: timing.stableReadMilliseconds + manifestReadMilliseconds,
            totalMilliseconds: performance.now() - started,
        }),
    });
}
