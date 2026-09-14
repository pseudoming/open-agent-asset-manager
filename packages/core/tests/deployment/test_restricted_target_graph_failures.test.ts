/** Original graph/CAS writes with explicit dependency failures and third-party directory changes. */
import * as fs from "node:fs";
import * as path from "node:path";
import * as physical from "@oaam/shared/filesystem";
import { describe, expect, it, vi } from "vitest";
import { readJournal, type ActiveJournalV3 } from "../../src/deployment/deployment-journal";
import * as targetIo from "../../src/deployment/deployment-target-io";
import { createRestrictedTargetGraphOperation } from "../../src/deployment/restricted-target-graph-operation";
import { fixture, finish, persist, type Fixture } from "./fixtures/restricted-target-graph-fixture";

function recover(h: Fixture, journal: ActiveJournalV3, side: "old" | "new") {
    const operation = createRestrictedTargetGraphOperation(h.binding);
    let step = operation.recover(journal, side);
    for (let count = 0; step.kind === "directory_receipt_required" && count < 12; count++) {
        journal = persist(h, journal, step);
        step = operation.continue(journal);
    }
    expect(step.kind).toBe("recovered");
    return { step, journal };
}

describe("restricted graph preparation and lifetime failures", () => {
    it("rejects a restored identity attached to a directory that did not previously exist", () => {
        const h = fixture();
        const journal = structuredClone(h.journal);
        journal.directoryEntries[0]!.restoredIdentity = journal.targetExecution.rootIdentity;
        expect(() => createRestrictedTargetGraphOperation(h.binding).recover(journal, "old")).toThrow(
            "journal execution binding mismatch",
        );
        expect(fs.readdirSync(h.target)).toEqual([]);
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(h.journal);
    });

    it.each([
        "binding",
        "mapping",
        "extra",
        "physical_identity",
    ])("rejects invalid root receipt %s before graph preparation", (kind) => {
        const h = fixture();
        const binding = { ...h.binding };
        if (kind === "binding") Object.assign(binding, { bindingId: "invalid" });
        else if (kind === "mapping") binding.executionRootPath += "-other";
        else if (kind === "extra") Object.assign(binding, { extra: true });
        else {
            const original = physical.confirmDurableDirectoryNoFollow;
            vi.spyOn(physical, "confirmDurableDirectoryNoFollow").mockImplementation((...args) => ({
                ...original(...args),
                entryKind: "file",
            }));
        }
        expect(() => createRestrictedTargetGraphOperation(binding)).toThrow(/invalid restricted graph/);
        expect(fs.readdirSync(h.target)).toEqual([]);
    });

    it.each(["unreadable_file", "changed_review", "unsupported_mode"])("keeps preparation %s outside graph writes", (kind) => {
        const h = fixture();
        if (kind === "unreadable_file") fs.mkdirSync(path.join(h.target, "leaf/SKILL.md"), { recursive: true });
        else if (kind === "changed_review") {
            fs.mkdirSync(path.join(h.target, "leaf"));
            fs.writeFileSync(path.join(h.target, "leaf/SKILL.md"), "external value");
        } else
            vi.spyOn(targetIo, "ioAssertExecutableStateSupported").mockImplementation(() => {
                throw new Error("unsupported mode control");
            });
        expect(h.operation.prepare(h.input)).toEqual({
            outcome: kind === "unreadable_file" ? "unavailable" : kind === "changed_review" ? "conflict" : "unsupported",
        });
        expect(fs.existsSync(path.join(h.target, "leaf/resources/run.sh"))).toBe(false);
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(h.journal);
    });

    it("refuses a ninth preparation and refuses replacement of an operation awaiting its durable directory receipt", () => {
        const h = fixture();
        for (let count = 1; count < 8; count++) expect(h.operation.prepare(h.input).outcome).toBe("ready");
        expect(() => h.operation.prepare(h.input)).toThrow(/unavailable/);
        const step = h.operation.execute(h.prepared.preparationId, h.journal);
        expect(step.kind).toBe("directory_receipt_required");
        expect(() => h.operation.prepare(h.input)).toThrow(/unavailable/);
        expect(() => h.operation.recover(h.journal, "old")).toThrow(/pending operation/);
        expect(() => createRestrictedTargetGraphOperation(h.binding).recover(h.journal, "other" as never)).toThrow(/side/);
        expect(fs.readdirSync(path.join(h.target, "leaf"))).toEqual([]);
    });

    it("rejects an ordinary filesystem inspection error during recovery without changing retained files", () => {
        const h = fixture(true);
        const completed = finish(h);
        fs.renameSync(path.join(h.target, "leaf/empty"), path.join(h.root, "retained-empty"));
        fs.writeFileSync(path.join(h.target, "leaf/empty"), "third-party file at directory position");
        expect(recover(h, completed.journal, "old").step).toEqual({ kind: "recovered", outcome: "third_value" });
        expect(fs.readFileSync(path.join(h.target, "leaf/SKILL.md"), "utf8")).toBe("# Complete skill\n");
        expect(fs.readFileSync(path.join(h.target, "leaf/empty"), "utf8")).toBe("third-party file at directory position");
    });

    it("rejects a physically replaced root before another preparation", () => {
        const h = fixture();
        fs.renameSync(h.target, path.join(h.root, "retained-target"));
        fs.mkdirSync(h.target);
        expect(() => h.operation.prepare(h.input)).toThrow("root identity changed");
        expect(fs.readdirSync(h.target)).toEqual([]);
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(h.journal);
    });

    it("refuses old-side recovery when a receipted existing directory has disappeared", () => {
        const h = fixture(true);
        const completed = finish(h);
        fs.renameSync(path.join(h.target, "leaf/empty"), path.join(h.root, "retained-empty"));
        expect(recover(h, completed.journal, "old").step).toEqual({ kind: "recovered", outcome: "third_value" });
        expect(fs.existsSync(path.join(h.target, "leaf/empty"))).toBe(false);
        expect(fs.readFileSync(path.join(h.target, "leaf/SKILL.md"), "utf8")).toBe("# Complete skill\n");
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(completed.journal);
    });
});

describe("restricted graph directory and post-write verification failures", () => {
    it.each(["execute", "new"])("preserves an actual directory creation whose IO owner denies creating it during %s", (mode) => {
        const h = fixture();
        const original = targetIo.ensureTargetDirectory;
        vi.spyOn(targetIo, "ensureTargetDirectory").mockImplementation((...args) => {
            const result = original(...args);
            expect(result.created).toBe(true);
            return { ...result, created: false };
        });
        const step =
            mode === "execute" ? h.operation.execute(h.prepared.preparationId, h.journal) : h.operation.recover(h.journal, "new");
        expect(step).toEqual(
            mode === "execute"
                ? { kind: "executed", result: { outcome: "uncertain" } }
                : { kind: "recovered", outcome: "third_value" },
        );
        expect(fs.readdirSync(path.join(h.target, "leaf"))).toEqual([]);
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(h.journal);
    });

    it("preserves a recreated old directory whose IO owner denies creating it", () => {
        const h = fixture(true, true);
        const completed = finish(h);
        const original = targetIo.restoreTargetDirectory;
        vi.spyOn(targetIo, "restoreTargetDirectory").mockImplementation((...args) => {
            const restored = original(...args);
            expect(restored.created).toBe(true);
            return { ...restored, created: false };
        });
        expect(recover(h, completed.journal, "old").step).toEqual({ kind: "recovered", outcome: "third_value" });
        expect(fs.existsSync(path.join(h.target, "leaf/obsolete"))).toBe(true);
        expect(fs.existsSync(path.join(h.target, "leaf/obsolete/old.bin"))).toBe(false);
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(completed.journal);
    });

    it("reports uncertain when third-party content prevents cleanup after a real partial-write rollback", () => {
        const h = fixture();
        const write = targetIo.ioWrite;
        const second = path.join(h.target, "leaf/resources/run.sh");
        vi.spyOn(targetIo, "ioWrite").mockImplementation((ctx, filePath, bytes) => {
            write(ctx, filePath, bytes);
            if (filePath.endsWith("/SKILL.md")) fs.writeFileSync(second, "third value");
        });
        const completed = finish(h);
        expect(completed.step).toEqual({ kind: "executed", result: { outcome: "uncertain" } });
        expect(fs.existsSync(path.join(h.target, "leaf/SKILL.md"))).toBe(false);
        expect(fs.readFileSync(second, "utf8")).toBe("third value");
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(completed.journal);
    });

    it("preserves unexpected old-directory content when final directory removal fails after file changes", () => {
        const h = fixture(true, true);
        const remove = targetIo.ioDelete;
        vi.spyOn(targetIo, "ioDelete").mockImplementation((ctx, filePath) => {
            remove(ctx, filePath);
            if (filePath.endsWith("/obsolete/old.bin"))
                fs.writeFileSync(path.join(h.target, "leaf/obsolete/external.bin"), "third value");
        });
        const completed = finish(h);
        expect(completed.step).toEqual({ kind: "executed", result: { outcome: "uncertain" } });
        expect(fs.existsSync(path.join(h.target, "leaf/obsolete/old.bin"))).toBe(false);
        expect(fs.readFileSync(path.join(h.target, "leaf/obsolete/external.bin"), "utf8")).toBe("third value");
        expect(fs.readFileSync(path.join(h.target, "leaf/SKILL.md"), "utf8")).toBe("# Complete skill\n");
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(completed.journal);
    });

    it.each(["file", "graph"])("refuses %s drift observed only after all actual CAS writes finish", (kind) => {
        const h = fixture();
        const write = targetIo.ioWrite;
        const changed = path.join(h.target, kind === "file" ? "leaf/SKILL.md" : "leaf/unreviewed.md");
        vi.spyOn(targetIo, "ioWrite").mockImplementation((ctx, filePath, bytes) => {
            write(ctx, filePath, bytes);
            if (filePath.endsWith("/resources/run.sh")) fs.writeFileSync(changed, "third value");
        });
        const completed = finish(h);
        expect(completed.step).toEqual({ kind: "executed", result: { outcome: "uncertain" } });
        expect(fs.readFileSync(changed, "utf8")).toBe("third value");
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(completed.journal);
        vi.restoreAllMocks();
        expect(recover(h, completed.journal, "new").step).toEqual({
            kind: "recovered",
            outcome: kind === "file" ? "third_value" : "io_failed",
        });
        expect(fs.readFileSync(changed, "utf8")).toBe("third value");
    });
});
