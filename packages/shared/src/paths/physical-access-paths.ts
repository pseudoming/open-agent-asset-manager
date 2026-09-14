/** Runtime-neutral mechanics for canonical Host-visible absolute paths. */

import * as path from "node:path";

export type PhysicalAccessPathKind = "posix" | "win32";

export type PhysicalAccessPathRelation =
    | { kind: "equal" }
    | { kind: "root_contains_candidate"; relativePath: string }
    | { kind: "candidate_contains_root" }
    | { kind: "disjoint" };

/**
 * Detect the grammar of one already-canonical Host-visible absolute path.
 *
 * Win32 root-relative paths (`\\foo`) and device namespaces (`\\?\\`, `\\.\\`)
 * are deliberately rejected. They do not name one ordinary drive/UNC location
 * with the stable spelling required by Core source authority and physical locks.
 */
export function getCanonicalPhysicalAccessPathKind(value: unknown): PhysicalAccessPathKind | null {
    if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return null;
    const posix = path.posix.isAbsolute(value) && path.posix.normalize(value) === value;
    const win32 = isCanonicalWin32AbsolutePath(value);
    if (posix === win32) return null;
    return win32 ? "win32" : "posix";
}

export function isCanonicalPhysicalAccessPath(value: unknown): value is string {
    return getCanonicalPhysicalAccessPathKind(value) !== null;
}

/** Validate one canonical Host-visible absolute path and normalize only its Unicode spelling. */
export function canonicalPhysicalAccessPath(value: unknown): string | null {
    const kind = getCanonicalPhysicalAccessPathKind(value);
    if (kind === null) return null;
    const canonical = (value as string).normalize("NFC");
    return getCanonicalPhysicalAccessPathKind(canonical) === kind ? canonical : null;
}

/** Check whether a raw selected path is absolute in its configured access-root grammar. */
export function isAbsolutePhysicalAccessPathForRoot(value: unknown, accessRootPath: string): value is string {
    if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return false;
    const rootKind = getCanonicalPhysicalAccessPathKind(accessRootPath);
    if (rootKind === null) return false;
    const suppliedKind = getCanonicalPhysicalAccessPathKind(value);
    if (suppliedKind !== null && suppliedKind !== rootKind) return false;
    return (rootKind === "win32" ? path.win32 : path.posix).isAbsolute(value);
}

/** Normalize a user-selected path using the grammar of its configured access root. */
export function normalizePhysicalAccessPathWithinRoot(value: unknown, accessRootPath: string): string | null {
    if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return null;
    const kind = getCanonicalPhysicalAccessPathKind(accessRootPath);
    if (kind === null) return null;
    const grammar = kind === "win32" ? path.win32 : path.posix;
    if (!grammar.isAbsolute(value)) return null;
    const canonical = grammar.normalize(value);
    return getCanonicalPhysicalAccessPathKind(canonical) === kind && physicalAccessPathContains(accessRootPath, canonical)
        ? canonical
        : null;
}

export function physicalAccessPathContains(rootPath: string, candidatePath: string): boolean {
    const rootKind = getCanonicalPhysicalAccessPathKind(rootPath);
    if (rootKind === null || rootKind !== getCanonicalPhysicalAccessPathKind(candidatePath)) return false;
    const grammar = rootKind === "win32" ? path.win32 : path.posix;
    const relative = grammar.relative(rootPath, candidatePath);
    return relative === "" || isDescendantRelative(grammar, relative);
}

/** Join one canonical POSIX-relative contract path under a Host-visible root. */
export function joinPhysicalAccessPath(rootPath: string, relativePath: string): string {
    const kind = getCanonicalPhysicalAccessPathKind(rootPath);
    if (kind === null || (relativePath !== "" && !isCanonicalPortableRelativePath(relativePath))) {
        throw new TypeError("physical access join requires a canonical root and POSIX-relative path");
    }
    if (relativePath === "") return rootPath;
    return kind === "win32" ? path.win32.join(rootPath, ...relativePath.split("/")) : path.posix.join(rootPath, relativePath);
}

export function splitPhysicalAccessPath(absolutePath: string): { parentPath: string; name: string } {
    const kind = getCanonicalPhysicalAccessPathKind(absolutePath);
    if (kind === null) throw new TypeError("physical access split requires a canonical absolute path");
    const grammar = kind === "win32" ? path.win32 : path.posix;
    const parentPath = grammar.dirname(absolutePath);
    const name = grammar.basename(absolutePath);
    if (parentPath === absolutePath || name.length === 0) {
        throw new TypeError("a physical access root has no parent entry");
    }
    return { parentPath, name };
}

/** Compare two Host-visible paths without inventing Win32/WSL alias resolution. */
export function relatePhysicalAccessPaths(rootPath: string, candidatePath: string): PhysicalAccessPathRelation {
    const rootKind = getCanonicalPhysicalAccessPathKind(rootPath);
    const candidateKind = getCanonicalPhysicalAccessPathKind(candidatePath);
    if (rootKind === null || candidateKind === null) {
        throw new TypeError("physical path relation requires canonical absolute paths");
    }
    if (rootKind !== candidateKind) return { kind: "disjoint" };
    const grammar = rootKind === "win32" ? path.win32 : path.posix;
    const relative = grammar.relative(rootPath, candidatePath);
    if (relative === "") return { kind: "equal" };
    if (isDescendantRelative(grammar, relative)) {
        return {
            kind: "root_contains_candidate",
            relativePath: rootKind === "win32" ? relative.replaceAll("\\", "/") : relative,
        };
    }
    return isDescendantRelative(grammar, grammar.relative(candidatePath, rootPath))
        ? { kind: "candidate_contains_root" }
        : { kind: "disjoint" };
}

function isCanonicalPortableRelativePath(value: string): boolean {
    if (value.length === 0 || value.includes("\0") || value.includes("\\") || value.startsWith("/") || value.endsWith("/")) {
        return false;
    }
    const segments = value.split("/");
    if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return false;
    return path.posix.normalize(value) === value;
}

function isCanonicalWin32AbsolutePath(value: string): boolean {
    if (!path.win32.isAbsolute(value) || path.win32.normalize(value) !== value) return false;
    const lowered = value.toLowerCase();
    if (lowered.startsWith("\\\\?\\") || lowered.startsWith("\\\\.\\")) return false;
    const root = path.win32.parse(value).root;
    if (root === "\\" || root === "/") return false;
    return true;
}

function isDescendantRelative(grammar: typeof path.posix | typeof path.win32, value: string): boolean {
    return value !== ".." && !value.startsWith(`..${grammar.sep}`) && !grammar.isAbsolute(value);
}
