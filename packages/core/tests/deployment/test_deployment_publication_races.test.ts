/** Real late edits, displaced objects and lost completion at V4 publication boundaries. */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readJournal } from "../../src/deployment/deployment-journal";
import { executePublications, recoverPublications } from "../../src/deployment/deployment-publication";
import { drivePublicationJournal, recordPublicationJournal } from "../../src/deployment/deployment-publication-journal";
import * as publicationIo from "../../src/deployment/deployment-publication-io";
import { fileFixture, persistStep, publicationFixture } from "./fixtures/deployment-publication-fixtures";

describe("V4 forward and recovery physical race windows", () => {
    it("rolls back a protected file whose forward restoration move succeeded but lost completion", () => {
        const h = fileFixture("original", false, false);
        const move = publicationIo.movePublicationEntry;
        vi.spyOn(publicationIo, "movePublicationEntry").mockImplementation((source, destination, kind, identity) => {
            const result = move(source, destination, kind, identity);
            if (destination === h.targetFile) throw new Error("lost protected publication completion");
            return result;
        });
        const interrupted = h.drive(executePublications(h.ctx, h.journal), h.journal, "execute");
        expect(interrupted.outcome).toBe("io_failed");
        expect(interrupted.journal.publications[0]!.recovery?.side).toBe("new");
        expect(fs.readFileSync(h.targetFile, "utf8")).toBe("desired");
        vi.restoreAllMocks();
        const reopened = readJournal(h.transactions, h.journal.transactionId);
        if (reopened?.schemaVersion !== 4) throw new Error("expected persisted V4 journal");
        const recovered = h.drive(recoverPublications(h.ctx, reopened, "old"), reopened, "old");
        expect(recovered.outcome).toBe("done");
        expect(fs.readFileSync(h.targetFile, "utf8")).toBe("original");
        expect(fs.existsSync(reopened.staging.rootPath)).toBe(false);
    });

    it.each(["file", "directory"] as const)("protects a %s edited after planning but before forward publication", (kind) => {
        const h = kind === "file" ? fileFixture("original", false, false) : publicationFixture(true, "leaf", false);
        const locations = publicationIo.publicationLocations(h.ctx, h.journal, 0);
        const file = kind === "file" ? locations.target : path.join(locations.target, "SKILL.md");
        fs.writeFileSync(file, "late protected value");
        const before = publicationIo.publicationIdentity(locations.target, kind);
        const moved = vi.spyOn(publicationIo, "movePublicationEntry");
        const executed = h.drive(executePublications(h.ctx, h.journal), h.journal, "execute");
        expect(executed.outcome).toBe("third_value");
        expect(moved).not.toHaveBeenCalled();
        expect(fs.readFileSync(file, "utf8")).toBe("late protected value");
        expect(publicationIo.publicationIdentity(locations.target, kind)).toEqual(before);
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(executed.journal);
    });

    it.each(["file", "directory"] as const)("returns a protected %s edited in the final forward move window", (kind) => {
        const h = kind === "file" ? fileFixture("original", false, false) : publicationFixture(true, "leaf", false);
        const locations = publicationIo.publicationLocations(h.ctx, h.journal, 0);
        const file = kind === "file" ? locations.target : path.join(locations.target, "SKILL.md");
        const before = publicationIo.publicationIdentity(locations.target, kind);
        const move = publicationIo.movePublicationEntry;
        vi.spyOn(publicationIo, "movePublicationEntry").mockImplementation((source, destination, entryKind, identity) => {
            if (source === locations.target) fs.writeFileSync(file, "last-window protected edit");
            return move(source, destination, entryKind, identity);
        });
        const executed = h.drive(executePublications(h.ctx, h.journal), h.journal, "execute");
        expect(executed.outcome).toBe("third_value");
        expect(fs.readFileSync(file, "utf8")).toBe("last-window protected edit");
        expect(publicationIo.publicationIdentity(locations.target, kind)).toEqual(before);
        expect(fs.existsSync(kind === "file" ? locations.quarantine : locations.original)).toBe(false);
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(executed.journal);
    });

    it.each([
        "before_publication",
        "during_move",
    ] as const)("retains the actual original tree after an allowed edit %s", (when) => {
        const h = publicationFixture();
        const locations = publicationIo.publicationLocations(h.ctx, h.journal, 0);
        const originalIdentity = publicationIo.publicationIdentity(locations.target, "directory");
        function edit() {
            fs.writeFileSync(path.join(locations.target, "SKILL.md"), "late confirmed edit");
            fs.mkdirSync(path.join(locations.target, "late-empty"));
        }
        if (when === "before_publication") edit();
        else {
            const move = publicationIo.movePublicationEntry;
            vi.spyOn(publicationIo, "movePublicationEntry").mockImplementation((source, destination, kind, identity) => {
                if (source === locations.target) edit();
                return move(source, destination, kind, identity);
            });
        }
        const executed = h.drive(executePublications(h.ctx, h.journal), h.journal, "execute");
        expect(executed.outcome).toBe("done");
        const unit = executed.journal.publications[0]!;
        if (unit.kind !== "directory") throw new Error("expected directory publication");
        expect(unit.oldTree).toEqual(publicationIo.capturePublicationTree(locations.original));
        expect(unit.oldTree?.identity).toEqual(originalIdentity);
        expect(fs.readFileSync(path.join(locations.target, "SKILL.md"), "utf8")).toBe("# Complete skill\n");
        vi.restoreAllMocks();
        const recovered = h.drive(recoverPublications(h.ctx, executed.journal, "old"), executed.journal, "old");
        expect(recovered.outcome).toBe("done");
        expect(publicationIo.capturePublicationTree(locations.target)).toEqual(unit.oldTree);
        expect(fs.readFileSync(path.join(locations.target, "SKILL.md"), "utf8")).toBe("late confirmed edit");
        expect(fs.existsSync(path.join(locations.target, "late-empty"))).toBe(true);
    });

    it.each([false, true])("preserves a changed original after its post-move receipt is lost; target occupied=%s", (occupied) => {
        const h = publicationFixture();
        const locations = publicationIo.publicationLocations(h.ctx, h.journal, 0);
        const before = publicationIo.publicationIdentity(locations.target, "directory");
        const move = publicationIo.movePublicationEntry;
        vi.spyOn(publicationIo, "movePublicationEntry").mockImplementation((source, destination, kind, identity) => {
            if (source === locations.target) fs.writeFileSync(path.join(source, "SKILL.md"), "changed original");
            return move(source, destination, kind, identity);
        });
        const interrupted = drivePublicationJournal(executePublications(h.ctx, h.journal), h.journal, (previous, next) => {
            if (fs.existsSync(locations.original)) throw new Error("lost actual-original receipt");
            return recordPublicationJournal(h.transactions, previous, next, "execute");
        });
        expect(interrupted.outcome).toBe("io_failed");
        expect(fs.existsSync(locations.target)).toBe(false);
        expect(fs.readFileSync(path.join(locations.original, "SKILL.md"), "utf8")).toBe("changed original");
        vi.restoreAllMocks();
        if (occupied) {
            fs.mkdirSync(locations.target);
            fs.writeFileSync(path.join(locations.target, "SKILL.md"), "new occupant");
        }
        const reopened = readJournal(h.transactions, h.journal.transactionId);
        if (reopened?.schemaVersion !== 4) throw new Error("expected persisted V4 journal");
        const recovered = h.drive(recoverPublications(h.ctx, reopened, "old"), reopened, "old");
        expect(recovered.outcome).toBe("third_value");
        const retained = occupied ? locations.original : locations.target;
        expect(publicationIo.publicationIdentity(retained, "directory")).toEqual(before);
        expect(fs.readFileSync(path.join(retained, "SKILL.md"), "utf8")).toBe("changed original");
        if (occupied) expect(fs.readFileSync(path.join(locations.target, "SKILL.md"), "utf8")).toBe("new occupant");
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(recovered.journal);
    });

    it.each(["file", "directory"] as const)("reopens after the final %s restoration move loses completion", (kind) => {
        const h = kind === "file" ? fileFixture() : publicationFixture();
        const locations = publicationIo.publicationLocations(h.ctx, h.journal, 0);
        const file = kind === "file" ? locations.target : path.join(locations.target, "SKILL.md");
        const before = fs.readFileSync(file);
        const executed = h.drive(executePublications(h.ctx, h.journal), h.journal, "execute");
        expect(executed.outcome).toBe("done");
        const move = publicationIo.movePublicationEntry;
        vi.spyOn(publicationIo, "movePublicationEntry").mockImplementation((source, destination, entryKind, identity) => {
            const result = move(source, destination, entryKind, identity);
            if (destination === locations.target) throw new Error("lost final restoration completion");
            return result;
        });
        const interrupted = h.drive(recoverPublications(h.ctx, executed.journal, "old"), executed.journal, "old");
        expect(interrupted.outcome).toBe("io_failed");
        expect(fs.readFileSync(file)).toEqual(before);
        const restored = publicationIo.publicationIdentity(locations.target, kind);
        vi.restoreAllMocks();
        const reopened = readJournal(h.transactions, h.journal.transactionId);
        if (reopened?.schemaVersion !== 4) throw new Error("expected persisted V4 journal");
        const recovered = h.drive(recoverPublications(h.ctx, reopened, "old"), reopened, "old");
        expect(recovered.outcome).toBe("done");
        expect(fs.readFileSync(file)).toEqual(before);
        expect(publicationIo.publicationIdentity(locations.target, kind)).toEqual(restored);
        expect(fs.existsSync(reopened.staging.rootPath)).toBe(false);
    });

    it.each([
        "staging",
        "prepared",
    ] as const)("preserves a physically substituted %s directory on preparation recovery", (slot) => {
        const h = publicationFixture();
        const operation = executePublications(h.ctx, h.journal);
        let journal = persistStep(h, operation, h.journal);
        if (slot === "prepared") journal = persistStep(h, operation, journal);
        const locations = publicationIo.publicationLocations(h.ctx, journal, 0);
        const original = publicationIo.capturePublicationTree(locations.target);
        const selected = slot === "staging" ? journal.staging.rootPath : locations.prepared;
        const retained = path.join(h.root, `retained-${slot}`);
        fs.renameSync(selected, retained);
        fs.mkdirSync(selected);
        fs.writeFileSync(path.join(selected, "external.txt"), "keep substituted directory");
        const replacement = publicationIo.capturePublicationTree(selected);
        const recovered = h.drive(recoverPublications(h.ctx, journal, "old"), journal, "old");
        expect(recovered.outcome).toBe("third_value");
        expect(publicationIo.capturePublicationTree(selected)).toEqual(replacement);
        expect(publicationIo.capturePublicationTree(locations.target)).toEqual(original);
        expect(fs.existsSync(retained)).toBe(true);
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(journal);
    });
});
