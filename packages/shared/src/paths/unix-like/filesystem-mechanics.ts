import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { dirname } from "node:path";
import { acquireLinuxFileLock } from "./file-lock";

/**
 * Atomic file write: write to `<dest>.<random>.tmp` then rename onto `dest`.
 * This helper belongs to the selected Unix-like build. The Win32 build exposes
 * its independently verified mechanics and keeps this legacy runtime-target
 * operation typed-unsupported until an exact target requires it.
 */
export function atomicWriteFile(dest: string, data: string | Uint8Array): void {
    const dir = dirname(dest);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const tmp = `${dest}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, data);
    try {
        fs.renameSync(tmp, dest);
    } catch (err) {
        // Best-effort cleanup of the tmp file if rename failed.
        try {
            fs.unlinkSync(tmp);
        } catch {
            // ignore cleanup error; the rename error is the real one
        }
        throw err;
    }
}

/**
 * Linux holds a nonblocking kernel lease over a persistent neutral file;
 * closing its descriptor or process exit releases the lease without unlinking.
 * Other Unix-like targets retain their existing exclusive-create mechanism.
 * Both return null for an active holder and a release callback on acquisition.
 */
export const lockFile = process.platform === "linux" ? acquireLinuxFileLock : lockExclusiveCreateFile;

/** The existing non-Linux Unix path retains its separately evidenced mechanism. */
function lockExclusiveCreateFile(lockPath: string): (() => void) | null {
    try {
        // 'x' flag = fail if file exists. fd auto-closed by openSync handle.
        const fd = fs.openSync(lockPath, "wx");
        // Write the holder pid for diagnostics; ignore write failure.
        try {
            fs.writeFileSync(fd, String(process.pid));
        } catch {
            // ignore — lock existence is what matters, not contents
        }
        fs.closeSync(fd);
        return () => {
            try {
                fs.unlinkSync(lockPath);
            } catch {
                // ignore — lock may have been removed already
            }
        };
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EEXIST") return null;
        throw err; // unexpected error (permission, ENOENT dir, etc.)
    }
}

/** Both owner-executable states are supported by the Unix-like target build. */
export function assertExecutableStateSupported(_filePath: string, _executable: boolean): void {
    // Capability preflight is intentionally free of filesystem I/O.
}

/**
 * Set the owner execute bit on `filePath` only if it differs from the current
 * owner-execute state. Returns true if a chmod was performed and false if the
 * selected Unix-like file already has the requested state.
 *
 * Semantics: only the OWNER execute bit (0o100) is considered — both for the
 * "currently executable?" check and for the chmod. This is intentional: v1
 * deploys manage owner-execute, and group/other bits follow the existing mode.
 * A file whose group/other execute bits are set but owner is not (rare, e.g.
 * mode 0o610) is treated as NOT executable here; requesting executable=true will
 * set owner execute (and leave the others untouched).
 */
export function chmodIfDifferent(filePath: string, executable: boolean): boolean {
    try {
        const stat = fs.statSync(filePath);
        const currentlyOwnerExecutable = (stat.mode & 0o100) !== 0;
        if (currentlyOwnerExecutable === executable) return false;
        // Preserve owner r/w and all group/other bits; set/clear only owner execute.
        const baseMode = stat.mode & 0o777;
        const newMode = executable ? baseMode | 0o100 : baseMode & ~0o100;
        fs.chmodSync(filePath, newMode);
        return true;
    } catch {
        return false;
    }
}
