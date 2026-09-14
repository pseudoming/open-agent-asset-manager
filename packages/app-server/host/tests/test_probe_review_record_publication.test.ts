import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HostReviewRecordStore } from "../src/review-record-store";
import { HostReviewRecords } from "../src/review-records";
import { h2ProbeResult } from "./support/h2-review-fixtures";
import { required } from "./support/host-test-fixtures";

describe("Host probe review publication", () => {
    it("uses the just-published typed payload for its operation snapshot and reads durable bytes on first resolution", () => {
        const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-host-probe-publication-"));
        let recordNumber = 0;
        let memberNumber = 0;
        const store = new HostReviewRecordStore({
            rootPath,
            createToken: () => `review-${++recordNumber}`,
        });
        try {
            const readback = vi.spyOn(store, "get");
            const records = new HostReviewRecords(store, () => `member-${++memberNumber}`);
            const probe = h2ProbeResult();
            const review = records.recordProbe("connection", [probe]);
            const resultRow = required(review.results[0], "probe result row");

            expect(readback).not.toHaveBeenCalled();
            expect(records.resolveProbeResult(review.probeToken, resultRow.rowId)).toEqual(probe);
            expect(readback).toHaveBeenCalledTimes(1);
        } finally {
            store.close();
            fs.rmSync(rootPath, { force: true, recursive: true });
        }
    });
});
