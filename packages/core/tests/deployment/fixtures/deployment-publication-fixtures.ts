/** Shared isolated physical fixtures for publication and interruption regressions. */
import * as fs from "node:fs";
import * as path from "node:path";
import { expect } from "vitest";
import { fixture } from "./restricted-target-graph-fixture";
import { createTargetIo } from "../../../src/deployment/deployment-target-io";
import { isValidJournal, type ActiveJournalV4 } from "../../../src/deployment/deployment-journal";
import { planPublications, type PublicationOperation } from "../../../src/deployment/deployment-publication";
import { drivePublicationJournal, recordPublicationJournal } from "../../../src/deployment/deployment-publication-journal";
import { sha256Bytes } from "../../../src/foundation/crypto-bytes";
import { computePhysicalKeys } from "../../../src/foundation/physical-path-locks";

export function publicationFixture(existing = true, leaf = "leaf", completeReplacement = true) {
    const h = fixture(existing, existing, leaf, (target) => {
        if (existing) fs.writeFileSync(path.join(target, leaf, "SKILL.md"), "# original\n");
    });
    const ctx = createTargetIo(h.target);
    const directoryEntries = h.journal.directoryEntries.map(({ restoredIdentity: _restored, ...entry }) => entry);
    const journal: ActiveJournalV4 = {
        ...h.journal,
        schemaVersion: 4,
        targetExecution: { kind: "host" },
        directoryEntries,
        staging: { rootPath: path.join(h.root, `oaam-deployment-${h.journal.transactionId}`), identity: null },
        publicationPhase: "preparing",
        publications: planPublications(
            ctx,
            h.journal.entries,
            directoryEntries,
            h.journal.managedDirectoryBoundaries,
            completeReplacement ? h.preview.runtimeReplacementAuthority.replacementScope! : { filePaths: [], directoryPaths: [] },
        ),
    };
    expect(isValidJournal(journal)).toBe(true);
    fs.writeFileSync(path.join(h.transactions, journal.transactionId, "journal.json"), JSON.stringify(journal));
    const drive = (operation: PublicationOperation, current: ActiveJournalV4, mode: "execute" | "old" | "new") =>
        drivePublicationJournal(operation, current, (previous, next) =>
            recordPublicationJournal(h.transactions, previous, next, mode),
        );
    return { ...h, ctx, journal, drive };
}

export function persistStep(h: ReturnType<typeof publicationFixture>, operation: PublicationOperation, journal: ActiveJournalV4) {
    const step = operation.next();
    if (step.done) throw new Error(`expected receipt, got ${step.value}`);
    return recordPublicationJournal(h.transactions, journal, step.value, "execute");
}

export function fileFixture(old: string | null = "original", executable = false, completeReplacement = true) {
    const h = fixture();
    const targetFile = path.join(h.target, "CLAUDE.md");
    if (old !== null) fs.writeFileSync(targetFile, old);
    const entry = {
        ...h.journal.entries[0]!,
        relativePath: "CLAUDE.md",
        newExecutable: executable,
        newHash: sha256Bytes(Buffer.from("desired")),
        newBytesBase64: Buffer.from("desired").toString("base64"),
        runtimeRollbackOverride:
            old === null
                ? { state: "missing" as const }
                : {
                      state: "present" as const,
                      contentHash: sha256Bytes(Buffer.from(old)),
                      bytesBase64: Buffer.from(old).toString("base64"),
                      executable: false,
                  },
    };
    const journal: ActiveJournalV4 = {
        ...h.journal,
        schemaVersion: 4,
        targetExecution: { kind: "host" },
        entries: [entry],
        managedDirectoryBoundaries: [],
        directoryEntries: [],
        staging: { rootPath: path.join(h.root, `oaam-deployment-${h.journal.transactionId}`), identity: null },
        publicationPhase: "preparing",
        publications: [{ kind: "file", relativePath: entry.relativePath, completeReplacement, recovery: null }],
        reservedPhysicalKeys: computePhysicalKeys("linux", h.target, [entry.relativePath]),
    };
    expect(isValidJournal(journal)).toBe(true);
    fs.writeFileSync(path.join(h.transactions, journal.transactionId, "journal.json"), JSON.stringify(journal));
    const ctx = createTargetIo(h.target);
    const persist = (mode: "execute" | "old" | "new") => (previous: ActiveJournalV4, next: ActiveJournalV4) =>
        recordPublicationJournal(h.transactions, previous, next, mode);
    const drive = (operation: PublicationOperation, current: ActiveJournalV4, mode: "execute" | "old" | "new") =>
        drivePublicationJournal(operation, current, persist(mode));
    return { ...h, ctx, journal, targetFile, drive, persist };
}
