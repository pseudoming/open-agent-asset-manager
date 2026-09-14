import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sha256SourceBytes } from "@oaam/adapter-framework";
import type { AdapterReadTarget, PlatformContext, SourceRoot, UuidV4 } from "@oaam/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readVersionAuthority } from "../../../core/src/catalog/version-authority";
import {
    clearRegistry,
    disableAdapter,
    enableAdapter,
    freezeRegistry,
    getRegisteredVersionDialectRegistry,
    registerAdapterProvider,
} from "../../../core/src/orchestration/adapter-registry";
import { executeAdapterReadWithAuthority } from "../../../core/src/source-import/source-read-execution";
import { bindAcceptFixtureCandidate, bindFixtureImportService, fixtureSourceRoot } from "../../../test-support";
import { cursorProvider } from "../src/cursor-provider";
import { CURSOR_MEMORY_SNAPSHOT_NATIVE_PATH, createCursorMemoryReadonlySnapshot } from "../src/cursor-source-read-memory";

const PROJECT_ID = "00000000-0000-4000-8000-000000000259" as UuidV4;
const TITLE = "Cursor readonly Memory";
const BODY = "Preserve the exact Cursor remote-read snapshot and its project authority.\n";
const LIVE_SNAPSHOT_PATH = process.env.OAAM_CURSOR_MEMORY_LIVE_SNAPSHOT_PATH;
const LIVE_PROJECT_ROOT = process.env.OAAM_CURSOR_MEMORY_LIVE_PROJECT_ROOT;
const LIVE_RESULT_PATH = process.env.OAAM_CURSOR_MEMORY_LIVE_RESULT_PATH;
const acceptCandidate = bindAcceptFixtureCandidate("cursor-memory-core-conformance");

let sandbox = "";
let project = "";
let snapshotPath = "";
let transactions = "";
let assets = "";
let oaam = "";
let locks = "";

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-cursor-memory-conformance-"));
    project = path.join(sandbox, "project");
    snapshotPath = path.join(sandbox, CURSOR_MEMORY_SNAPSHOT_NATIVE_PATH);
    transactions = path.join(sandbox, "transactions");
    assets = path.join(sandbox, "assets");
    oaam = path.join(sandbox, "oaam");
    locks = path.join(sandbox, "locks");
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(transactions, { recursive: true });
    fs.writeFileSync(snapshotPath, snapshotBytes());
    clearRegistry();
});

afterEach(() => {
    clearRegistry();
    fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("Cursor App Memory Core import conformance", () => {
    it("imports one selected frozen snapshot and reopens its exact native bytes after Provider disable", async () => {
        await assertImportConformance(TITLE, BODY, snapshotBytes(), false);
    });

    it.skipIf(LIVE_SNAPSHOT_PATH === undefined || LIVE_PROJECT_ROOT === undefined)(
        "imports the exact installed-proof snapshot and reopens its native bytes",
        async () => {
            if (LIVE_SNAPSHOT_PATH === undefined || LIVE_PROJECT_ROOT === undefined) {
                throw new Error("live Cursor Memory paths missing");
            }
            snapshotPath = LIVE_SNAPSHOT_PATH;
            project = LIVE_PROJECT_ROOT;
            const sourceBytes = fs.readFileSync(snapshotPath);
            const snapshotBefore = exactFileIdentity(snapshotPath);
            const projectBefore = exactDirectoryInventory(project);
            const snapshot = JSON.parse(sourceBytes.toString("utf8")) as {
                item?: { title?: unknown; knowledge?: unknown };
            };
            if (typeof snapshot.item?.title !== "string" || typeof snapshot.item.knowledge !== "string") {
                throw new Error("live Cursor Memory snapshot item is malformed");
            }
            await assertImportConformance(snapshot.item.title, snapshot.item.knowledge, sourceBytes, true);
            expect(exactFileIdentity(snapshotPath)).toEqual(snapshotBefore);
            expect(exactDirectoryInventory(project)).toEqual(projectBefore);
        },
    );
});

async function assertImportConformance(
    title: string,
    body: string,
    expectedNativeBytes: Buffer,
    writeLiveReceipt: boolean,
): Promise<void> {
    const root = snapshotRoot();
    const target = readTarget(root);
    const readAgain = async () => {
        const result = await executeAdapterReadWithAuthority(cursorProvider, target, {
            managedTargetGuards: [],
            reservationIdentityFingerprints: [],
            transactionsRoot: transactions,
        });
        if (result.status !== "complete") throw new Error(JSON.stringify(result.diagnostics, null, 2));
        return result.value;
    };
    const read = await readAgain();
    expect(read.candidates).toEqual([
        expect.objectContaining({
            kind: "Memory",
            scope: "project",
            projectRootPath: project,
            displayName: title,
            status: "complete",
            nativeRepresentation: expect.objectContaining({
                dialectId: "cursor-app-remote-memory-readonly-snapshot-v1",
            }),
        }),
    ]);

    const service = bindFixtureImportService({
        provider: cursorProvider,
        assetsRoot: () => assets,
        oaamRoot: () => oaam,
        authorityLocksRoot: () => locks,
        projectRootPath: () => project,
        projectId: PROJECT_ID,
    })(readAgain);
    const candidate = read.candidates[0];
    if (candidate === undefined) throw new Error("missing Cursor Memory candidate");
    const accepted = await acceptCandidate(service, read, candidate.candidateId);
    expect(accepted.status, JSON.stringify(accepted.diagnostics, null, 2)).toBe("complete");

    expect(registerAdapterProvider(cursorProvider).status).toBe("complete");
    expect(enableAdapter("CURSOR").status).toBe("complete");
    expect(freezeRegistry().status).toBe("complete");
    expect(disableAdapter("CURSOR").status).toBe("complete");
    const closure = readVersionAuthority(
        assets,
        accepted.value.assetId,
        accepted.value.versionId,
        getRegisteredVersionDialectRegistry(),
    );
    expect(closure?.manifest).toMatchObject({
        kind: "Memory",
        typeData: { entityRole: "unit", card: { name: title } },
    });
    expect(closure?.files).toEqual([
        expect.objectContaining({ file: expect.objectContaining({ logicalPath: "memory.md" }), text: body }),
    ]);
    expect(closure?.manifest.nativeRepresentations).toEqual([
        expect.objectContaining({
            dialectId: "cursor-app-remote-memory-readonly-snapshot-v1",
            files: [expect.objectContaining({ relativePath: CURSOR_MEMORY_SNAPSHOT_NATIVE_PATH })],
        }),
    ]);
    expect(closure?.nativePayloads[0]?.files).toEqual([
        expect.objectContaining({ relativePath: CURSOR_MEMORY_SNAPSHOT_NATIVE_PATH, bytes: expectedNativeBytes }),
    ]);
    if (writeLiveReceipt) {
        if (LIVE_RESULT_PATH === undefined || LIVE_SNAPSHOT_PATH === undefined || LIVE_PROJECT_ROOT === undefined) {
            throw new Error("live Cursor Memory receipt path missing");
        }
        if (!path.isAbsolute(LIVE_RESULT_PATH) || path.dirname(LIVE_RESULT_PATH) !== path.dirname(snapshotPath)) {
            throw new Error("live Cursor Memory receipt must be a sibling of the exact snapshot");
        }
        fs.writeFileSync(
            LIVE_RESULT_PATH,
            `${JSON.stringify(
                {
                    schemaVersion: 1,
                    proofKind: "cursor_memory_live_source_import_native_reopen",
                    status: "complete",
                    sourceSnapshotPath: snapshotPath,
                    sourceSnapshotSha256: sha256SourceBytes(expectedNativeBytes),
                    projectRootPath: project,
                    projectRootMatchesSelectedFixture: project === LIVE_PROJECT_ROOT,
                    titleSha256: sha256SourceBytes(Buffer.from(title)),
                    candidateId: candidate.candidateId,
                    assetId: accepted.value.assetId,
                    versionId: accepted.value.versionId,
                    providerDisabledBeforeReopen: true,
                    nativeReopenValidated: closure !== null,
                    nativePayloadSha256: sha256SourceBytes(expectedNativeBytes),
                    remoteMutationPerformed: false,
                },
                null,
                2,
            )}\n`,
            { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
    }
}

function snapshotBytes(): Buffer {
    return Buffer.from(
        `${JSON.stringify(
            createCursorMemoryReadonlySnapshot({
                projectGitOrigin: "https://example.invalid/oaam-cursor-memory-core.git",
                capturedAt: "2026-08-10T01:00:00.000Z",
                item: {
                    id: "kb_cursor_core_exact",
                    title: TITLE,
                    knowledge: BODY,
                    createdAt: "2026-08-10T00:59:00.000Z",
                    isGenerated: false,
                },
            }),
            null,
            2,
        )}\n`,
    );
}

function snapshotRoot(): SourceRoot {
    return fixtureSourceRoot({
        sourceRootId: "cursor-memory-readonly-snapshot",
        path: snapshotPath,
        rootRole: "source",
        sourceDomain: "external_managed",
        locatorKind: "user_provided_path",
        locatorKey: "cursor_memory_readonly_snapshot",
        evidenceLevel: "user_provided",
    });
}

function readTarget(root: SourceRoot): AdapterReadTarget {
    const platformContext: PlatformContext = {
        platform: "linux",
        platformInstanceId: "cursor-memory-conformance",
        accessRootPath: commonAncestorPath(path.dirname(snapshotPath), project),
    };
    return {
        adapterId: "CURSOR",
        allowedKinds: ["Memory"],
        sourceSelector: {
            selectorKind: "user_selected_root",
            platformContext,
            binding: { sourceRoot: root, assetScope: "project", projectRootPath: project },
        },
    };
}

function commonAncestorPath(firstPath: string, secondPath: string): string {
    let ancestor = path.resolve(firstPath);
    const second = path.resolve(secondPath);
    while (second !== ancestor && !second.startsWith(`${ancestor}${path.sep}`)) {
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw new Error("Cursor Memory proof paths have no bounded common authority root");
        ancestor = parent;
    }
    if (ancestor === path.parse(ancestor).root) {
        throw new Error("Cursor Memory proof common authority root is too broad");
    }
    return ancestor;
}

function exactFileIdentity(filePath: string): Record<string, string> {
    const link = fs.lstatSync(filePath, { bigint: true });
    if (!link.isFile() || link.isSymbolicLink()) throw new Error(`non-regular live proof file: ${filePath}`);
    const stat = fs.statSync(filePath, { bigint: true });
    return {
        realPath: fs.realpathSync(filePath),
        device: stat.dev.toString(),
        inode: stat.ino.toString(),
        size: stat.size.toString(),
        mtimeNanoseconds: stat.mtimeNs.toString(),
        sha256: sha256SourceBytes(fs.readFileSync(filePath)),
    };
}

function exactDirectoryInventory(rootPath: string): Array<Record<string, string>> {
    const rows: Array<Record<string, string>> = [];
    const visit = (directoryPath: string, prefix: string): void => {
        const directory = fs.lstatSync(directoryPath);
        if (!directory.isDirectory() || directory.isSymbolicLink()) {
            throw new Error(`non-directory live proof boundary: ${directoryPath}`);
        }
        for (const name of fs.readdirSync(directoryPath).sort()) {
            const entryPath = path.join(directoryPath, name);
            const relativePath = prefix === "" ? name : `${prefix}/${name}`;
            const entry = fs.lstatSync(entryPath);
            if (entry.isSymbolicLink()) throw new Error(`symlink in live proof Project: ${relativePath}`);
            if (entry.isDirectory()) {
                rows.push({ relativePath, kind: "directory" });
                visit(entryPath, relativePath);
            } else {
                rows.push({ relativePath, kind: "file", ...exactFileIdentity(entryPath) });
            }
        }
    };
    visit(rootPath, "");
    return rows;
}
