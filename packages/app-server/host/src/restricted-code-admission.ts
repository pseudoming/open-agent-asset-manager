import { createHash } from "node:crypto";
import { posix } from "node:path";
import { readRegularFileNoFollow } from "@oaam/shared/filesystem";
import { RestrictedCodePackageError, type RestrictedCodePackage } from "./restricted-code-package";
import type { RestrictedPipeSession } from "./restricted-pipe-dispatch";

/** Private evidence from the owning Windows worker, never a public approval or cached capability. */
export interface WindowsRestrictedCodeVerification {
    readonly bindingHash: string;
}

export function restrictedCodeLaunchBinding(code: RestrictedCodePackage, session: RestrictedPipeSession): string {
    return createHash("sha256")
        .update(
            JSON.stringify([
                session.protocol,
                session.hostInstanceId,
                session.sessionId,
                code.rootPath,
                code.manifest.schemaVersion,
                code.manifest.platform,
                code.manifest.architecture,
                code.manifest.nodeVersion,
                code.manifest.nodeModulesVersion,
                code.manifest.files.map((file) => [file.relativePath, file.bytes, file.sha256, file.executable]),
            ]),
        )
        .digest("hex");
}

export function requireWindowsRestrictedCodeVerification(
    value: unknown,
    code: RestrictedCodePackage,
    session: RestrictedPipeSession,
): asserts value is WindowsRestrictedCodeVerification {
    if (
        value === null ||
        typeof value !== "object" ||
        Object.keys(value).join(",") !== "bindingHash" ||
        !("bindingHash" in value) ||
        typeof value.bindingHash !== "string" ||
        !/^[a-f0-9]{64}$/u.test(value.bindingHash) ||
        value.bindingHash !== restrictedCodeLaunchBinding(code, session)
    )
        throw new Error("Windows code verification does not bind this exact service launch");
}

/** Check the executing bundle's location and current bytes, not just the launch request's claims. */
export function verifyRestrictedLoadedEntry(code: RestrictedCodePackage, loadedEntryPath: string): void {
    const relativePath = "restricted-wsl.cjs";
    if (loadedEntryPath !== posix.join(code.rootPath, relativePath))
        throw new Error("loaded restricted entry is outside the verified package");
    const expected = code.manifest.files.find((file) => file.relativePath === relativePath);
    if (expected === undefined) throw new Error("restricted entry is absent from its manifest");
    const observed = readRegularFileNoFollow(loadedEntryPath, expected.bytes);
    if (observed.bytes.byteLength !== expected.bytes) throw new RestrictedCodePackageError("metadata_changed", relativePath);
    if (createHash("sha256").update(observed.bytes).digest("hex") !== expected.sha256)
        throw new RestrictedCodePackageError("digest_mismatch", relativePath);
}
