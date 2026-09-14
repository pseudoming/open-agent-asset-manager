import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostReviewRecordStore } from "../src/review-record-store";
import { HostReviewRecords, HostReviewRecordUnavailableError } from "../src/review-records";
import { H2_DIGEST, H2_SOURCE_ROOT_ID, h2PreviewSnapshot, h2ProbeResult, h2ReadResult } from "./support/h2-review-fixtures";
import { required } from "./support/host-test-fixtures";

const temporaryRoots: string[] = [];

function reviewHarness() {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-host-import-preview-file-"));
    temporaryRoots.push(rootPath);
    let recordNumber = 0;
    let memberNumber = 0;
    const store = new HostReviewRecordStore({
        rootPath,
        createToken: () => `review-${++recordNumber}`,
    });
    return {
        store,
        records: new HostReviewRecords(store, () => `member-${++memberNumber}`),
    };
}

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe("Host import-preview file authority", () => {
    it("reveals only the uniquely attributed available source directory owned by the renderer connection", () => {
        const { records, store } = reviewHarness();
        const probeReview = records.recordProbe("connection", [h2ProbeResult()]);
        const read = h2ReadResult();
        read.observedReadEntries = [
            {
                observedReadEntryId: "observed-agents-file",
                sourceRootId: H2_SOURCE_ROOT_ID,
                relativePath: "AGENTS.md",
                entryKind: "file",
                contentHash: H2_DIGEST,
                executable: false,
                physicalIdentityFingerprint: H2_DIGEST,
            },
        ];
        required(read.candidates[0], "candidate").sourceFileOrigins = [
            { logicalPath: "AGENTS.md", observedReadEntryIds: ["observed-agents-file"] },
        ];
        required(read.candidates[0], "candidate").files.reverse();
        const readReview = records.recordRead("connection", probeReview.probeToken, [read]);
        const preview = records.recordPreview("connection", readReview.readToken, h2PreviewSnapshot(read));
        const reference = {
            previewToken: preview.previewToken,
            candidateId: "candidate-1",
            logicalPath: "AGENTS.md",
        };

        expect(records.resolveImportPreviewFileDirectory("connection", reference)).toBe("/project/.claude");
        expect(
            records.resolveImportPreviewFileDirectory("connection", {
                previewToken: preview.previewToken,
                candidateId: "candidate-1",
            }),
        ).toBe("/project/.claude");
        for (const denied of [
            () => records.resolveImportPreviewFileDirectory("other-connection", reference),
            () => records.resolveImportPreviewFileDirectory("connection", { ...reference, candidateId: "unknown" }),
            () => records.resolveImportPreviewFileDirectory("connection", { ...reference, logicalPath: "unknown.md" }),
        ]) {
            expect(denied).toThrow(HostReviewRecordUnavailableError);
        }

        const ambiguousRead = h2ReadResult();
        ambiguousRead.observedReadEntries = [...read.observedReadEntries];
        required(ambiguousRead.candidates[0], "ambiguous candidate").sourceFileOrigins = [
            { logicalPath: "AGENTS.md", observedReadEntryIds: ["observed-agents-file"] },
            { logicalPath: "AGENTS.md", observedReadEntryIds: ["observed-agents-file"] },
        ];
        const ambiguousReadReview = records.recordRead("connection", probeReview.probeToken, [ambiguousRead]);
        const ambiguousPreview = records.recordPreview(
            "connection",
            ambiguousReadReview.readToken,
            h2PreviewSnapshot(ambiguousRead),
        );
        expect(() =>
            records.resolveImportPreviewFileDirectory("connection", {
                ...reference,
                previewToken: ambiguousPreview.previewToken,
            }),
        ).toThrow(HostReviewRecordUnavailableError);

        const unavailableRead = h2ReadResult();
        unavailableRead.observedReadEntries = [...read.observedReadEntries];
        required(unavailableRead.sourceRoots[0], "source root").accessStatus = "unavailable";
        required(unavailableRead.candidates[0], "unavailable candidate").sourceFileOrigins = [
            { logicalPath: "AGENTS.md", observedReadEntryIds: ["observed-agents-file"] },
        ];
        const unavailableReadReview = records.recordRead("connection", probeReview.probeToken, [unavailableRead]);
        const unavailablePreview = records.recordPreview(
            "connection",
            unavailableReadReview.readToken,
            h2PreviewSnapshot(unavailableRead),
        );
        expect(() =>
            records.resolveImportPreviewFileDirectory("connection", {
                ...reference,
                previewToken: unavailablePreview.previewToken,
            }),
        ).toThrow(HostReviewRecordUnavailableError);
        store.close();
    });
});
