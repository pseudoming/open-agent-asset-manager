/** Actual filesystem races around Shared's no-follow publication calls. */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executePublications, finalizePublications } from "../../src/deployment/deployment-publication";
import { DurableFilesystemMutationError } from "@oaam/shared/filesystem";
import * as io from "../../src/deployment/deployment-publication-io";
import { recordPublicationJournal } from "../../src/deployment/deployment-publication-journal";
import { fileFixture, persistStep, publicationFixture } from "./fixtures/deployment-publication-fixtures";

const faults = vi.hoisted(() => ({
    beforeEnsure: vi.fn(),
    beforePublish: vi.fn(),
    afterInspect: vi.fn(),
    beforeConfirm: vi.fn(),
    afterReplace: vi.fn(),
    recycleSupport: vi.fn(),
    recycleTree: vi.fn(),
    removeFile: vi.fn(),
}));
vi.mock("@oaam/shared/filesystem", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@oaam/shared/filesystem")>();
    return {
        ...actual,
        assertDirectoryTreeRecycleSupported: (...args: Parameters<typeof actual.assertDirectoryTreeRecycleSupported>) => {
            if (faults.recycleSupport.getMockImplementation() !== undefined) return faults.recycleSupport(...args);
            return actual.assertDirectoryTreeRecycleSupported(...args);
        },
        durableRecycleDirectoryTreeIfIdentity: (...args: Parameters<typeof actual.durableRecycleDirectoryTreeIfIdentity>) =>
            faults.recycleTree(...args),
        durableRemoveRegularFile: (...args: Parameters<typeof actual.durableRemoveRegularFile>) => {
            faults.removeFile(...args);
            return actual.durableRemoveRegularFile(...args);
        },
        durableReplaceFile: (...args: Parameters<typeof actual.durableReplaceFile>) => {
            const result = actual.durableReplaceFile(...args);
            faults.afterReplace(...args);
            return result;
        },
        durableEnsureDirectory: (...args: Parameters<typeof actual.durableEnsureDirectory>) => {
            faults.beforeEnsure(...args);
            return actual.durableEnsureDirectory(...args);
        },
        durablePublishDirectory: (...args: Parameters<typeof actual.durablePublishDirectory>) => {
            faults.beforePublish(...args);
            return actual.durablePublishDirectory(...args);
        },
        inspectDirectoryNoFollow: (...args: Parameters<typeof actual.inspectDirectoryNoFollow>) => {
            const result = actual.inspectDirectoryNoFollow(...args);
            faults.afterInspect(...args);
            return result;
        },
        confirmDurableDirectoryTreeNoFollow: (...args: Parameters<typeof actual.confirmDurableDirectoryTreeNoFollow>) => {
            faults.beforeConfirm(...args);
            return actual.confirmDurableDirectoryTreeNoFollow(...args);
        },
    };
});
afterEach(() => {
    for (const fault of Object.values(faults)) fault.mockReset();
});

describe("publication physical entry boundaries", () => {
    it("selects a file-only staging parent without optional anchors and rejects preparation of an absent desired tree", () => {
        const h = fileFixture();
        const selected = io.publicationStagingRoot(h.ctx, h.journal.transactionId, h.journal.publications, []);
        expect(path.basename(selected)).toBe(`oaam-deployment-${h.journal.transactionId}`);
        expect(fs.existsSync(selected)).toBe(false);
        expect(() =>
            io.fillPreparedDirectory(h.journal.staging.rootPath, h.journal, {
                kind: "directory",
                relativePath: "absent",
                completeReplacement: false,
                oldTree: null,
                preparedIdentity: null,
                recovery: null,
            }),
        ).toThrow("absent desired tree");
        expect(fs.existsSync(h.journal.staging.rootPath)).toBe(false);
    });

    it.each(["corrupt", "different"])("rejects a %s journal readback after its real durable write", (fault) => {
        const h = publicationFixture();
        const before = io.capturePublicationTree(path.join(h.target, h.leaf));
        const step = executePublications(h.ctx, h.journal).next();
        if (step.done) throw new Error("expected staging receipt");
        faults.afterReplace.mockImplementationOnce((journalPath: string) => {
            expect(journalPath).toBe(path.join(h.transactions, h.journal.transactionId, "journal.json"));
            fs.writeFileSync(
                journalPath,
                fault === "corrupt" ? "{" : JSON.stringify({ ...step.value, createdAt: step.value.createdAt + 1 }),
            );
        });
        expect(() => recordPublicationJournal(h.transactions, h.journal, step.value, "execute")).toThrow(
            "receipt did not read back",
        );
        expect(io.capturePublicationTree(path.join(h.target, h.leaf))).toEqual(before);
        expect(fs.existsSync(h.journal.staging.rootPath)).toBe(true);
    });

    it("rejects wrong-kind reads and an occupied staging directory", () => {
        const h = publicationFixture();
        const leaf = path.join(h.target, h.leaf);
        expect(() => io.publicationIdentity(leaf, "file")).toThrow();
        expect(() => io.readPublicationFile(leaf)).toThrow();
        expect(() => io.createPreparedDirectory(leaf)).toThrow("unreceipted staging directory already exists");
        expect(fs.readFileSync(path.join(leaf, "SKILL.md"), "utf8")).toBe("# original\n");
    });

    it("rejects an actual directory created between the absence check and exclusive creation", () => {
        const h = publicationFixture();
        faults.beforeEnsure.mockImplementationOnce((parent: string, name: string) => {
            fs.mkdirSync(path.join(parent, name));
            fs.writeFileSync(path.join(parent, name, "external.txt"), "concurrent creator");
        });
        expect(() => io.createPreparedDirectory(h.journal.staging.rootPath)).toThrow("creation was not exclusive");
        expect(fs.readFileSync(path.join(h.journal.staging.rootPath, "external.txt"), "utf8")).toBe("concurrent creator");
    });

    it("retains both objects when the source is substituted after the move's identity check", () => {
        const h = publicationFixture();
        const source = path.join(h.target, h.leaf);
        const original = io.capturePublicationTree(source)!;
        const retained = path.join(h.root, "retained-original");
        const destination = path.join(h.root, "destination");
        faults.beforePublish.mockImplementationOnce(() => {
            fs.renameSync(source, retained);
            fs.mkdirSync(source);
            fs.writeFileSync(path.join(source, "external.txt"), "new source");
        });
        expect(() => io.movePublicationEntry(source, destination, "directory", original.identity)).toThrow("unexpected object");
        expect(io.capturePublicationTree(retained)).toEqual(original);
        expect(fs.readFileSync(path.join(destination, "external.txt"), "utf8")).toBe("new source");
    });

    it("refuses a stale source or cleanup identity before changing either location", () => {
        const h = publicationFixture();
        const source = path.join(h.target, h.leaf);
        const original = io.capturePublicationTree(source)!;
        const stale = { ...original.identity, fileId: `${original.identity.fileId}-stale` };
        expect(() => io.movePublicationEntry(source, path.join(h.root, "destination"), "directory", stale)).toThrow(
            "source identity changed",
        );
        expect(() => io.removeOwnedPublication(source, "directory", stale)).toThrow("identity changed before cleanup");
        expect(() => io.removeEmptyPublicationStaging(source, stale)).toThrow("staging root identity changed");
        expect(io.capturePublicationTree(source)).toEqual(original);
        expect(fs.existsSync(path.join(h.root, "destination"))).toBe(false);
    });

    it("preserves both sources when their identity changes during durability confirmation", () => {
        const h = publicationFixture();
        const source = path.join(h.target, h.leaf);
        const original = io.capturePublicationTree(source)!;
        const retained = path.join(h.root, "retained-before-confirmation");
        const destination = path.join(h.root, "destination");
        faults.beforeConfirm.mockImplementationOnce((confirmed: string) => {
            expect(confirmed).toBe(source);
            fs.renameSync(source, retained);
            fs.mkdirSync(source);
            fs.writeFileSync(path.join(source, "external.txt"), "replacement during confirmation");
        });
        expect(() => io.movePublicationEntry(source, destination, "directory", original.identity)).toThrow(
            "source identity changed during durability confirmation",
        );
        expect(io.capturePublicationTree(retained)).toEqual(original);
        expect(fs.readFileSync(path.join(source, "external.txt"), "utf8")).toBe("replacement during confirmation");
        expect(fs.existsSync(destination)).toBe(false);
        expect(faults.beforePublish).not.toHaveBeenCalled();
    });

    it("leaves the original directory in place when durability confirmation fails", () => {
        const h = publicationFixture();
        const source = path.join(h.target, h.leaf);
        const original = io.capturePublicationTree(source)!;
        const destination = path.join(h.root, "destination");
        faults.beforeConfirm.mockImplementationOnce(() => {
            throw new Error("injected fsync failure");
        });
        expect(() => io.movePublicationEntry(source, destination, "directory", original.identity)).toThrow(
            "injected fsync failure",
        );
        expect(io.capturePublicationTree(source)).toEqual(original);
        expect(fs.existsSync(destination)).toBe(false);
        expect(faults.beforePublish).not.toHaveBeenCalled();
    });

    it("preserves a tree displaced between cleanup's identity observation and graph capture", () => {
        const h = publicationFixture();
        const source = path.join(h.target, h.leaf);
        const original = io.capturePublicationTree(source)!;
        const retained = path.join(h.root, "displaced-cleanup");
        faults.afterInspect.mockImplementationOnce((inspected: string) => {
            expect(inspected).toBe(source);
            fs.renameSync(source, retained);
        });
        expect(() => io.removeOwnedPublication(source, "directory", original.identity)).toThrow(
            "owned tree changed before cleanup",
        );
        expect(io.capturePublicationTree(retained)).toEqual(original);
    });

    it("recycles one confirmed private tree with its identity and exact child bound when supported", () => {
        const h = publicationFixture(),
            source = path.join(h.target, h.leaf);
        const original = io.capturePublicationTree(source)!;
        const recycled = path.join(h.root, "recycled-owned-tree");
        faults.recycleSupport.mockImplementation(() => {});
        faults.recycleTree.mockImplementation((target, identity, maximumEntries) => {
            expect(target).toBe(source);
            expect(identity).toEqual(original.identity);
            expect(maximumEntries).toBe(original.files.length + original.directoryPaths.length - 1);
            // A real move retains the complete graph in this isolated physical-recycle seam.
            fs.renameSync(target, recycled);
            return true;
        });
        io.removeOwnedPublication(source, "directory", original.identity, original);
        expect(faults.recycleTree).toHaveBeenCalledTimes(1);
        expect(faults.removeFile).not.toHaveBeenCalled();
        expect(fs.existsSync(source)).toBe(false);
        expect(io.capturePublicationTree(recycled)).toEqual(original);
    });

    it("keeps the existing per-entry cleanup when this physical backend cannot recycle directories", () => {
        const h = publicationFixture(),
            source = path.join(h.target, h.leaf);
        const original = io.capturePublicationTree(source)!;
        io.removeOwnedPublication(source, "directory", original.identity, original);
        expect(faults.recycleTree).not.toHaveBeenCalled();
        expect(faults.removeFile).toHaveBeenCalledTimes(original.files.length);
        expect(fs.existsSync(source)).toBe(false);
    });

    it("keeps per-entry cleanup for incomplete preparations without a journal tree snapshot", () => {
        const h = publicationFixture(),
            source = path.join(h.target, h.leaf);
        const original = io.capturePublicationTree(source)!;
        faults.recycleSupport.mockImplementation(() => {});
        io.removeOwnedPublication(source, "directory", original.identity);
        expect(faults.recycleSupport).not.toHaveBeenCalled();
        expect(faults.recycleTree).not.toHaveBeenCalled();
        expect(faults.removeFile).toHaveBeenCalledTimes(original.files.length);
        expect(fs.existsSync(source)).toBe(false);
    });

    it("preserves a known tree whose content changed before cleanup despite unchanged root identity", () => {
        const h = publicationFixture(),
            source = path.join(h.target, h.leaf);
        const original = io.capturePublicationTree(source)!;
        fs.writeFileSync(path.join(source, "late-notes.md"), "Keep the external addition");
        const changed = io.capturePublicationTree(source);
        expect(() => io.removeOwnedPublication(source, "directory", original.identity, original)).toThrow(
            "owned tree content changed before cleanup",
        );
        expect(io.capturePublicationTree(source)).toEqual(changed);
        expect(faults.recycleTree).not.toHaveBeenCalled();
        expect(faults.removeFile).not.toHaveBeenCalled();
    });

    it("rechecks new content after recycle support preflight before any cleanup", () => {
        const h = publicationFixture(),
            source = path.join(h.target, h.leaf);
        const original = io.capturePublicationTree(source)!;
        faults.recycleSupport.mockImplementation(() => {
            fs.writeFileSync(path.join(source, "late-notes.md"), "Keep the racing addition");
        });
        expect(() => io.removeOwnedPublication(source, "directory", original.identity, original)).toThrow(
            "owned tree changed before recycle",
        );
        expect(fs.readFileSync(path.join(source, "late-notes.md"), "utf8")).toBe("Keep the racing addition");
        expect(faults.recycleTree).not.toHaveBeenCalled();
        expect(faults.removeFile).not.toHaveBeenCalled();
    });

    it("rejects a same-count member rename during preflight instead of treating the count bound as graph identity", () => {
        const h = publicationFixture(),
            source = path.join(h.target, h.leaf);
        const original = io.capturePublicationTree(source)!;
        faults.recycleSupport.mockImplementation(() => {
            fs.renameSync(path.join(source, "SKILL.md"), path.join(source, "late-notes.md"));
        });
        expect(() => io.removeOwnedPublication(source, "directory", original.identity, original)).toThrow(
            "owned tree changed before recycle",
        );
        const changed = io.capturePublicationTree(source)!;
        expect(changed.files.length).toBe(original.files.length);
        expect(changed.files.some((file) => file.relativePath === "late-notes.md")).toBe(true);
        expect(faults.recycleTree).not.toHaveBeenCalled();
        expect(faults.removeFile).not.toHaveBeenCalled();
    });

    it.each(["missing", "replaced"])("preserves the original tree if its path becomes %s during recycle preflight", (change) => {
        const h = publicationFixture(),
            source = path.join(h.target, h.leaf);
        const original = io.capturePublicationTree(source)!;
        const displaced = path.join(h.root, "original-displaced-tree");
        faults.recycleSupport.mockImplementation(() => {
            fs.renameSync(source, displaced);
            if (change === "replaced") fs.mkdirSync(source);
        });
        expect(() => io.removeOwnedPublication(source, "directory", original.identity, original)).toThrow(
            "owned tree changed before recycle",
        );
        expect(io.capturePublicationTree(displaced)).toEqual(original);
        expect(faults.recycleTree).not.toHaveBeenCalled();
        expect(faults.removeFile).not.toHaveBeenCalled();
    });

    it("keeps recovery evidence when the recycle operation moves a private tree then reports uncertainty", () => {
        const h = publicationFixture();
        const published = h.drive(executePublications(h.ctx, h.journal), h.journal, "execute");
        expect(published.outcome).toBe("done");
        const locations = io.publicationLocations(h.ctx, published.journal, 0);
        const before = io.capturePublicationTree(locations.original)!;
        const retained = path.join(published.journal.staging.rootPath, "uncertain-recycle-stage");
        faults.recycleSupport.mockImplementation(() => {});
        faults.recycleTree.mockImplementation((target) => {
            fs.renameSync(target, retained);
            throw new DurableFilesystemMutationError({
                operation: "durable_remove_tree",
                failureKind: "io_error",
                targetPath: target,
                mutationState: "may_have_applied",
                message: "injected recycle uncertainty",
            });
        });
        expect(finalizePublications(h.ctx, published.journal)).toBe("io_failed");
        expect(io.capturePublicationTree(retained)).toEqual(before);
        expect(fs.existsSync(path.join(h.transactions, h.journal.transactionId, "journal.json"))).toBe(true);
        expect(fs.existsSync(published.journal.staging.rootPath)).toBe(true);
        expect(faults.removeFile).not.toHaveBeenCalled();
    });

    it.each(["support", "recycle"])("does not fall back to per-entry removal after a %s IO failure", (stage) => {
        const h = publicationFixture(),
            source = path.join(h.target, h.leaf);
        const original = io.capturePublicationTree(source)!;
        faults.recycleSupport.mockImplementation(() => {
            if (stage === "support") throw new Error("injected recycle support IO failure");
        });
        faults.recycleTree.mockImplementation(() => {
            throw new Error("injected recycle IO failure");
        });
        expect(() => io.removeOwnedPublication(source, "directory", original.identity, original)).toThrow("IO failure");
        expect(faults.removeFile).not.toHaveBeenCalled();
        expect(io.capturePublicationTree(source)).toEqual(original);
    });

    it.each([
        "unexpected_child",
        "changed_identity",
        "changed_content",
    ] as const)("refuses a prepared tree with %s before public mutation", (fault) => {
        const h = publicationFixture();
        const operation = executePublications(h.ctx, h.journal);
        let journal = persistStep(h, operation, h.journal);
        journal = persistStep(h, operation, journal);
        const locations = io.publicationLocations(h.ctx, journal, 0);
        const original = io.capturePublicationTree(locations.target);
        if (fault === "unexpected_child") fs.mkdirSync(path.join(locations.prepared, "empty"));
        else
            faults.beforeConfirm.mockImplementationOnce((prepared: string) => {
                expect(prepared).toBe(locations.prepared);
                if (fault === "changed_identity") {
                    fs.renameSync(prepared, path.join(h.root, "displaced-prepared"));
                    fs.mkdirSync(prepared);
                }
                fs.writeFileSync(path.join(prepared, "external.txt"), "keep preparation conflict");
            });
        const result = h.drive(operation, journal, "execute");
        expect(result.outcome).toBe("io_failed");
        expect(result.journal.publicationPhase).toBe("preparing");
        expect(io.capturePublicationTree(locations.target)).toEqual(original);
        expect(fs.existsSync(locations.prepared)).toBe(true);
    });
});
