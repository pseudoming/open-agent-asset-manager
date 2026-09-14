/** Real publisher steps exercise the restricted operation's receipt and verification boundaries. */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as journalOwner from "../../src/deployment/deployment-publication-journal";
import { createRestrictedPublicationOperation } from "../../src/deployment/restricted-target-publication-operation";
import { capturePublicationTree } from "../../src/deployment/deployment-publication-io";
import { publicationFixture } from "./fixtures/deployment-publication-fixtures";

describe("restricted publication step ownership", () => {
    it("reports uncertainty when forward execution encounters an already occupied staging root", () => {
        const h = publicationFixture();
        fs.mkdirSync(h.journal.staging.rootPath);
        fs.writeFileSync(path.join(h.journal.staging.rootPath, "external.txt"), "retain unreceipted object");
        const operation = createRestrictedPublicationOperation(h.target, () => undefined);
        expect(operation.start(h.journal, "execute")).toEqual({ kind: "executed", result: { outcome: "uncertain" } });
        expect(operation.pending).toBe(false);
        expect(fs.readFileSync(path.join(h.journal.staging.rootPath, "external.txt"), "utf8")).toBe("retain unreceipted object");
    });

    it("rejects continuation without an exact pending receipt and cannot replace pending work", () => {
        const h = publicationFixture();
        const operation = createRestrictedPublicationOperation(h.target, () => undefined);
        expect(operation.pending).toBe(false);
        expect(() => operation.continue(h.journal)).toThrow("persisted exactly");
        const first = operation.start(h.journal, "execute");
        expect(first.kind).toBe("publication_receipt_required");
        expect(operation.pending).toBe(true);
        expect(() => operation.start(h.journal, "execute")).toThrow("pending receipt");
        expect(() => operation.continue(h.journal)).toThrow("persisted exactly");
        expect(fs.readFileSync(path.join(h.target, h.leaf, "SKILL.md"), "utf8")).toBe("# original\n");
    });

    it("halts before public writes when receipt validation rejects the actual staging transition", () => {
        const h = publicationFixture();
        const before = capturePublicationTree(path.join(h.target, h.leaf));
        const validate = vi.spyOn(journalOwner, "isPublicationJournalTransition").mockReturnValueOnce(false);
        const operation = createRestrictedPublicationOperation(h.target, () => undefined);
        expect(() => operation.start(h.journal, "execute")).toThrow("invalid publication receipt transition");
        expect(validate).toHaveBeenCalledOnce();
        expect(fs.existsSync(h.journal.staging.rootPath)).toBe(true);
        expect(capturePublicationTree(path.join(h.target, h.leaf))).toEqual(before);
    });

    it.each([
        "file",
        "directory",
    ])("reports uncertainty when the %s changes after actual publication and before verification", (changed) => {
        const h = publicationFixture();
        let checks = 0;
        const operation = createRestrictedPublicationOperation(h.target, () => {
            checks += 1;
            if (checks !== 8) return;
            if (changed === "file") fs.writeFileSync(path.join(h.target, h.leaf, "SKILL.md"), "external edit");
            else fs.mkdirSync(path.join(h.target, h.leaf, "external-empty"));
        });
        let current = h.journal;
        let step = operation.start(current, "execute");
        let receipts = 0;
        while (step.kind === "publication_receipt_required") {
            expect(receipts++).toBeLessThan(4);
            current = journalOwner.recordPublicationJournal(h.transactions, current, step.journal, "execute");
            step = operation.continue(current);
        }
        expect(step).toEqual({ kind: "executed", result: { outcome: "uncertain" } });
        expect(checks).toBe(8);
        expect(operation.pending).toBe(false);
        expect(() => operation.continue(current)).toThrow("persisted exactly");
        if (changed === "file") expect(fs.readFileSync(path.join(h.target, h.leaf, "SKILL.md"), "utf8")).toBe("external edit");
        else expect(fs.statSync(path.join(h.target, h.leaf, "external-empty")).isDirectory()).toBe(true);
    });
});
