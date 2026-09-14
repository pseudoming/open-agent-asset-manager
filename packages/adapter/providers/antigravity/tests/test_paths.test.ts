import { describe, it, expect } from "vitest";
import { getPathRule } from "../src/antigravity-paths";

describe("antigravity getPathRule", () => {
    const wslHome = "\\\\wsl.localhost\\Ubuntu\\home\\tester";

    it("returns path rule for darwin", () => {
        const rule = getPathRule("darwin");
        expect(rule).not.toBeNull();
        expect(rule?.platform).toBe("darwin");
        expect(rule?.appSummariesPath).toContain("agyhub_summaries_proto.pb");
    });

    it("returns path rule for linux", () => {
        const rule = getPathRule("linux", "/fixture/home");
        expect(rule).not.toBeNull();
        expect(rule?.platform).toBe("linux");
        expect(rule?.cliSummariesDbPath).toBe("/fixture/home/.gemini/antigravity-cli/conversation_summaries.db");
    });

    it("returns path rule for wsl (same as linux subdir)", () => {
        const rule = getPathRule("wsl");
        expect(rule).not.toBeNull();
        expect(rule?.platform).toBe("wsl");
        expect(getPathRule("wsl", wslHome)?.cliDataRoot).toBe(`${wslHome}\\.gemini\\antigravity-cli`);
    });

    it("returns path rule for win32", () => {
        const rule = getPathRule("win32");
        expect(rule).not.toBeNull();
        expect(rule?.platform).toBe("win32");
        expect(getPathRule("win32", "C:\\Users\\tester")?.familyRoot).toBe("C:\\Users\\tester\\.gemini");
    });

    it("rejects relative, empty, NUL-bearing, and unreviewed UNC home roots", () => {
        expect(getPathRule("linux", "relative-home")).toBeNull();
        expect(getPathRule("linux", "")).toBeNull();
        expect(getPathRule("linux", "/home/\0unsafe")).toBeNull();
        expect(getPathRule("win32", "\\\\server\\share")).toBeNull();
    });
});
