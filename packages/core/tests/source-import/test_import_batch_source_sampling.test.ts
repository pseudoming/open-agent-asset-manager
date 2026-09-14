import * as fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeAdapterReadWithAuthority } from "../../src/source-import/source-contract-validator";
import {
    bootstrapAdapterRegistry,
    clearRegistry,
    disableAdapter,
    enableAdapter,
    revalidateRegisteredReadAuthority,
} from "../../src/orchestration/adapter-registry";
import { createImportService } from "../../src/orchestration/import-service";
import type { AdapterReadResult, ImportAcceptBatchDecision, ImportPreviewSnapshotV1 } from "../../src/types";
import {
    ADAPTER,
    assetsRoot,
    makeServiceConfiguration,
    provider,
    readTarget,
    sourceFile,
    SOURCE_CAPABILITY,
    transactionsRoot,
} from "./fixtures/import-service-test-fixtures";

afterEach(() => clearRegistry());

async function sourceFixture() {
    const selected = provider();
    const readOne = selected.read;
    selected.read = async (input) => {
        const parts = [];
        for (const obligation of input.sourceReadObligations) {
            let executable = false;
            const part = await readOne({
                ...input,
                sourceReadObligations: [obligation],
                readAccess: {
                    ...input.readAccess,
                    readFile: async (handle) => {
                        const result = await input.readAccess.readFile(handle);
                        if (result.state === "succeeded") executable = result.value.entry.executable;
                        return result;
                    },
                },
            });
            const id = obligation.sourceRootId;
            parts.push({
                ...part,
                candidates: part.candidates.map((candidate) => ({
                    ...candidate,
                    candidateId: id,
                    sourceRootIds: [id],
                    displayName: id,
                    files: candidate.files.map((file) => ({ ...file, executable })),
                })),
                sourceParseReports: part.sourceParseReports.map((report) => ({
                    ...report,
                    readEntryDispositions: report.readEntryDispositions.map((disposition) =>
                        disposition.disposition === "ignored"
                            ? disposition
                            : { ...disposition, readEntryDispositionId: id, candidateIds: [id] },
                    ),
                })),
            });
        }
        return {
            candidates: parts.flatMap((part) => part.candidates),
            sourceParseReports: parts.flatMap((part) => part.sourceParseReports),
            diagnostics: [],
        };
    };
    const target = readTarget();
    if (target.sourceSelector.selectorKind !== "probe_roots") throw new Error("probe fixture required");
    const root = target.sourceSelector.observation.sourceRoots[0];
    if (root === undefined) throw new Error("source root required");
    const paths = [sourceFile, `${sourceFile}.two`, `${sourceFile}.three`];
    paths.forEach((path, index) => {
        fs.writeFileSync(path, `# Original ${index}\n`);
    });
    const roots = paths.map((path, index) => ({ ...root, sourceRootId: `root-${index + 1}`, path }));
    target.sourceSelector.observation.sourceRoots = roots;
    target.sourceSelector.sourceRootIds = roots.map((entry) => entry.sourceRootId);
    target.sourceSelector.observation.observedAgentRuntimes[0]!.sourceRootIds = roots.map((entry) => entry.sourceRootId);
    const authority = { managedTargetGuards: [], reservationIdentityFingerprints: [SOURCE_CAPABILITY], transactionsRoot };
    const read = async (): Promise<AdapterReadResult> => {
        const result = await executeAdapterReadWithAuthority(selected, target, authority);
        if (result.status !== "complete") throw new Error(JSON.stringify(result.diagnostics));
        return result.value;
    };
    expect(bootstrapAdapterRegistry([selected]).status).toBe("complete");
    expect(enableAdapter(ADAPTER).status).toBe("complete");
    const initial = await read();
    return { initial, read, paths, authority };
}

function decisions(preview: ImportPreviewSnapshotV1, count = preview.items.length): ImportAcceptBatchDecision[] {
    return preview.items.slice(0, count).map((item) => ({
        candidateId: item.candidateId,
        action: "create_asset",
        freshness: { freshnessAction: "require_current_source" },
        promotion: { promotionAction: "import_only", userActionId: "batch-import" },
        callableBindings: [],
    }));
}

describe("Core import batch source sampling", () => {
    it("samples one complete source once, saves consistent bytes after a mid-batch edit, and samples again on the next call", async () => {
        const fixture = await sourceFixture();
        const refresh = vi.fn(fixture.read);
        let publications = 0;
        const configuration = makeServiceConfiguration(refresh, {
            validateReadAuthority: (read) => revalidateRegisteredReadAuthority(read, fixture.authority),
            reindexImportedAsset: () => {
                if (++publications === 1) {
                    fixture.paths.forEach((path) => {
                        fs.writeFileSync(path, "# Later external edit\n");
                    });
                }
                return {
                    status: "complete",
                    value: { scannedAssets: 1, indexedAssets: 1, skippedAssets: 0, diagnostics: [] },
                    diagnostics: [],
                };
            },
        });
        const service = createImportService(configuration);
        const preview = service.previewImport([fixture.initial]).value;
        const result = await service.acceptImportBatch({ previewSnapshot: preview, decisions: decisions(preview, 2) });
        expect(result.status).toBe("complete");
        expect(result.value.items.map((item) => item.status)).toEqual(["complete", "complete"]);
        expect(refresh).toHaveBeenCalledTimes(1);
        for (const item of result.value.items) {
            if (item.status !== "complete") throw new Error("publication required");
            const manifest = JSON.parse(
                fs.readFileSync(`${assetsRoot}/${item.version.assetId}/versions/${item.version.versionId}/version.json`, "utf8"),
            );
            const candidate = fixture.initial.candidates.find((entry) => entry.candidateId === item.candidateId)!;
            const sourceEntry = fixture.initial.observedReadEntries.find((entry) =>
                candidate.sourceRootIds.includes(entry.sourceRootId),
            );
            expect(manifest.files[0].contentHash).toBe(sourceEntry?.entryKind === "file" ? sourceEntry.contentHash : undefined);
        }
        const nextPreview = service.previewImport([fixture.initial]).value;
        const remaining = nextPreview.items.find((item) => item.action === "create_asset");
        if (remaining === undefined) throw new Error("third unpublished candidate required");
        const next = await service.acceptImportBatch({
            previewSnapshot: nextPreview,
            decisions: decisions(nextPreview).filter((decision) => decision.candidateId === remaining.candidateId),
        });
        expect(next.value.items).toMatchObject([{ status: "failed", diagnostics: [{ code: "import.source_changed" }] }]);
        expect(refresh).toHaveBeenCalledTimes(2);
    });

    it.each([
        "content",
        "executable",
    ] as const)("rejects a %s change before the first batch sample without publishing", async (change) => {
        const fixture = await sourceFixture();
        const refresh = vi.fn(fixture.read);
        const service = createImportService(makeServiceConfiguration(refresh));
        const preview = service.previewImport([fixture.initial]).value;
        if (change === "content") fs.writeFileSync(fixture.paths[0]!, "# Changed before batch\n");
        else fs.chmodSync(fixture.paths[0]!, 0o755);
        const result = await service.acceptImportBatch({ previewSnapshot: preview, decisions: decisions(preview) });
        expect(
            result.value.items.every(
                (item) => item.status === "failed" && item.diagnostics.some((entry) => entry.code === "import.source_changed"),
            ),
        ).toBe(true);
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(fs.existsSync(assetsRoot) ? fs.readdirSync(assetsRoot) : []).toEqual([]);
    });

    it("keeps concurrent batches and a later single accept independent", async () => {
        const fixture = await sourceFixture();
        const refresh = vi.fn(fixture.read);
        const service = createImportService(makeServiceConfiguration(refresh));
        const preview = service.previewImport([fixture.initial]).value;
        const selected = decisions(preview);
        const results = await Promise.all(
            selected
                .slice(0, 2)
                .map((decision) => service.acceptImportBatch({ previewSnapshot: preview, decisions: [decision] })),
        );
        expect(results.map((result) => result.value.items[0]?.status)).toEqual(["complete", "complete"]);
        expect(refresh).toHaveBeenCalledTimes(2);
        const nextPreview = service.previewImport([fixture.initial]).value;
        const single = await service.acceptImport({ previewSnapshot: nextPreview, decision: selected[2]! });
        expect(single.status).toBe("complete");
        expect(refresh).toHaveBeenCalledTimes(3);
    });

    it("does not use explicit old-snapshot consent to bypass another candidate's fresh source check", async () => {
        const fixture = await sourceFixture();
        const refresh = vi.fn(fixture.read);
        const service = createImportService(
            makeServiceConfiguration(refresh, {
                reindexImportedAsset: () => {
                    fs.writeFileSync(fixture.paths[0]!, "# Changed after old-snapshot import\n");
                    return {
                        status: "complete",
                        value: { scannedAssets: 1, indexedAssets: 1, skippedAssets: 0, diagnostics: [] },
                        diagnostics: [],
                    };
                },
            }),
        );
        const preview = service.previewImport([fixture.initial]).value;
        const selected = decisions(preview, 2);
        selected[0] = {
            ...selected[0]!,
            freshness: { freshnessAction: "accept_preview_snapshot", userActionId: "use-exact-old-material" },
        };
        const result = await service.acceptImportBatch({ previewSnapshot: preview, decisions: selected });
        expect(result.value.items.map((item) => item.status)).toEqual(["complete", "failed"]);
        expect(result.value.items[1]?.diagnostics[0]?.code).toBe("import.source_changed");
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it.each([
        "provider_disabled",
        "reservation_added",
        "registry_cleared",
    ] as const)("rechecks %s before each publication while retaining an earlier success", async (change) => {
        const fixture = await sourceFixture();
        const refresh = vi.fn(fixture.read);
        let publications = 0;
        const service = createImportService(
            makeServiceConfiguration(refresh, {
                validateReadAuthority: (read) => revalidateRegisteredReadAuthority(read, fixture.authority),
                reindexImportedAsset: () => {
                    if (++publications === 1) {
                        if (change === "provider_disabled") disableAdapter(ADAPTER);
                        else if (change === "registry_cleared") clearRegistry();
                        else fixture.authority.reservationIdentityFingerprints.push(`sha256:${"2".repeat(64)}`);
                    }
                    return {
                        status: "complete",
                        value: { scannedAssets: 1, indexedAssets: 1, skippedAssets: 0, diagnostics: [] },
                        diagnostics: [],
                    };
                },
            }),
        );
        const preview = service.previewImport([fixture.initial]).value;
        const result = await service.acceptImportBatch({ previewSnapshot: preview, decisions: decisions(preview) });
        expect(result.value.items.map((item) => item.status)).toEqual(["complete", "failed", "failed"]);
        expect(
            result.value.items
                .slice(1)
                .every((item) => item.diagnostics.some((entry) => entry.code === "import.source_authority_changed")),
        ).toBe(true);
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(publications).toBe(1);
    });
});
