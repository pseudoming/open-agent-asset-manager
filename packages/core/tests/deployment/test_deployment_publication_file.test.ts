/** Single-file publication stays one replacement; recovery quarantines exact candidate objects. */
import * as fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { readJournal } from "../../src/deployment/deployment-journal";
import { executePublications, recoverPublications } from "../../src/deployment/deployment-publication";
import { drivePublicationJournal } from "../../src/deployment/deployment-publication-journal";
import * as publicationIo from "../../src/deployment/deployment-publication-io";

import { fileFixture } from "./fixtures/deployment-publication-fixtures";

describe("V4 single-file publication and recovery", () => {
    it("overwrites a later confirmed-target edit with one replacement carrying executable mode", () => {
        const h = fileFixture("original", true);
        fs.writeFileSync(h.targetFile, "later confirmed-scope edit");
        const moves = vi.spyOn(publicationIo, "movePublicationEntry");
        const executed = h.drive(executePublications(h.ctx, h.journal), h.journal, "execute");
        expect(executed.outcome).toBe("done");
        expect(moves).not.toHaveBeenCalled();
        expect(fs.readFileSync(h.targetFile, "utf8")).toBe("desired");
        expect(fs.statSync(h.targetFile).mode & 0o100).toBe(0o100);
        expect(h.drive(recoverPublications(h.ctx, executed.journal, "old"), executed.journal, "old").outcome).toBe("done");
        expect(fs.readFileSync(h.targetFile, "utf8")).toBe("original");
        expect(fs.statSync(h.targetFile).mode & 0o100).toBe(0);
    });

    it.each([false, true])("resumes restoration creation interrupted before its identity receipt, complete=%s", (complete) => {
        const h = fileFixture();
        const executed = h.drive(executePublications(h.ctx, h.journal), h.journal, "execute");
        expect(executed.outcome).toBe("done");
        let interrupted: ReturnType<typeof drivePublicationJournal>;
        if (complete) {
            interrupted = drivePublicationJournal(
                recoverPublications(h.ctx, executed.journal, "old"),
                executed.journal,
                (previous, next) => {
                    if (next.publications[0]!.recovery?.restoreIdentity !== null && next.publications[0]!.recovery !== null)
                        throw new Error("restoration identity receipt was lost");
                    return h.persist("old")(previous, next);
                },
            );
        } else {
            vi.spyOn(publicationIo, "createRestorationFile").mockImplementation((filePath) => {
                fs.writeFileSync(filePath, "partial");
                throw new Error("restoration write interrupted");
            });
            interrupted = h.drive(recoverPublications(h.ctx, executed.journal, "old"), executed.journal, "old");
            vi.restoreAllMocks();
        }
        expect(interrupted.outcome).toBe("io_failed");
        expect(interrupted.journal.publications[0]!.recovery?.restoreIdentity).toBeNull();
        expect(fs.readFileSync(h.targetFile, "utf8")).toBe("desired");
        const locations = publicationIo.publicationLocations(h.ctx, interrupted.journal, 0);
        expect(fs.readFileSync(locations.restoration, "utf8")).toBe(complete ? "original" : "partial");
        expect(h.drive(recoverPublications(h.ctx, interrupted.journal, "old"), interrupted.journal, "old").outcome).toBe("done");
        expect(fs.readFileSync(h.targetFile, "utf8")).toBe("original");
    });

    it("restores after quarantine movement succeeds but its completion is lost", () => {
        const h = fileFixture();
        const executed = h.drive(executePublications(h.ctx, h.journal), h.journal, "execute");
        const move = publicationIo.movePublicationEntry;
        vi.spyOn(publicationIo, "movePublicationEntry").mockImplementation((source, destination, kind, identity) => {
            const result = move(source, destination, kind, identity);
            if (source === h.targetFile) throw new Error("lost quarantine completion");
            return result;
        });
        const interrupted = h.drive(recoverPublications(h.ctx, executed.journal, "old"), executed.journal, "old");
        expect(interrupted.outcome).toBe("io_failed");
        expect(fs.existsSync(h.targetFile)).toBe(false);
        vi.restoreAllMocks();
        expect(h.drive(recoverPublications(h.ctx, interrupted.journal, "old"), interrupted.journal, "old").outcome).toBe("done");
        expect(fs.readFileSync(h.targetFile, "utf8")).toBe("original");
    });

    it.each([false, true])("returns a late third-party file without replacement; newly occupied=%s", (occupied) => {
        const h = fileFixture();
        const executed = h.drive(executePublications(h.ctx, h.journal), h.journal, "execute");
        const locations = publicationIo.publicationLocations(h.ctx, executed.journal, 0);
        const before = publicationIo.readPublicationFile(h.targetFile)!.identity;
        const move = publicationIo.movePublicationEntry;
        vi.spyOn(publicationIo, "movePublicationEntry").mockImplementation((source, destination, kind, identity) => {
            if (source === h.targetFile) fs.writeFileSync(source, "late third value");
            const result = move(source, destination, kind, identity);
            if (source === h.targetFile && occupied) fs.writeFileSync(h.targetFile, "new occupant");
            return result;
        });
        const recovered = h.drive(recoverPublications(h.ctx, executed.journal, "old"), executed.journal, "old");
        expect(recovered.outcome).toBe("third_value");
        const retained = occupied ? locations.quarantine : h.targetFile;
        expect(fs.readFileSync(retained, "utf8")).toBe("late third value");
        expect(publicationIo.readPublicationFile(retained)!.identity).toEqual(before);
        if (occupied) expect(fs.readFileSync(h.targetFile, "utf8")).toBe("new occupant");
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(recovered.journal);
    });

    it.each([null, ""])("restores absence or an empty file distinctly: %s", (original) => {
        const h = fileFixture(original);
        const executed = h.drive(executePublications(h.ctx, h.journal), h.journal, "execute");
        expect(executed.outcome).toBe("done");
        expect(h.drive(recoverPublications(h.ctx, executed.journal, "old"), executed.journal, "old").outcome).toBe("done");
        expect(fs.existsSync(h.targetFile)).toBe(original !== null);
        if (original !== null) expect(fs.readFileSync(h.targetFile)).toEqual(Buffer.alloc(0));
    });
});
