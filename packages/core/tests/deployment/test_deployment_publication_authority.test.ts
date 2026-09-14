/** Persisted graph and receipt corruption must not become publication or recovery authority. */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { type ActiveJournalV4, isValidJournal, readJournal } from "../../src/deployment/deployment-journal";
import type { JournalPublication } from "../../src/deployment/deployment-publication-model";
import { isPublicationJournalTransition, recordPublicationJournal } from "../../src/deployment/deployment-publication-journal";
import { publicationFixture, fileFixture, persistStep } from "./fixtures/deployment-publication-fixtures";
import { executePublications, recoverPublications } from "../../src/deployment/deployment-publication";
import { capturePublicationTree } from "../../src/deployment/deployment-publication-io";

const directory = (journal: ActiveJournalV4) => journal.publications[0] as Extract<JournalPublication, { kind: "directory" }>;
type Corruption = { name: string; mutate(journal: ActiveJournalV4): void };
const corruptions: Corruption[] = [
    {
        name: "old identity includes an extra authority field",
        mutate: (j) => {
            Object.assign(directory(j).oldTree!.identity, { trusted: true });
        },
    },
    {
        name: "unknown journal authority",
        mutate: (j) => {
            Object.assign(j, { force: true });
        },
    },
    {
        name: "foreign execution route",
        mutate: (j) => {
            j.targetExecution = { kind: "foreign" } as never;
        },
    },
    {
        name: "staging root is not canonical",
        mutate: (j) => {
            j.staging.rootPath = "../temporary";
        },
    },
    {
        name: "staging root has unknown attributes",
        mutate: (j) => {
            Object.assign(j.staging, { disposable: true });
        },
    },
    {
        name: "staging identity has wrong physical kind",
        mutate: (j) => {
            j.staging.identity = { ...directory(j).oldTree!.identity, entryKind: "file" };
        },
    },
    {
        name: "unknown publication phase",
        mutate: (j) => {
            j.publicationPhase = "committed" as never;
        },
    },
    {
        name: "publication units are not an array",
        mutate: (j) => {
            j.publications = {} as never;
        },
    },
    {
        name: "old tree has unknown attributes",
        mutate: (j) => {
            Object.assign(directory(j).oldTree!, { stale: true });
        },
    },
    {
        name: "old tree files are not an array",
        mutate: (j) => {
            directory(j).oldTree!.files = {} as never;
        },
    },
    {
        name: "old tree file executable is not boolean",
        mutate: (j) => {
            directory(j).oldTree!.files[0]!.executable = "yes" as never;
        },
    },
    {
        name: "unknown unit kind",
        mutate: (j) => {
            j.publications[0]!.kind = "unknown" as never;
        },
    },
    {
        name: "non-boolean overwrite grant",
        mutate: (j) => {
            j.publications[0]!.completeReplacement = "true" as never;
        },
    },
    {
        name: "unknown unit field",
        mutate: (j) => {
            Object.assign(j.publications[0]!, { targetRoot: "/" });
        },
    },
    {
        name: "missing publication coverage",
        mutate: (j) => {
            j.publications = [];
        },
    },
    {
        name: "duplicate directory publication",
        mutate: (j) => {
            j.publications.push(structuredClone(j.publications[0]!));
        },
    },
    {
        name: "overlapping file and directory publication",
        mutate: (j) => {
            j.publications.push({
                kind: "file",
                relativePath: j.entries[0]!.relativePath,
                completeReplacement: true,
                recovery: null,
            });
        },
    },
    {
        name: "directory outside owned closure",
        mutate: (j) => {
            j.publications[0]!.relativePath = "sibling";
        },
    },
    {
        name: "prepared receipt is a regular file",
        mutate: (j) => {
            directory(j).preparedIdentity = { ...directory(j).oldTree!.identity, entryKind: "file" };
        },
    },
    {
        name: "old tree is a file",
        mutate: (j) => {
            directory(j).oldTree!.identity.entryKind = "file";
        },
    },
    {
        name: "old tree has an empty device identity",
        mutate: (j) => {
            directory(j).oldTree!.identity.deviceId = "";
        },
    },
    {
        name: "old tree has a null-byte inode identity",
        mutate: (j) => {
            directory(j).oldTree!.identity.fileId = "inode\0suffix";
        },
    },
    {
        name: "old tree has no root",
        mutate: (j) => {
            directory(j).oldTree!.directoryPaths = ["nested"];
        },
    },
    {
        name: "old tree has duplicate directories",
        mutate: (j) => {
            directory(j).oldTree!.directoryPaths.push("");
        },
    },
    {
        name: "old tree contains a traversal path",
        mutate: (j) => {
            directory(j).oldTree!.directoryPaths.push("../sibling");
        },
    },
    {
        name: "old tree exceeds its directory bound",
        mutate: (j) => {
            directory(j).oldTree!.directoryPaths = Array.from({ length: 4097 }, (_, i) => `d${i}`);
        },
    },
    {
        name: "old tree exceeds its file bound",
        mutate: (j) => {
            directory(j).oldTree!.files = Array(4097).fill(directory(j).oldTree!.files[0]);
        },
    },
    {
        name: "old tree contains an unknown file attribute",
        mutate: (j) => {
            Object.assign(directory(j).oldTree!.files[0]!, { optionalResource: true });
        },
    },
    {
        name: "old tree contains an invalid file hash",
        mutate: (j) => {
            directory(j).oldTree!.files[0]!.contentHash = "unbound";
        },
    },
    {
        name: "old tree contains duplicate files",
        mutate: (j) => {
            directory(j).oldTree!.files.push(structuredClone(directory(j).oldTree!.files[0]!));
        },
    },
    {
        name: "old tree omits a file parent",
        mutate: (j) => {
            directory(j).oldTree!.files[0]!.relativePath = "missing/child";
        },
    },
    {
        name: "old tree gives a file and directory the same path",
        mutate: (j) => {
            directory(j).oldTree!.directoryPaths = ["", directory(j).oldTree!.files[0]!.relativePath];
        },
    },
    {
        name: "unknown recovery side",
        mutate: (j) => {
            j.publications[0]!.recovery = { side: "both" as never, candidateIdentity: null, restoreIdentity: null };
        },
    },
    {
        name: "directory restoration must reuse its retained tree",
        mutate: (j) => {
            j.publications[0]!.recovery = {
                side: "old",
                candidateIdentity: null,
                restoreIdentity: directory(j).oldTree!.identity,
            };
        },
    },
    {
        name: "recovery candidate has the wrong physical kind",
        mutate: (j) => {
            j.publications[0]!.recovery = {
                side: "old",
                candidateIdentity: { ...directory(j).oldTree!.identity, entryKind: "file" },
                restoreIdentity: null,
            };
        },
    },
];

describe("V4 immutable publication authority", () => {
    it.each([
        "replace_scope",
        "recover_old_tree",
        "protected_old_tree",
        "recover_prepared_identity",
        "replace_prepared_identity",
        "clear_prepared_identity",
    ])("rejects a valid-shaped but unauthorized receipt: %s", (change) => {
        const h = publicationFixture(true, "leaf", change !== "protected_old_tree");
        const operation = executePublications(h.ctx, h.journal);
        let previous = persistStep(h, operation, h.journal);
        if (change === "replace_prepared_identity" || change === "clear_prepared_identity")
            previous = persistStep(h, operation, previous);
        const next = structuredClone(previous);
        const unit = directory(next);
        if (change === "replace_scope") unit.completeReplacement = !unit.completeReplacement;
        if (change.endsWith("old_tree")) unit.oldTree!.files[0]!.contentHash = `sha256:${"d".repeat(64)}`;
        if (change.endsWith("prepared_identity"))
            unit.preparedIdentity =
                change === "clear_prepared_identity" ? null : { ...unit.oldTree!.identity, fileId: "another-prepared-object" };
        const mode = change.startsWith("recover_") ? "old" : "execute";
        expect(isValidJournal(next)).toBe(true);
        expect(isPublicationJournalTransition(previous, next, mode)).toBe(false);
        expect(() => recordPublicationJournal(h.transactions, previous, next, mode)).toThrow("changed before its exact receipt");
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(previous);
        expect(fs.readFileSync(path.join(h.target, h.leaf, "SKILL.md"), "utf8")).toBe("# original\n");
    });

    it.each([
        "wrong_side",
        "candidate_identity",
        "restoration_identity",
    ])("rejects recovery receipt %s without changing the public file", (change) => {
        const h = fileFixture();
        const executed = h.drive(executePublications(h.ctx, h.journal), h.journal, "execute");
        const operation = recoverPublications(h.ctx, executed.journal, "old");
        const intent = operation.next();
        if (intent.done) throw new Error("expected recovery intent");
        let previous = recordPublicationJournal(h.transactions, executed.journal, intent.value, "old");
        if (change === "restoration_identity") {
            const prepared = operation.next();
            if (prepared.done) throw new Error("expected restoration identity");
            previous = recordPublicationJournal(h.transactions, previous, prepared.value, "old");
        }
        const next = structuredClone(previous);
        const recovery = next.publications[0]!.recovery!;
        if (change === "wrong_side") recovery.side = "new";
        else if (change === "candidate_identity")
            recovery.candidateIdentity = { ...recovery.candidateIdentity!, fileId: "foreign-candidate" };
        else recovery.restoreIdentity = { ...recovery.restoreIdentity!, fileId: "foreign-restoration" };
        expect(isValidJournal(next)).toBe(true);
        expect(isPublicationJournalTransition(previous, next, "old")).toBe(false);
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(previous);
        expect(fs.readFileSync(h.targetFile, "utf8")).toBe("desired");
    });

    it.each(corruptions)("rejects $name on journal reopen while preserving the target", ({ mutate }) => {
        const h = publicationFixture();
        const before = capturePublicationTree(path.join(h.target, h.leaf));
        const corrupt = structuredClone(h.journal);
        mutate(corrupt);
        expect(isValidJournal(corrupt)).toBe(false);
        fs.writeFileSync(path.join(h.transactions, corrupt.transactionId, "journal.json"), JSON.stringify(corrupt));
        expect(readJournal(h.transactions, corrupt.transactionId)).toBeNull();
        expect(capturePublicationTree(path.join(h.target, h.leaf))).toEqual(before);
    });

    it("rejects a complete-file removal and an unbound file publication", () => {
        const h = fileFixture();
        const removal = structuredClone(h.journal);
        removal.entries[0] = {
            ...removal.entries[0]!,
            isRemoval: true,
            newHash: "",
            newBytesBase64: "",
            newExecutable: false,
            newProvenanceFingerprint: "",
            newMaterializationFingerprint: "",
        };
        expect(isValidJournal(removal)).toBe(false);
        const missing = structuredClone(h.journal);
        missing.publications[0]!.relativePath = "unbound.md";
        expect(isValidJournal(missing)).toBe(false);
    });

    it("rejects authority or staging-root changes before persisting a valid-looking receipt", () => {
        const h = publicationFixture();
        const operation = executePublications(h.ctx, h.journal);
        const step = operation.next();
        if (step.done) throw new Error("expected the initial root receipt");
        for (const field of ["deployment", "root", "unit_count", "invalid_schema"] as const) {
            const forged = structuredClone(step.value);
            if (field === "deployment") forged.deploymentId = "22222222-2222-4222-8222-222222222222";
            if (field === "root")
                forged.staging.rootPath = path.join(h.root, "alternate", `oaam-deployment-${forged.transactionId}`);
            if (field === "unit_count") forged.publications = [];
            if (field === "invalid_schema") forged.schemaVersion = 2 as never;
            expect(isPublicationJournalTransition(h.journal, forged, "execute")).toBe(false);
            expect(() => recordPublicationJournal(h.transactions, h.journal, forged, "execute")).toThrow(/exact receipt/);
        }
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(h.journal);
    });

    it("rejects a stale writer after another exact root receipt has become durable", () => {
        const h = publicationFixture();
        const operation = executePublications(h.ctx, h.journal);
        const receipt = persistStep(h, operation, h.journal);
        expect(isPublicationJournalTransition(h.journal, receipt, "execute")).toBe(true);
        expect(() => recordPublicationJournal(h.transactions, h.journal, receipt, "execute")).toThrow(/exact receipt/);
        expect(readJournal(h.transactions, h.journal.transactionId)).toEqual(receipt);
    });
});
