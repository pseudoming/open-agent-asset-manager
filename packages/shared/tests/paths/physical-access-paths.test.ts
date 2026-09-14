import { describe, expect, it } from "vitest";
import {
    canonicalPhysicalAccessPath,
    getCanonicalPhysicalAccessPathKind,
    isAbsolutePhysicalAccessPathForRoot,
    isCanonicalPhysicalAccessPath,
    joinPhysicalAccessPath,
    normalizePhysicalAccessPathWithinRoot,
    physicalAccessPathContains,
    relatePhysicalAccessPaths,
    splitPhysicalAccessPath,
} from "../../src/paths/physical-access-paths";

const WSL_ROOT = "\\\\wsl.localhost\\Ubuntu\\";
const WSL_HOME = "\\\\wsl.localhost\\Ubuntu\\home\\example";

describe("Host-visible physical access path mechanics", () => {
    it("validates canonical paths and normalizes only Unicode spelling", () => {
        expect(canonicalPhysicalAccessPath("/home/example/cafe\u0301")).toBe("/home/example/caf\u00e9");
        expect(canonicalPhysicalAccessPath("C:\\Users\\agent")).toBe("C:\\Users\\agent");
        expect(canonicalPhysicalAccessPath("/home/../agent")).toBeNull();
        expect(canonicalPhysicalAccessPath("relative")).toBeNull();
    });

    it("detects canonical POSIX, drive and UNC paths without accepting aliases or device namespaces", () => {
        expect(getCanonicalPhysicalAccessPathKind("/home/example")).toBe("posix");
        expect(getCanonicalPhysicalAccessPathKind("C:\\Users\\person")).toBe("win32");
        expect(getCanonicalPhysicalAccessPathKind(WSL_HOME)).toBe("win32");
        expect(isCanonicalPhysicalAccessPath(WSL_ROOT)).toBe(true);

        for (const value of [
            null,
            "",
            "relative",
            "/home/../root",
            "C:/Users/person",
            "\\root-relative",
            "\\\\?\\C:\\Users\\person",
            "\\\\.\\C:\\Users\\person",
            "1:\\invalid-drive",
            "bad\0path",
        ]) {
            expect(getCanonicalPhysicalAccessPathKind(value)).toBeNull();
        }
    });

    it("checks raw absolute selections using the configured access-root grammar", () => {
        expect(isAbsolutePhysicalAccessPathForRoot("C:/Users/person/project", "C:\\Users\\person")).toBe(true);
        expect(isAbsolutePhysicalAccessPathForRoot("/home/example/project", "/home/example")).toBe(true);
        expect(isAbsolutePhysicalAccessPathForRoot(`${WSL_HOME}\\project`, WSL_HOME)).toBe(true);
        expect(isAbsolutePhysicalAccessPathForRoot("/home/example/project", WSL_HOME)).toBe(false);
        expect(isAbsolutePhysicalAccessPathForRoot("C:\\Users\\person", "/home/example")).toBe(false);
        expect(isAbsolutePhysicalAccessPathForRoot("relative", WSL_HOME)).toBe(false);
        expect(isAbsolutePhysicalAccessPathForRoot("bad\0path", WSL_HOME)).toBe(false);
        expect(isAbsolutePhysicalAccessPathForRoot(5, WSL_HOME)).toBe(false);
        expect(isAbsolutePhysicalAccessPathForRoot(WSL_HOME, "relative-root")).toBe(false);
    });

    it("normalizes a selected path only inside the configured physical access root", () => {
        expect(normalizePhysicalAccessPathWithinRoot("C:/Users/person/project", "C:\\Users\\person")).toBe(
            "C:\\Users\\person\\project",
        );
        expect(normalizePhysicalAccessPathWithinRoot(`${WSL_HOME}\\project`, WSL_HOME)).toBe(`${WSL_HOME}\\project`);
        expect(normalizePhysicalAccessPathWithinRoot("D:\\project", "C:\\Users")).toBeNull();
        expect(normalizePhysicalAccessPathWithinRoot("/home/example", WSL_ROOT)).toBeNull();
        expect(normalizePhysicalAccessPathWithinRoot("relative", WSL_ROOT)).toBeNull();
        expect(normalizePhysicalAccessPathWithinRoot("bad\0path", WSL_ROOT)).toBeNull();
        expect(normalizePhysicalAccessPathWithinRoot(WSL_HOME, "relative-root")).toBeNull();
    });

    it("checks containment without crossing physical path grammars", () => {
        expect(physicalAccessPathContains(WSL_ROOT, WSL_ROOT)).toBe(true);
        expect(physicalAccessPathContains(WSL_ROOT, WSL_HOME)).toBe(true);
        expect(physicalAccessPathContains(WSL_HOME, WSL_ROOT)).toBe(false);
        expect(physicalAccessPathContains("C:\\Users", "D:\\Users")).toBe(false);
        expect(physicalAccessPathContains(WSL_ROOT, "/home/example")).toBe(false);
        expect(physicalAccessPathContains("relative", WSL_HOME)).toBe(false);
    });

    it("joins and splits portable relative contract paths with the physical root grammar", () => {
        expect(joinPhysicalAccessPath("/home/example", "skills/demo/SKILL.md")).toBe("/home/example/skills/demo/SKILL.md");
        expect(joinPhysicalAccessPath(WSL_HOME, "skills/demo/SKILL.md")).toBe(`${WSL_HOME}\\skills\\demo\\SKILL.md`);
        expect(joinPhysicalAccessPath(WSL_HOME, "")).toBe(WSL_HOME);
        expect(splitPhysicalAccessPath(`${WSL_HOME}\\AGENTS.md`)).toEqual({ parentPath: WSL_HOME, name: "AGENTS.md" });
        expect(splitPhysicalAccessPath("/home/example/AGENTS.md")).toEqual({
            parentPath: "/home/example",
            name: "AGENTS.md",
        });
        expect(() => joinPhysicalAccessPath("relative", "AGENTS.md")).toThrow(TypeError);
        for (const invalid of ["../escape.md", "a//b.md", "a/./b.md", "a\\b.md", "a/b.md/"]) {
            expect(() => joinPhysicalAccessPath(WSL_HOME, invalid)).toThrow(TypeError);
        }
        expect(() => splitPhysicalAccessPath("relative")).toThrow(TypeError);
        expect(() => splitPhysicalAccessPath("C:\\")).toThrow(TypeError);
    });

    it("relates canonical paths while treating cross-grammar aliases as unresolved and disjoint", () => {
        expect(relatePhysicalAccessPaths(WSL_HOME, WSL_HOME)).toEqual({ kind: "equal" });
        expect(relatePhysicalAccessPaths(WSL_HOME, `${WSL_HOME}\\skills\\demo`)).toEqual({
            kind: "root_contains_candidate",
            relativePath: "skills/demo",
        });
        expect(relatePhysicalAccessPaths(`${WSL_HOME}\\skills`, WSL_HOME)).toEqual({ kind: "candidate_contains_root" });
        expect(relatePhysicalAccessPaths(`${WSL_HOME}\\skills`, `${WSL_HOME}\\agents`)).toEqual({ kind: "disjoint" });
        expect(relatePhysicalAccessPaths(WSL_HOME, "/home/example")).toEqual({ kind: "disjoint" });
        expect(() => relatePhysicalAccessPaths("relative", WSL_HOME)).toThrow(TypeError);
    });
});
