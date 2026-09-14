import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { casWriteAll } from "../../src/deployment/deployment-target-cas";
import { populateOldBytes } from "../../src/deployment/deployment-target-entries";
import { createTargetIo, rollbackToOld } from "../../src/deployment/deployment-target-io";
import { verifyAll } from "../../src/deployment/deployment-target-verify";
import { captureDeploymentPreWritePreview } from "../../src/deployment/deployment-prewrite-preview";
import { applyRuntimeReplacementAuthority } from "../../src/deployment/deployment-target-replacement";
import type { PosixRelativePath, UuidV4 } from "../../src/types";
import type { JournalEntry } from "../../src/deployment/deployment-journal";
import { b64, sha, tmpRoot } from "./fixtures/deployment-target-io-test-fixtures";

const physicalReads = vi.hoisted(() => vi.fn());
vi.mock("@oaam/shared/filesystem", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@oaam/shared/filesystem")>();
    return {
        ...actual,
        readRegularFileNoFollow: (...args: Parameters<typeof actual.readRegularFileNoFollow>) => {
            physicalReads(...args);
            return actual.readRegularFileNoFollow(...args);
        },
    };
});

function retainedEntry(relativePath = "AGENTS.md"): JournalEntry {
    return {
        relativePath,
        oldHash: sha("# retained"),
        oldBytesBase64: b64("# retained"),
        oldExecutable: false,
        newHash: sha("# retained"),
        newBytesBase64: b64("# retained"),
        newExecutable: false,
        isRemoval: false,
    };
}

describe("target stages retain fresh observations without rewriting equal files", () => {
    let root: string;
    beforeEach(() => {
        root = tmpRoot();
        fs.writeFileSync(path.join(root, "AGENTS.md"), "# retained");
        physicalReads.mockClear();
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it.each([
        false,
        true,
    ])("freshly captures later edits for confirmed replacement recovery (managed directory: %s)", (managed) => {
        const relativePath = managed ? "skills/demo/SKILL.md" : "AGENTS.md";
        const file = path.join(root, relativePath);
        if (managed) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, "# retained");
        }
        const fingerprint = sha("authority");
        const preview = captureDeploymentPreWritePreview({
            deploymentId: "11111111-1111-4111-8111-111111111111" as UuidV4,
            targetRootPath: root,
            renderInputFingerprint: fingerprint,
            selectionFingerprint: fingerprint,
            compilationFingerprint: fingerprint,
            targetPlan: {
                schemaVersion: 1,
                managedDirectoryBoundaries: managed
                    ? [{ relativePath: "skills/demo" as PosixRelativePath, outputUnitFingerprint: fingerprint }]
                    : [],
                targetFiles: [
                    {
                        relativePath: relativePath as PosixRelativePath,
                        content: { contentKind: "text", text: "# retained" },
                        executable: false,
                        outputUnitFingerprint: fingerprint,
                        materializationFingerprint: fingerprint,
                        semanticRefFingerprints: [],
                        sectionBindings: [],
                    },
                ],
            },
            baseline: [],
        });
        expect(preview.view.files[0]?.current).toMatchObject({ state: "present", contentKind: "text" });
        expect(physicalReads.mock.calls.map(([filePath]) => filePath)).toEqual([file]);
        const ctx = createTargetIo(root);
        const desiredDirectories = managed ? ["skills/demo"] : [];
        expect(
            applyRuntimeReplacementAuthority(
                [retainedEntry(relativePath)],
                ctx,
                preview.runtimeReplacementAuthority,
                desiredDirectories,
            ),
        ).toEqual({ status: "applied" });
        expect(physicalReads.mock.calls.map(([filePath]) => filePath)).toEqual([file, file]);
        fs.writeFileSync(file, "# external edit");
        const latestEntries = [retainedEntry(relativePath)];
        expect(
            applyRuntimeReplacementAuthority(latestEntries, ctx, preview.runtimeReplacementAuthority, desiredDirectories),
        ).toMatchObject({ status: "applied" });
        expect(latestEntries[0]!.runtimeRollbackOverride).toMatchObject({
            state: "present",
            bytesBase64: Buffer.from("# external edit").toString("base64"),
        });
        expect(physicalReads.mock.calls.map(([filePath]) => filePath)).toEqual([file, file, file]);
        expect(fs.readFileSync(file, "utf8")).toBe("# external edit");
    });

    it("reads once per stage and preserves the inode and timestamps for an unchanged target", () => {
        const file = path.join(root, "AGENTS.md");
        const before = fs.statSync(file, { bigint: true });
        const entries = [retainedEntry()];
        const ctx = createTargetIo(root);
        expect(populateOldBytes(entries, ctx)).toEqual({ kind: "ok" });
        expect(physicalReads).toHaveBeenCalledTimes(1);
        expect(casWriteAll(entries, ctx)).toEqual({ ok: true, written: ["AGENTS.md"], mutated: [], stop: null });
        expect(physicalReads).toHaveBeenCalledTimes(2);
        expect(verifyAll(entries, ctx)).toMatchObject({ ok: true, verified: [{ observedContentHash: sha("# retained") }] });
        expect(physicalReads).toHaveBeenCalledTimes(3);
        const after = fs.statSync(file, { bigint: true });
        expect([after.ino, after.mtimeNs, after.ctimeNs, after.mode]).toEqual([
            before.ino,
            before.mtimeNs,
            before.ctimeNs,
            before.mode,
        ]);
    });

    it.each([
        "content",
        "executable",
        "missing",
    ] as const)("final verification detects %s changes after a no-op CAS", (change) => {
        const file = path.join(root, "AGENTS.md");
        const entries = [retainedEntry()];
        const ctx = createTargetIo(root);
        expect(casWriteAll(entries, ctx).ok).toBe(true);
        if (change === "content") fs.writeFileSync(file, "# external change");
        else if (change === "executable") fs.chmodSync(file, 0o700);
        else fs.unlinkSync(file);
        const verification = verifyAll(entries, ctx);
        expect(verification.ok).toBe(false);
        expect(verification.verified).toEqual([]);
        expect(verification.failures).toHaveLength(1);
        expect(physicalReads).toHaveBeenCalledTimes(2);
    });

    it("does not accept desired content that differs from the successful baseline", () => {
        const file = path.join(root, "AGENTS.md");
        fs.writeFileSync(file, "# desired but external");
        const entry = {
            ...retainedEntry(),
            newHash: sha("# desired but external"),
            newBytesBase64: b64("# desired but external"),
        };
        expect(casWriteAll([entry], createTargetIo(root))).toEqual({
            ok: false,
            written: [],
            mutated: [],
            stop: { kind: "third_value", relativePath: "AGENTS.md" },
        });
        expect(fs.readFileSync(file, "utf8")).toBe("# desired but external");
    });

    it("does not roll back an unchanged earlier target after a later conflict", () => {
        fs.writeFileSync(path.join(root, "other.md"), "# user edit");
        const entries = [retainedEntry(), retainedEntry("other.md")];
        const ctx = createTargetIo(root);
        const result = casWriteAll(entries, ctx);
        expect(result).toEqual({
            ok: false,
            written: ["AGENTS.md"],
            mutated: [],
            stop: { kind: "third_value", relativePath: "other.md" },
        });
        fs.writeFileSync(path.join(root, "AGENTS.md"), "# later external edit");
        expect(
            rollbackToOld(
                entries.filter((entry) => result.mutated.includes(entry.relativePath)),
                ctx,
            ),
        ).toMatchObject({ ok: true });
        expect(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8")).toBe("# later external edit");
        expect(fs.readFileSync(path.join(root, "other.md"), "utf8")).toBe("# user edit");
    });

    it("writes a requested executable change even when the content is equal", () => {
        const entry = { ...retainedEntry(), newExecutable: true };
        const ctx = createTargetIo(root);
        expect(casWriteAll([entry], ctx)).toMatchObject({ ok: true, mutated: ["AGENTS.md"] });
        expect(verifyAll([entry], ctx).ok).toBe(true);
        expect(fs.statSync(path.join(root, "AGENTS.md")).mode & 0o100).toBe(0o100);
    });

    it("compares actual desired bytes rather than trusting an inconsistent desired hash", () => {
        const entry = { ...retainedEntry(), newBytesBase64: b64("# different bytes") };
        const ctx = createTargetIo(root);
        expect(casWriteAll([entry], ctx)).toMatchObject({ ok: true, mutated: ["AGENTS.md"] });
        expect(verifyAll([entry], ctx).ok).toBe(false);
    });

    it.each(["symlink", "directory"] as const)("does not classify a %s as missing", (kind) => {
        const file = path.join(root, "AGENTS.md");
        fs.unlinkSync(file);
        if (kind === "directory") fs.mkdirSync(file);
        else {
            fs.writeFileSync(path.join(root, "source.md"), "# retained");
            fs.symlinkSync(path.join(root, "source.md"), file);
        }
        expect(casWriteAll([retainedEntry()], createTargetIo(root))).toMatchObject({
            ok: false,
            mutated: [],
            stop: { kind: "write_failed", relativePath: "AGENTS.md" },
        });
    });
});
