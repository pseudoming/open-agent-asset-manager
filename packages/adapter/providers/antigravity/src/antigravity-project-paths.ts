/** Provider-owned workspace encoding; this does not establish workspace access or target authority. */
import * as path from "node:path";
import type { Platform } from "@oaam/core";

export function canonicalWorkspacePath(raw: string, platform: Platform): string | null {
    if (raw === "") return null;
    let workspacePath = raw;
    if (raw.startsWith("file://")) {
        try {
            const url = new URL(raw);
            const isWslHost = platform === "win32" && /^(?:wsl\.localhost|wsl\$)$/iu.test(url.hostname);
            if (
                url.protocol !== "file:" ||
                (url.hostname !== "" && url.hostname !== "localhost" && !isWslHost) ||
                url.search !== "" ||
                url.hash !== ""
            )
                return null;
            workspacePath = decodeURIComponent(url.pathname);
            if (isWslHost) {
                if (raw.slice(raw.indexOf("/", "file://".length)) !== url.pathname) return null;
                const segments = workspacePath.slice(1).split("/");
                if (
                    segments.length < 2 ||
                    segments.some(
                        (segment) =>
                            segment === "" ||
                            segment === "." ||
                            segment === ".." ||
                            segment.trim() !== segment ||
                            segment.endsWith(".") ||
                            [...segment].some((character) => character.charCodeAt(0) < 0x20 || '\\/:*?"<>|'.includes(character)),
                    )
                )
                    return null;
                workspacePath = `\\\\${url.hostname}\\${segments.join("\\")}`;
            }
            if (platform === "win32" && /^\/[A-Za-z]:\//u.test(workspacePath)) {
                workspacePath = workspacePath.slice(1).replaceAll("/", "\\");
            }
        } catch {
            return null;
        }
    }
    return canonicalRuntimeWorkspacePath(workspacePath, platform);
}

export function canonicalRuntimeWorkspacePath(value: string, platform: Platform): string | null {
    if (value.includes("\0")) return null;
    const paths = platform === "win32" ? path.win32 : path.posix;
    return paths.isAbsolute(value) && paths.normalize(value) === value ? value.normalize("NFC") : null;
}
