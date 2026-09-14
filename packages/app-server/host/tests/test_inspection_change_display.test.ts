import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AttributedSemanticChange, RenderedFileAttributionResult } from "@oaam/core";
import { afterEach, describe, expect, it } from "vitest";
import { inspectionChangeDisplayName } from "../src/inspection-change-display";
import { HostReviewRecordStore } from "../src/review-record-store";
import { HostReviewRecords } from "../src/review-records";
import { h2Inspection } from "./support/h2-review-fixtures";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function change(key: string, text: string): AttributedSemanticChange {
    return {
        changeKind: "file_content_replacement",
        changeFingerprint: key.repeat(64) as never,
        semanticRefFingerprints: [],
        replacementContent: { contentKind: "text", text },
    };
}
function file(name: string, changes: readonly AttributedSemanticChange[]): RenderedFileAttributionResult {
    return {
        relativePath: name as never,
        attributionState: "uniquely_attributable",
        changeFingerprints: changes.map((item) => item.changeFingerprint),
        hunkAttributions: [],
        diagnostics: [],
    };
}

describe("Inspection content detail names", () => {
    it("binds reordered change labels and detail content to their actual file fingerprints", () => {
        const a = change("a", "alpha payload"),
            b = change("b", "beta payload");
        const result = { ...h2Inspection(), files: [file("a.md", [a]), file("b.md", [b])], changes: [b, a] };
        const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-inspection-label-"));
        roots.push(rootPath);
        const store = new HostReviewRecordStore({ rootPath, createToken: () => "inspection-token" });
        let member = 0;
        const records = new HostReviewRecords(store, () => `member-${++member}`);
        try {
            const review = records.recordInspection("connection", "deployment", result);
            const details = review.details.filter((detail) => detail.detailKind === "semantic_change");
            expect(details.map((detail) => detail.displayName)).toEqual(["b.md", "a.md"]);
            expect(details.map((detail) => records.inspectionDetail(review.inspectionToken, detail.selector))).toEqual([
                expect.objectContaining({
                    content: expect.objectContaining({ text: expect.objectContaining({ text: "beta payload" }) }),
                }),
                expect.objectContaining({
                    content: expect.objectContaining({ text: expect.objectContaining({ text: "alpha payload" }) }),
                }),
            ]);
            expect(records.resolveInspection(review.inspectionToken, "deployment", review.inspectionResultFingerprint)).toEqual(
                result,
            );
        } finally {
            store.close();
        }
    });

    it("retains a truthful kind when attribution is absent, conflicted or spans several files", () => {
        const a = change("a", "alpha"),
            b = change("b", "beta");
        expect(inspectionChangeDisplayName(a, [])).toBe(a.changeKind);
        expect(inspectionChangeDisplayName(a, [file("other.md", [b])])).toBe(a.changeKind);
        expect(inspectionChangeDisplayName(a, h2Inspection().files)).toBe(a.changeKind);
        expect(inspectionChangeDisplayName(a, [file("a.md", [a]), file("b.md", [a])])).toBe(a.changeKind);
        expect(inspectionChangeDisplayName(a, [file("a.md", [a]), file("a.md", [a])])).toBe("a.md");
    });
});
