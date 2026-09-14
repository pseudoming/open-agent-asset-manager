import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:child_process")>();
    return {
        ...actual,
        execSync: vi.fn(),
    };
});

describe("getWslDistroNames - catch branch (execSync throws)", () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it("returns empty array when wsl.exe fails", async () => {
        const cp = await import("node:child_process");
        const cpMock = vi.mocked(cp);
        cpMock.execSync.mockImplementationOnce(() => {
            throw new Error("wsl.exe not found");
        });

        const { getWslDistroNames } = await import("../../../src/paths/win32/path-environment");
        expect(getWslDistroNames()).toEqual([]);
    });
});
