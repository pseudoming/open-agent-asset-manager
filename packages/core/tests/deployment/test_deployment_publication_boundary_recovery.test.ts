/** Interrupted preparation and late physical changes retain the exact public/private objects. */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { executePublications, recoverPublications, finalizePublications } from "../../src/deployment/deployment-publication";
import { readJournal } from "../../src/deployment/deployment-journal";
import * as io from "../../src/deployment/deployment-publication-io";
import { fileFixture, persistStep, publicationFixture } from "./fixtures/deployment-publication-fixtures";

function interruptedFileRecovery() {
    const h = fileFixture();
    const executed = h.drive(executePublications(h.ctx, h.journal), h.journal, "execute");
    expect(executed.outcome).toBe("done");
    const operation = recoverPublications(h.ctx, executed.journal, "old");
    const step = operation.next();
    if (step.done) throw new Error("expected recovery intent");
    const journal = h.persist("old")(executed.journal, step.value);
    return { ...h, journal, operation, locations: io.publicationLocations(h.ctx, journal, 0) };
}

describe("publication preparation and private recovery objects", () => {
    it("retains both hard-linked candidates when no quarantine slot is vacant", () => {
        const h = interruptedFileRecovery();
        fs.linkSync(h.targetFile, h.locations.quarantine);
        expect(h.drive(recoverPublications(h.ctx, h.journal, "old"), h.journal, "old").outcome).toBe("third_value");
        expect(fs.readFileSync(h.targetFile, "utf8")).toBe("desired");
        expect(fs.readFileSync(h.locations.quarantine, "utf8")).toBe("desired");
        expect(io.publicationIdentity(h.targetFile, "file")).toEqual(io.publicationIdentity(h.locations.quarantine, "file"));
    });

    it.each([
        "quarantine_displaced",
        "restoration_edited",
        "restored_target_edited",
        "quarantine_cleanup_edited",
    ])("preserves recovery material after %s in the final file move window", (fault) => {
        const h = interruptedFileRecovery();
        const retained = path.join(h.root, "retained-quarantine");
        const move = io.movePublicationEntry;
        vi.spyOn(io, "movePublicationEntry").mockImplementation((source, destination, kind, identity) => {
            const result = move(source, destination, kind, identity);
            if (destination === h.locations.quarantine) {
                if (fault === "quarantine_displaced") fs.renameSync(destination, retained);
                if (fault === "restoration_edited") fs.writeFileSync(h.locations.restoration, "external restoration");
            }
            if (destination === h.targetFile) {
                if (fault === "restored_target_edited") fs.writeFileSync(destination, "external restored target");
                if (fault === "quarantine_cleanup_edited") fs.writeFileSync(h.locations.quarantine, "external cleanup value");
            }
            return result;
        });
        const result = h.drive(recoverPublications(h.ctx, h.journal, "old"), h.journal, "old");
        expect(result.outcome).toBe(fault === "quarantine_displaced" ? "io_failed" : "third_value");
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(result.journal);
        if (fault === "quarantine_displaced") expect(fs.readFileSync(retained, "utf8")).toBe("desired");
        if (fault === "restoration_edited") expect(fs.readFileSync(h.locations.restoration, "utf8")).toBe("external restoration");
        if (fault === "restored_target_edited") expect(fs.readFileSync(h.targetFile, "utf8")).toBe("external restored target");
        if (fault === "quarantine_cleanup_edited")
            expect(fs.readFileSync(h.locations.quarantine, "utf8")).toBe("external cleanup value");
    });

    it("refuses an unreceipted matching file created in quarantine after location validation", () => {
        const h = fileFixture(null);
        const operation = executePublications(h.ctx, h.journal);
        let journal = h.journal;
        for (let count = 0; count < 2; count += 1) {
            const step = operation.next();
            if (step.done) throw new Error("expected preparation permission");
            journal = h.persist("execute")(journal, step.value);
        }
        const locations = io.publicationLocations(h.ctx, journal, 0);
        const read = io.readPublicationFile;
        let observations = 0;
        vi.spyOn(io, "readPublicationFile").mockImplementation((file) => {
            const result = read(file);
            if (file === h.targetFile && ++observations === 2) fs.writeFileSync(locations.quarantine, "desired");
            return result;
        });
        const result = h.drive(recoverPublications(h.ctx, journal, "new"), journal, "new");
        expect(result.outcome).toBe("io_failed");
        expect(fs.existsSync(h.targetFile)).toBe(false);
        expect(fs.readFileSync(locations.quarantine, "utf8")).toBe("desired");
        expect(result.journal.publications[0]!.recovery?.candidateIdentity).toBeNull();
    });

    it("rejects replay of an existing staging receipt and a prepared leaf receipt", () => {
        const h = publicationFixture();
        const operation = executePublications(h.ctx, h.journal);
        let journal = persistStep(h, operation, h.journal);
        expect(executePublications(h.ctx, journal).next()).toEqual({ done: true, value: "io_failed" });
        journal = persistStep(h, operation, journal);
        const original = io.capturePublicationTree(path.join(h.target, h.leaf));
        const retained = path.join(h.root, "retained-stage");
        fs.renameSync(journal.staging.rootPath, retained);
        journal = { ...journal, staging: { ...journal.staging, identity: null } };
        const replay = executePublications(h.ctx, journal);
        expect(replay.next().done).toBe(false);
        expect(replay.next()).toEqual({ done: true, value: "io_failed" });
        expect(io.capturePublicationTree(path.join(h.target, h.leaf))).toEqual(original);
        expect(fs.existsSync(retained)).toBe(true);
    });

    it("ends lost private preparation on the old side and rejects a new-side claim before publication", () => {
        const h = publicationFixture();
        const journal = persistStep(h, executePublications(h.ctx, h.journal), h.journal);
        expect(h.drive(recoverPublications(h.ctx, journal, "new"), journal, "new").outcome).toBe("io_failed");
        fs.rmdirSync(journal.staging.rootPath);
        expect(h.drive(recoverPublications(h.ctx, journal, "old"), journal, "old").outcome).toBe("done");
        expect(fs.readFileSync(path.join(h.target, h.leaf, "SKILL.md"), "utf8")).toBe("# original\n");
    });

    it("cleans file-only preparation, retries completed cleanup, and retains a committed target needing a recovery receipt", () => {
        const h = fileFixture();
        const step = executePublications(h.ctx, h.journal).next();
        if (step.done) throw new Error("expected staging receipt");
        const staged = h.persist("execute")(h.journal, step.value);
        expect(h.drive(recoverPublications(h.ctx, staged, "old"), staged, "old").outcome).toBe("done");
        fs.writeFileSync(path.join(h.transactions, h.journal.transactionId, "journal.json"), JSON.stringify(h.journal));
        const executed = h.drive(executePublications(h.ctx, h.journal), h.journal, "execute");
        fs.writeFileSync(h.targetFile, "original");
        expect(finalizePublications(h.ctx, executed.journal)).toBe("io_failed");
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(executed.journal);
        const recovered = h.drive(recoverPublications(h.ctx, executed.journal, "new"), executed.journal, "new");
        expect(recovered.outcome).toBe("done");
        expect(h.drive(recoverPublications(h.ctx, recovered.journal, "new"), recovered.journal, "new").outcome).toBe("done");
        expect(fs.readFileSync(h.targetFile, "utf8")).toBe("desired");
    });

    it.each([
        "target_removed",
        "target_edited",
        "quarantine_occupied",
    ])("preserves an unreceipted restoration after %s", (change) => {
        const h = interruptedFileRecovery();
        fs.writeFileSync(h.locations.restoration, "partial restoration");
        if (change === "target_removed") fs.renameSync(h.targetFile, path.join(h.root, "retained-target"));
        if (change === "target_edited") fs.writeFileSync(h.targetFile, "external edit");
        if (change === "quarantine_occupied") fs.writeFileSync(h.locations.quarantine, "external quarantine");
        expect(h.drive(recoverPublications(h.ctx, h.journal, "old"), h.journal, "old").outcome).toBe("third_value");
        expect(fs.readFileSync(h.locations.restoration, "utf8")).toBe("partial restoration");
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(h.journal);
        if (change === "target_removed") expect(fs.existsSync(h.targetFile)).toBe(false);
        else expect(fs.readFileSync(h.targetFile, "utf8")).toBe(change === "target_edited" ? "external edit" : "desired");
    });

    it.each(["unknown_identity", "edited_candidate"])("protects a quarantined file with %s", (change) => {
        const h = interruptedFileRecovery();
        if (change === "unknown_identity") fs.writeFileSync(h.locations.quarantine, "desired");
        else {
            fs.renameSync(h.targetFile, h.locations.quarantine);
            fs.writeFileSync(h.locations.quarantine, "external quarantine edit");
        }
        expect(h.drive(recoverPublications(h.ctx, h.journal, "old"), h.journal, "old").outcome).toBe("third_value");
        if (change === "unknown_identity") expect(fs.readFileSync(h.locations.quarantine, "utf8")).toBe("desired");
        else {
            expect(fs.readFileSync(h.targetFile, "utf8")).toBe("external quarantine edit");
            expect(fs.existsSync(h.locations.quarantine)).toBe(false);
        }
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(h.journal);
    });

    it("preserves a file replaced with identical content after the recovery intent observation", () => {
        const h = fileFixture();
        const executed = h.drive(executePublications(h.ctx, h.journal), h.journal, "execute");
        const read = io.readPublicationFile;
        let changed = false;
        vi.spyOn(io, "readPublicationFile").mockImplementation((file) => {
            const value = read(file);
            if (file === h.targetFile && !changed) {
                changed = true;
                fs.renameSync(file, path.join(h.root, "retained-candidate"));
                fs.writeFileSync(file, "desired");
            }
            return value;
        });
        const recovered = h.drive(recoverPublications(h.ctx, executed.journal, "old"), executed.journal, "old");
        expect(recovered.outcome).toBe("third_value");
        expect(fs.readFileSync(h.targetFile, "utf8")).toBe("desired");
        expect(fs.readFileSync(path.join(h.root, "retained-candidate"), "utf8")).toBe("desired");
    });

    it("retains a lost receipted restoration instead of creating an unbound replacement", () => {
        const h = interruptedFileRecovery();
        const step = h.operation.next();
        if (step.done) throw new Error("expected restoration receipt");
        const journal = h.persist("old")(h.journal, step.value);
        fs.renameSync(h.locations.restoration, path.join(h.root, "retained-restoration"));
        expect(h.drive(recoverPublications(h.ctx, journal, "old"), journal, "old").outcome).toBe("third_value");
        expect(fs.readFileSync(h.targetFile, "utf8")).toBe("desired");
        expect(fs.readFileSync(path.join(h.root, "retained-restoration"), "utf8")).toBe("original");
    });
});
