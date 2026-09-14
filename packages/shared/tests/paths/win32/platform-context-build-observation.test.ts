import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { observePlatformContextBuildArtifactsBoundedForTest } from "../../../src/paths/win32/path-environment";

describe("platform-context build observation wave", () => {
    it("hashes a local artifact once and releases the retained bytes", async () => {
        const bytes = new Uint8Array([1, 2, 3]);
        const result = await observePlatformContextBuildArtifactsBoundedForTest(
            {
                platform: "win32",
                platformInstanceId: "desktop-local",
                accessRootPath: "C:\\fixture",
                filePaths: ["C:\\fixture\\agent.exe"],
                maximumConcurrency: 1,
                timeoutMilliseconds: 1_000,
            },
            {
                readRegularFile: vi.fn(async () => ({
                    bytes,
                    executable: true,
                    identity: { deviceId: "3", fileId: "4", entryKind: "file" as const },
                })),
            },
        );
        expect(result.items[0]).toMatchObject({
            status: "complete",
            sha256Hex: createHash("sha256")
                .update(new Uint8Array([1, 2, 3]))
                .digest("hex"),
        });
        expect(bytes).toEqual(new Uint8Array(3));
    });

    it("bounds local reads and preserves input order", async () => {
        let active = 0;
        let maximumActive = 0;
        const releases: (() => void)[] = [];
        const readRegularFile = vi.fn(
            async ({ filePath }: { readonly filePath: string }) =>
                new Promise<{
                    bytes: Uint8Array;
                    executable: boolean;
                    identity: { deviceId: string; fileId: string; entryKind: "file" };
                }>((resolve) => {
                    active += 1;
                    maximumActive = Math.max(maximumActive, active);
                    releases.push(() => {
                        active -= 1;
                        resolve({
                            bytes: new TextEncoder().encode(filePath),
                            executable: true,
                            identity: { deviceId: "3", fileId: filePath, entryKind: "file" },
                        });
                    });
                }),
        );
        const terminal = observePlatformContextBuildArtifactsBoundedForTest(
            {
                platform: "win32",
                platformInstanceId: "desktop-local",
                accessRootPath: "C:\\fixture",
                filePaths: ["C:\\fixture\\a.exe", "C:\\fixture\\b.exe", "C:\\fixture\\c.exe"],
                maximumConcurrency: 2,
                timeoutMilliseconds: 1_000,
            },
            { readRegularFile },
        );
        await vi.waitFor(() => expect(releases).toHaveLength(2));
        releases.shift()?.();
        await vi.waitFor(() => expect(releases).toHaveLength(2));
        releases.shift()?.();
        releases.shift()?.();

        const result = await terminal;
        expect(maximumActive).toBe(2);
        expect(result.maximumConcurrencyObserved).toBe(2);
        expect(result.items.map((item) => item.filePath)).toEqual([
            "C:\\fixture\\a.exe",
            "C:\\fixture\\b.exe",
            "C:\\fixture\\c.exe",
        ]);
    });

    it.each([
        { filePaths: ["C:\\fixture\\a.exe", "C:\\fixture\\a.exe"] },
        { maximumConcurrency: 0 },
        { maximumConcurrency: 9 },
        { timeoutMilliseconds: 10_001 },
    ])("rejects each invalid build-observation bound before any read: %j", async (change) => {
        const readRegularFile = vi.fn();
        await expect(
            observePlatformContextBuildArtifactsBoundedForTest(
                {
                    platform: "win32",
                    platformInstanceId: "desktop-local",
                    accessRootPath: "C:\\fixture",
                    filePaths: ["C:\\fixture\\a.exe"],
                    maximumConcurrency: 1,
                    timeoutMilliseconds: 1_000,
                    ...change,
                },
                { readRegularFile },
            ),
        ).rejects.toThrow();
        expect(readRegularFile).not.toHaveBeenCalled();
    });
    it("requires Linux execution for a selected WSL build before any read", async () => {
        const readRegularFile = vi.fn();
        await expect(
            observePlatformContextBuildArtifactsBoundedForTest(
                {
                    platform: "wsl",
                    platformInstanceId: "Ubuntu",
                    accessRootPath: "\\\\wsl.localhost\\Ubuntu\\",
                    filePaths: ["\\\\wsl.localhost\\Ubuntu\\bin\\agent"],
                    maximumConcurrency: 1,
                    timeoutMilliseconds: 1000,
                },
                { readRegularFile },
            ),
        ).rejects.toMatchObject({ systemCode: "WSL_READ_REQUIRES_LINUX_EXECUTION" });
        expect(readRegularFile).not.toHaveBeenCalled();
    });
});
