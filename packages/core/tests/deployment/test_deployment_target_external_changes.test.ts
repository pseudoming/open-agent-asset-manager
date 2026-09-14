/** Real physical mutations must preserve files outside the journal's authorized states. */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as physicalFilesystem from "@oaam/shared/filesystem";
import * as targetIo from "../../src/deployment/deployment-target-io";
import { casWriteAll } from "../../src/deployment/deployment-target-cas";
import { recoverTargetFiles } from "../../src/deployment/deployment-file-recovery";
import type { JournalEntry } from "../../src/deployment/deployment-journal";
import { sha, b64, tmpRoot } from "./fixtures/deployment-target-io-test-fixtures";

let root: string;
const oldText = "# reviewed old\n";
const newText = "# intended new\n";
const externalText = "# independently written\n";

beforeEach(() => {
    root = tmpRoot();
});
afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
});

function entry(kind: "create" | "replace" | "remove"): JournalEntry {
    return {
        relativePath: "asset.md",
        oldHash: kind === "create" ? "" : sha(oldText),
        oldBytesBase64: kind === "create" ? "" : b64(oldText),
        oldExecutable: false,
        newHash: kind === "remove" ? "" : sha(newText),
        newBytesBase64: kind === "remove" ? "" : b64(newText),
        newExecutable: false,
        isRemoval: kind === "remove",
    };
}

it.each(["create", "replace", "remove"] as const)("rollback refuses an already visible external value after %s", (kind) => {
    const file = path.join(root, "asset.md");
    fs.writeFileSync(file, externalText);
    const result = targetIo.rollbackToOld([entry(kind)], targetIo.createTargetIo(root));
    expect(fs.readFileSync(file, "utf8")).toBe(externalText);
    expect(result).toEqual({ ok: false, failedRelativePaths: ["asset.md"] });
});

it.each([
    "CAS",
    "recover new",
    "recover old",
    "rollback",
] as const)("%s refuses a file created after the missing observation and before publication", (kind) => {
    const file = path.join(root, "asset.md");
    const context = targetIo.createTargetIo(root);
    let injected = false;
    for (const method of ["durableCreateFile", "durableReplaceFile"] as const) {
        const originalWrite = physicalFilesystem[method];
        vi.spyOn(physicalFilesystem, method).mockImplementationOnce((...args) => {
            expect(fs.existsSync(file)).toBe(false);
            fs.writeFileSync(file, externalText);
            injected = true;
            return originalWrite(...args);
        });
    }
    const journalEntry = entry(kind === "CAS" || kind === "recover new" ? "create" : "remove");
    const result =
        kind === "CAS"
            ? casWriteAll([journalEntry], context)
            : kind === "rollback"
              ? targetIo.rollbackToOld([journalEntry], context)
              : recoverTargetFiles(context, [journalEntry], kind === "recover new" ? "new" : "old");
    expect(injected).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe(externalText);
    if (kind === "CAS") expect(result).toMatchObject({ ok: false, stop: { kind: "write_failed" } });
    else if (kind === "rollback") expect(result).toEqual({ ok: false, failedRelativePaths: ["asset.md"] });
    else expect(result).toBe("io_failed");
});

it("the injected I/O port also refuses a file appearing before create-only publication", () => {
    const file = path.join(root, "asset.md");
    let observations = 0;
    const writeFile = vi.fn((target: string, bytes: Uint8Array | string) => fs.writeFileSync(target, bytes));
    const context = targetIo.createTargetIoForTest(root, {
        readFile: (target) => fs.readFileSync(target),
        writeFile,
        deleteFile: (target) => fs.unlinkSync(target),
        fileExists: (target) => {
            observations += 1;
            if (observations === 2) fs.writeFileSync(target, externalText);
            return fs.existsSync(target);
        },
    });

    expect(casWriteAll([entry("create")], context)).toMatchObject({
        ok: false,
        stop: { kind: "write_failed" },
    });
    expect(observations).toBe(2);
    expect(writeFile).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, "utf8")).toBe(externalText);
});
