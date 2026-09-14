/** Physical directory substitutions in the final publication, recovery and cleanup windows. */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { executePublications, recoverPublications } from "../../src/deployment/deployment-publication";
import { recordPublicationJournal } from "../../src/deployment/deployment-publication-journal";
import * as io from "../../src/deployment/deployment-publication-io";
import { persistStep, publicationFixture } from "./fixtures/deployment-publication-fixtures";

describe("complete directory physical race windows", () => {
    it("retains the published candidate when the original recovery source is missing and resumes when it returns", () => {
        const h = publicationFixture();
        const before = io.capturePublicationTree(path.join(h.target, h.leaf));
        const executed = h.drive(executePublications(h.ctx, h.journal), h.journal, "execute");
        const locations = io.publicationLocations(h.ctx, executed.journal, 0);
        const retained = path.join(h.root, "retained-source");
        fs.renameSync(locations.original, retained);
        const result = h.drive(recoverPublications(h.ctx, executed.journal, "old"), executed.journal, "old");
        expect(result.outcome).toBe("io_failed");
        expect(fs.existsSync(locations.target)).toBe(false);
        expect(fs.readFileSync(path.join(locations.quarantine, "SKILL.md"), "utf8")).toBe("# Complete skill\n");
        expect(io.capturePublicationTree(retained)).toEqual(before);
        fs.renameSync(retained, locations.original);
        expect(h.drive(recoverPublications(h.ctx, result.journal, "old"), result.journal, "old").outcome).toBe("done");
        expect(io.capturePublicationTree(locations.target)).toEqual(before);
    });

    it.each([
        "original_displaced",
        "prepared_edited",
        "published_edited",
    ])("retains original recovery material after %s", (fault) => {
        const h = publicationFixture();
        const locations = io.publicationLocations(h.ctx, h.journal, 0);
        const before = io.capturePublicationTree(locations.target);
        const retained = path.join(h.root, "displaced-original");
        const move = io.movePublicationEntry;
        vi.spyOn(io, "movePublicationEntry").mockImplementation((source, destination, kind, identity) => {
            const result = move(source, destination, kind, identity);
            if (destination === locations.original && fault === "original_displaced") fs.renameSync(destination, retained);
            if (destination === locations.original && fault === "prepared_edited")
                fs.writeFileSync(path.join(locations.prepared, "SKILL.md"), "external prepared edit");
            if (destination === locations.target && fault === "published_edited")
                fs.writeFileSync(path.join(destination, "SKILL.md"), "external public edit");
            return result;
        });
        const executed = h.drive(executePublications(h.ctx, h.journal), h.journal, "execute");
        expect(executed.outcome).toBe("io_failed");
        expect(io.capturePublicationTree(fault === "original_displaced" ? retained : locations.original)).toEqual(before);
        if (fault === "published_edited")
            expect(fs.readFileSync(path.join(locations.target, "SKILL.md"), "utf8")).toBe("external public edit");
        else expect(fs.existsSync(locations.target)).toBe(false);
    });

    it.each([
        "old",
        "new",
    ] as const)("preserves a public directory substituted with the same content during %s recovery", (side) => {
        const h = publicationFixture();
        const executed = h.drive(executePublications(h.ctx, h.journal), h.journal, "execute");
        const locations = io.publicationLocations(h.ctx, executed.journal, 0);
        const retained = path.join(h.root, "retained-public");
        fs.renameSync(locations.target, retained);
        fs.cpSync(retained, locations.target, { recursive: true, preserveTimestamps: true });
        const replacement = io.capturePublicationTree(locations.target);
        expect(h.drive(recoverPublications(h.ctx, executed.journal, side), executed.journal, side).outcome).toBe("third_value");
        expect(io.capturePublicationTree(locations.target)).toEqual(replacement);
        expect(fs.existsSync(retained)).toBe(true);
    });

    it.each(["original_without_old_tree", "quarantine_without_intent"])("preserves the unowned private slot %s", (fault) => {
        const h = publicationFixture(false);
        const executed = h.drive(executePublications(h.ctx, h.journal), h.journal, "execute");
        const locations = io.publicationLocations(h.ctx, executed.journal, 0);
        const unknown = fault === "original_without_old_tree" ? locations.original : locations.quarantine;
        fs.mkdirSync(unknown);
        fs.writeFileSync(path.join(unknown, "external.txt"), "unowned private slot");
        expect(h.drive(recoverPublications(h.ctx, executed.journal, "new"), executed.journal, "new").outcome).toBe("third_value");
        expect(fs.readFileSync(path.join(unknown, "external.txt"), "utf8")).toBe("unowned private slot");
    });

    it("preserves a prepared tree edited after publishing permission without disturbing the original public tree", () => {
        const h = publicationFixture();
        const operation = executePublications(h.ctx, h.journal);
        let journal = h.journal;
        for (let step = 0; step < 3; step += 1) journal = persistStep(h, operation, journal);
        const locations = io.publicationLocations(h.ctx, journal, 0);
        const original = io.capturePublicationTree(locations.target);
        fs.writeFileSync(path.join(locations.prepared, "SKILL.md"), "external prepared value");
        expect(h.drive(recoverPublications(h.ctx, journal, "old"), journal, "old").outcome).toBe("third_value");
        expect(io.capturePublicationTree(locations.target)).toEqual(original);
        expect(fs.readFileSync(path.join(locations.prepared, "SKILL.md"), "utf8")).toBe("external prepared value");
    });

    it("preserves a third value that appears after a directory recovery intent was persisted", () => {
        const h = publicationFixture();
        const executed = h.drive(executePublications(h.ctx, h.journal), h.journal, "execute");
        const step = recoverPublications(h.ctx, executed.journal, "old").next();
        if (step.done) throw new Error("expected directory recovery intent");
        const journal = recordPublicationJournal(h.transactions, executed.journal, step.value, "old");
        fs.writeFileSync(path.join(h.target, h.leaf, "SKILL.md"), "external after intent");
        expect(h.drive(recoverPublications(h.ctx, journal, "old"), journal, "old").outcome).toBe("third_value");
        expect(fs.readFileSync(path.join(h.target, h.leaf, "SKILL.md"), "utf8")).toBe("external after intent");
    });

    it.each(["quarantine_displaced", "restored_target_edited"])("retains both recovery trees after %s", (fault) => {
        const h = publicationFixture();
        const executed = h.drive(executePublications(h.ctx, h.journal), h.journal, "execute");
        const locations = io.publicationLocations(h.ctx, executed.journal, 0);
        const move = io.movePublicationEntry;
        const retained = path.join(h.root, "retained-quarantine");
        vi.spyOn(io, "movePublicationEntry").mockImplementation((source, destination, kind, identity) => {
            const result = move(source, destination, kind, identity);
            if (destination === locations.quarantine && fault === "quarantine_displaced") fs.renameSync(destination, retained);
            if (destination === locations.target && fault === "restored_target_edited")
                fs.writeFileSync(path.join(destination, "SKILL.md"), "external restored value");
            return result;
        });
        const recovered = h.drive(recoverPublications(h.ctx, executed.journal, "old"), executed.journal, "old");
        expect(recovered.outcome).toBe(fault === "quarantine_displaced" ? "io_failed" : "third_value");
        if (fault === "quarantine_displaced") {
            expect(fs.readFileSync(path.join(retained, "SKILL.md"), "utf8")).toBe("# Complete skill\n");
            expect(fs.readFileSync(path.join(locations.original, "SKILL.md"), "utf8")).toBe("# original\n");
        } else expect(fs.readFileSync(path.join(locations.target, "SKILL.md"), "utf8")).toBe("external restored value");
    });

    it("preserves a retained original changed between validation and final cleanup", () => {
        const h = publicationFixture();
        const executed = h.drive(executePublications(h.ctx, h.journal), h.journal, "execute");
        const locations = io.publicationLocations(h.ctx, executed.journal, 0);
        const capture = io.capturePublicationTree;
        let observations = 0;
        vi.spyOn(io, "capturePublicationTree").mockImplementation((file) => {
            if (file === locations.original && ++observations === 2)
                fs.writeFileSync(path.join(file, "SKILL.md"), "external cleanup value");
            return capture(file);
        });
        expect(h.drive(recoverPublications(h.ctx, executed.journal, "new"), executed.journal, "new").outcome).toBe("third_value");
        expect(fs.readFileSync(path.join(locations.original, "SKILL.md"), "utf8")).toBe("external cleanup value");
        expect(fs.readFileSync(path.join(locations.target, "SKILL.md"), "utf8")).toBe("# Complete skill\n");
    });
});
