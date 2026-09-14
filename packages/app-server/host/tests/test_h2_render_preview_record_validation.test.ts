import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostReviewRecordStore } from "../src/review-record-store";
import { HostReviewRecords, HostReviewRecordUnavailableError } from "../src/review-records";
import { H2_DIGEST, h2RenderPreview } from "./support/h2-review-fixtures";

const temporaryRoots: string[] = [];

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe("Host render-preview review-record validation", () => {
    it("rejects stale or malformed graphs at publication and review-record reopen", () => {
        const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-host-render-review-"));
        temporaryRoots.push(rootPath);
        let recordNumber = 0;
        const store = new HostReviewRecordStore({
            rootPath,
            createToken: () => `review-${++recordNumber}`,
        });
        const records = new HostReviewRecords(store, () => "member");
        const selection = { schemaVersion: 1 as const, renderInputFingerprint: H2_DIGEST, semanticOptions: [] };
        const preview = h2RenderPreview();
        expect(() => records.recordRenderPreview("connection", preview.deploymentId, selection, null as never)).toThrow(
            /strict public projection contract/u,
        );
        const nonRecordToken = store.put({
            kind: "render_preview",
            ownerConnectionId: "connection",
            replacementKey: "malformed-non-record",
            payload: {
                recordKind: "render_preview",
                deploymentId: preview.deploymentId,
                selectionRequest: selection,
                preview: null,
                previewFingerprint: preview.previewFingerprint,
                approvalResolutions: [],
            },
        });
        expect(() => records.resolveRenderPreview(nonRecordToken)).toThrow(HostReviewRecordUnavailableError);
        for (const malformedPreview of [
            { ...preview, schemaVersion: 1 },
            { ...preview, schemaVersion: 2 },
            Object.fromEntries(Object.entries(preview).filter(([key]) => key !== "replacementScope")),
            Object.fromEntries(Object.entries(preview).filter(([key]) => key !== "directories")),
            {
                ...preview,
                directories: [
                    {
                        managedBoundaryRelativePath: "skill",
                        relativePath: "",
                        baselineState: "managed",
                        changeKind: "unchanged",
                        currentState: "present",
                        desiredState: "present",
                    },
                ],
            },
        ]) {
            expect(() =>
                records.recordRenderPreview("connection", preview.deploymentId, selection, malformedPreview as never),
            ).toThrow(/strict public projection contract/u);

            const token = store.put({
                kind: "render_preview",
                ownerConnectionId: "connection",
                replacementKey: `malformed-${String(malformedPreview.schemaVersion ?? "missing")}`,
                payload: {
                    recordKind: "render_preview",
                    deploymentId: preview.deploymentId,
                    selectionRequest: selection,
                    preview: malformedPreview,
                    previewFingerprint: preview.previewFingerprint,
                    approvalResolutions: [],
                },
            });
            expect(() => records.resolveRenderPreview(token)).toThrow(HostReviewRecordUnavailableError);
        }
        store.close();
    });
});
