import { describe, expect, it } from "vitest";
import { createSelectedWslPathProjection, isSelectedWslPhysicalRootMapping } from "../../src/paths/selected-wsl-path-projection";

describe("selected WSL physical root mapping", () => {
    it("matches exact selected UNC roots and same-process POSIX roots", () => {
        expect(isSelectedWslPhysicalRootMapping("\\\\wsl.localhost\\Ubuntu\\tmp\\owned", "/tmp/owned", "Ubuntu")).toBe(true);
        expect(isSelectedWslPhysicalRootMapping("/tmp/owned", "/tmp/owned", "Ubuntu")).toBe(true);
    });

    it.each([
        ["\\\\wsl.localhost\\Debian\\tmp\\owned", "/tmp/owned", "Ubuntu"],
        ["\\\\wsl.localhost\\Ubuntu\\tmp\\other", "/tmp/owned", "Ubuntu"],
        ["\\\\wsl$\\Ubuntu\\tmp\\owned", "/tmp/owned", "Ubuntu"],
        ["\\\\wsl.localhost\\Ubuntu\\tmp\\owned\\", "/tmp/owned", "Ubuntu"],
        ["\\\\wsl.localhost\\Ubuntu\\tmp\\owned.", "/tmp/owned.", "Ubuntu"],
        ["/tmp/owned/../other", "/tmp/owned/../other", "Ubuntu"],
        ["/tmp//owned", "/tmp//owned", "Ubuntu"],
        ["/", "/", "Ubuntu"],
        ["/tmp/owned\0", "/tmp/owned\0", "Ubuntu"],
        ["/tmp/owned", "/tmp/owned", "../Ubuntu"],
        ["/tmp/e\u0301", "/tmp/e\u0301", "Ubuntu"],
    ])("rejects ambiguous or mismatched mapping %j → %j (%s)", (host, execution, distro) => {
        expect(isSelectedWslPhysicalRootMapping(host, execution, distro)).toBe(false);
    });
});

describe("selected WSL observation path coordinates", () => {
    it("round-trips the selected distro root and case-sensitive Unicode descendants", () => {
        const root = "\\\\wsl.localhost\\Ubuntu\\";
        const projection = createSelectedWslPathProjection("Ubuntu", root);
        expect(projection.executionAccessRootPath).toBe("/");
        for (const value of ["/", "/home/User/项目/AGENTS.md", "/tmp/space name"]) {
            expect(projection.toExecution(projection.toHost(value))).toBe(value);
        }
        expect(projection.toHost("/")).toBe(root);
        const nested = createSelectedWslPathProjection("Ubuntu", root + "home\\User");
        expect(nested.toExecution(root + "home\\User")).toBe("/home/User");
        expect(() => nested.toHost("/home/user/asset")).toThrow(/outside/);
        expect(() => nested.toExecution(root + "home\\User2\\asset")).toThrow(/outside/);
    });

    it.each([
        "/tmp/a/../b",
        "/tmp//a",
        "/tmp/a/",
        "/tmp/a\\b",
        "/tmp/a:b",
        "/tmp/a.",
        "/tmp/e\u0301",
        "relative",
        "/tmp/a\0",
    ])("rejects a lossy execution path %j", (value) => {
        expect(() => createSelectedWslPathProjection("Ubuntu", "\\\\wsl.localhost\\Ubuntu\\").toHost(value)).toThrow();
    });

    it("rejects a foreign distribution and never accepts a Windows drive as a WSL binding", () => {
        expect(() => createSelectedWslPathProjection("Ubuntu", "\\\\wsl.localhost\\Debian\\")).toThrow();
        expect(() => createSelectedWslPathProjection("Ubuntu", "C:\\")).toThrow();
        const projection = createSelectedWslPathProjection("Ubuntu", "\\\\wsl.localhost\\Ubuntu\\");
        expect(() => projection.toExecution("\\\\wsl.localhost\\Debian\\tmp\\asset")).toThrow();
    });
});
