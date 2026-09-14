import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function canCreateDirectorySymlink() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-symlink-capability-"));
    try {
        const target = path.join(root, "target");
        fs.mkdirSync(target);
        fs.symlinkSync(target, path.join(root, "link"), "dir");
        return fs.lstatSync(path.join(root, "link")).isSymbolicLink();
    } catch {
        return false;
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

export const DIRECTORY_SYMLINK_SUPPORTED = canCreateDirectorySymlink();
