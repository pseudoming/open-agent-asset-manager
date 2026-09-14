/** Real physical V4 publication with interruptions at durable journal boundaries. */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { inspectDirectoryNoFollow } from "@oaam/shared/filesystem";
import { isValidJournal, readJournal } from "../../src/deployment/deployment-journal";
import { executePublications, recoverPublications } from "../../src/deployment/deployment-publication";
import { isPublicationJournalTransition, recordPublicationJournal } from "../../src/deployment/deployment-publication-journal";
import * as publicationIo from "../../src/deployment/deployment-publication-io";

import { publicationFixture, persistStep } from "./fixtures/deployment-publication-fixtures";

describe("V4 whole-directory publication and protective recovery", () => {
    it.each([
        "root_directory",
        "wrong_root_name",
        "invalid_directory_entry",
        "publishing_without_staging_receipt",
        "publishing_without_prepared_receipt",
    ])("rejects corrupt V4 authority without throwing: %s", (corruption) => {
        const h = publicationFixture();
        const journal = structuredClone(h.journal);
        if (corruption === "root_directory") journal.staging.rootPath = "/";
        if (corruption === "wrong_root_name") journal.staging.rootPath = path.join(h.root, "unowned");
        if (corruption === "invalid_directory_entry") journal.directoryEntries[0] = null as never;
        if (corruption === "publishing_without_staging_receipt") journal.publicationPhase = "publishing";
        if (corruption === "publishing_without_prepared_receipt") {
            journal.publicationPhase = "publishing";
            journal.staging.identity = inspectDirectoryNoFollow(h.root);
        }
        expect(isValidJournal(journal)).toBe(false);
        fs.writeFileSync(path.join(h.transactions, journal.transactionId, "journal.json"), JSON.stringify(journal));
        expect(readJournal(h.transactions, journal.transactionId)).toBeNull();
    });

    it("publishes the complete graph and restores the original directory identity, binary bytes, mode and empty leaves", () => {
        const h = publicationFixture();
        const original = publicationIo.capturePublicationTree(path.join(h.target, h.leaf));
        const executed = h.drive(executePublications(h.ctx, h.journal), h.journal, "execute");
        expect(executed.outcome).toBe("done");
        const locations = publicationIo.publicationLocations(h.ctx, executed.journal, 0);
        expect(publicationIo.capturePublicationTree(locations.original)).toEqual(original);
        expect(fs.readFileSync(path.join(locations.target, "SKILL.md"), "utf8")).toBe("# Complete skill\n");
        expect(fs.statSync(path.join(locations.target, "resources/run.sh")).mode & 0o100).toBe(0o100);
        expect(fs.existsSync(path.join(locations.target, "empty"))).toBe(true);
        expect(fs.existsSync(path.join(locations.target, "obsolete"))).toBe(false);
        const recovered = h.drive(recoverPublications(h.ctx, executed.journal, "old"), executed.journal, "old");
        expect(recovered.outcome).toBe("done");
        expect(publicationIo.capturePublicationTree(locations.target)).toEqual(original);
        expect(fs.existsSync(executed.journal.staging.rootPath)).toBe(false);
    });

    it("first Apply publishes the missing structural ancestor once and rollback restores its original absence", () => {
        const h = publicationFixture(false, ".claude/skills/new-skill");
        expect(h.journal.publications.map((unit) => unit.relativePath)).toEqual([".claude"]);
        const executed = h.drive(executePublications(h.ctx, h.journal), h.journal, "execute");
        expect(executed.outcome).toBe("done");
        expect(fs.readFileSync(path.join(h.target, h.leaf, "SKILL.md"), "utf8")).toBe("# Complete skill\n");
        const recovered = h.drive(recoverPublications(h.ctx, executed.journal, "old"), executed.journal, "old");
        expect(recovered.outcome).toBe("done");
        expect(fs.existsSync(path.join(h.target, ".claude"))).toBe(false);
    });

    it("lost initial staging mkdir receipt leaves unconfirmed temporary material and releases the untouched target", () => {
        const h = publicationFixture();
        const before = publicationIo.capturePublicationTree(path.join(h.target, h.leaf));
        const operation = executePublications(h.ctx, h.journal);
        expect(operation.next().done).toBe(false);
        expect(fs.existsSync(h.journal.staging.rootPath)).toBe(true);
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(h.journal);
        const recovered = h.drive(recoverPublications(h.ctx, h.journal, "old"), h.journal, "old");
        expect(recovered.outcome).toBe("done");
        expect(publicationIo.capturePublicationTree(path.join(h.target, h.leaf))).toEqual(before);
        expect(fs.readdirSync(h.journal.staging.rootPath)).toEqual([]);
        expect(h.drive(recoverPublications(h.ctx, h.journal, "new"), h.journal, "new").outcome).toBe("io_failed");
    });

    it.each([
        false,
        true,
    ])("cleans a partial prepared tree after child mkdir with receipt=%s before any public write", (receipt) => {
        const h = publicationFixture();
        const before = publicationIo.capturePublicationTree(path.join(h.target, h.leaf));
        const operation = executePublications(h.ctx, h.journal);
        let journal = persistStep(h, operation, h.journal);
        const created = operation.next();
        expect(created.done).toBe(false);
        if (created.done) throw new Error("child receipt missing");
        if (receipt) journal = recordPublicationJournal(h.transactions, journal, created.value, "execute");
        const locations = publicationIo.publicationLocations(h.ctx, journal, 0);
        fs.mkdirSync(path.join(locations.prepared, "partial"));
        fs.writeFileSync(path.join(locations.prepared, "partial/resource.bin"), Buffer.from([0, 255, 128]));
        expect(h.drive(recoverPublications(h.ctx, journal, "old"), journal, "old").outcome).toBe("done");
        expect(publicationIo.capturePublicationTree(locations.target)).toEqual(before);
        expect(fs.existsSync(journal.staging.rootPath)).toBe(false);
    });

    it("cannot persist publishing permission without confirmed staging and prepared identities", () => {
        const h = publicationFixture();
        expect(isPublicationJournalTransition(h.journal, { ...h.journal, publicationPhase: "publishing" }, "execute")).toBe(
            false,
        );
        const operation = executePublications(h.ctx, h.journal);
        const journal = persistStep(h, operation, h.journal);
        expect(isPublicationJournalTransition(journal, { ...journal, publicationPhase: "publishing" }, "execute")).toBe(false);
    });

    it.each(["original", "target"])("recovers an actual move to %s even when its completion is lost", (after) => {
        const h = publicationFixture();
        const before = publicationIo.capturePublicationTree(path.join(h.target, h.leaf));
        const move = publicationIo.movePublicationEntry;
        vi.spyOn(publicationIo, "movePublicationEntry").mockImplementation((source, destination, kind, identity) => {
            const result = move(source, destination, kind, identity);
            if (
                (after === "original" && destination.endsWith("-original")) ||
                (after === "target" && source.endsWith("-prepared"))
            )
                throw new Error("lost move completion");
            return result;
        });
        const executed = h.drive(executePublications(h.ctx, h.journal), h.journal, "execute");
        expect(executed.outcome).toBe("io_failed");
        expect(executed.journal.publicationPhase).toBe("publishing");
        vi.restoreAllMocks();
        expect(h.drive(recoverPublications(h.ctx, executed.journal, "old"), executed.journal, "old").outcome).toBe("done");
        expect(publicationIo.capturePublicationTree(path.join(h.target, h.leaf))).toEqual(before);
    });

    it.each([false, true])("preserves a third-party edit after recovery's last observation; target reoccupied=%s", (occupied) => {
        const h = publicationFixture();
        const executed = h.drive(executePublications(h.ctx, h.journal), h.journal, "execute");
        expect(executed.outcome).toBe("done");
        const locations = publicationIo.publicationLocations(h.ctx, executed.journal, 0);
        const original = publicationIo.capturePublicationTree(locations.original);
        const newIdentity = inspectDirectoryNoFollow(locations.target);
        const move = publicationIo.movePublicationEntry;
        vi.spyOn(publicationIo, "movePublicationEntry").mockImplementation((source, destination, kind, identity) => {
            if (source === locations.target) fs.writeFileSync(path.join(source, "SKILL.md"), "# late external edit\n");
            const result = move(source, destination, kind, identity);
            if (source === locations.target && occupied) {
                fs.mkdirSync(locations.target);
                fs.writeFileSync(path.join(locations.target, "SKILL.md"), "# new occupant\n");
            }
            return result;
        });
        const recovered = h.drive(recoverPublications(h.ctx, executed.journal, "old"), executed.journal, "old");
        expect(recovered.outcome).toBe("third_value");
        expect(publicationIo.capturePublicationTree(locations.original)).toEqual(original);
        const retained = occupied ? locations.quarantine : locations.target;
        expect(inspectDirectoryNoFollow(retained)).toEqual(newIdentity);
        expect(fs.readFileSync(path.join(retained, "SKILL.md"), "utf8")).toBe("# late external edit\n");
        if (occupied) expect(fs.readFileSync(path.join(locations.target, "SKILL.md"), "utf8")).toBe("# new occupant\n");
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(recovered.journal);
    });

    it("does not recursively delete an unexpected root child while ending preparation", () => {
        const h = publicationFixture();
        const operation = executePublications(h.ctx, h.journal);
        const journal = persistStep(h, operation, h.journal);
        const outsider = path.join(journal.staging.rootPath, "unexpected.txt");
        fs.writeFileSync(outsider, "keep");
        expect(h.drive(recoverPublications(h.ctx, journal, "old"), journal, "old").outcome).toBe("io_failed");
        expect(fs.readFileSync(outsider, "utf8")).toBe("keep");
        expect(fs.readFileSync(path.join(h.target, h.leaf, "SKILL.md"), "utf8")).toBe("# original\n");
    });

    it("rejects null publication units as corrupt instead of throwing", () => {
        const h = publicationFixture();
        expect(isValidJournal({ ...h.journal, publications: [null] })).toBe(false);
    });
});
