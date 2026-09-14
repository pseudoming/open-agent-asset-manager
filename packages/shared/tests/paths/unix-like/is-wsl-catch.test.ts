import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return {
        ...actual,
        readFileSync: vi.fn(),
    };
});

describe("isWsl - catch branch (fs.readFileSync throws)", () => {
    let originalEnv: NodeJS.ProcessEnv;

    afterEach(() => {
        process.env = { ...originalEnv };
        vi.clearAllMocks();
    });

    it("returns false when /proc/version read throws", async () => {
        originalEnv = { ...process.env };
        delete process.env.WSL_DISTRO_NAME;
        const fs = await import("node:fs");
        const fsMock = vi.mocked(fs);
        fsMock.readFileSync.mockImplementationOnce(() => {
            throw new Error("ENOENT");
        });

        const { isWsl } = await import("../../../src/paths/unix-like/path-environment");
        expect(isWsl()).toBe(false);
    });
});
