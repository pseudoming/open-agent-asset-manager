/** Complete folder import retains directory authority without consulting the source after acceptance. */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeAdapterReadWithAuthority } from "../../packages/core/src/source-import/source-read-execution";
import { antigravityProvider } from "../../packages/adapter/providers/antigravity/src/antigravity-provider";
import { claudecodeProvider } from "../../packages/adapter/providers/claudecode/src/claudecode-provider";
import { codexProvider } from "../../packages/adapter/providers/codex/src/codex-provider";
import { cursorProvider } from "../../packages/adapter/providers/cursor/src/cursor-provider";
import { opencodeProvider } from "../../packages/adapter/providers/opencode/src/opencode-provider";
import {
    acceptFixtureCandidate,
    authoritativeFixtureRead,
    bindDialectRegistry,
    fixtureImportService,
    fixtureProbeRootTarget,
    fixtureSourceRoot,
} from "../../packages/adapter/test-support";
import { writeProjectManifest } from "../../packages/core/src/catalog/project-authority";
import { readVersionAuthority } from "../../packages/core/src/catalog/version-authority";
import {
    computeVersionFingerprint,
    computeVersionNativeRepresentationFingerprint,
} from "../../packages/core/src/foundation/fingerprint";
import { buildAndVerifyNativeAssetVersionArchive } from "../../packages/core/src/orchestration/asset-version-native-archive";
import { createCoreAssetService } from "../../packages/core/src/orchestration/core-asset-service";
import { closeDb, getDb } from "../../packages/core/src/persistence/db";
import type { AdapterReadTarget, NativeDialectValidationInputV1, UuidV4 } from "../../packages/core/src/types";

const PROJECT_ID = "00000000-0000-4000-8000-000000000901" as UuidV4;
const ENTRY = "---\nname: sample\ndescription: Complete directory\n---\nKeep every owned resource.\n";
const SCRIPT = "#!/bin/sh\nprintf 'owned resource\\n'\n";
const BINARY = Uint8Array.of(0, 255, 1, 2);
const CASES = [
    {
        name: "Claude Code project",
        provider: claudecodeProvider,
        agentRuntimeId: "CLAUDE_CODE_CLI",
        scope: "project",
        base: ".claude/skills",
    },
    {
        name: "Claude Code config",
        provider: claudecodeProvider,
        agentRuntimeId: "CLAUDE_CODE_CLI",
        scope: "global",
        base: "skills",
    },
    {
        name: "Antigravity project",
        provider: antigravityProvider,
        agentRuntimeId: "ANTIGRAVITY_CLI",
        scope: "project",
        base: ".agents/skills",
    },
    {
        name: "Antigravity config",
        provider: antigravityProvider,
        agentRuntimeId: "ANTIGRAVITY_CLI",
        scope: "global",
        base: "config/skills",
    },
    { name: "Codex project", provider: codexProvider, agentRuntimeId: "CODEX_CLI", scope: "project", base: ".agents/skills" },
    { name: "Codex shared", provider: codexProvider, agentRuntimeId: "CODEX_CLI", scope: "global", base: "" },
    {
        name: "Cursor project",
        provider: cursorProvider,
        agentRuntimeId: "CURSOR_AGENT_CLI",
        scope: "project",
        base: ".cursor/skills",
    },
    { name: "Cursor config", provider: cursorProvider, agentRuntimeId: "CURSOR_AGENT_CLI", scope: "global", base: "skills" },
    {
        name: "OpenCode project",
        provider: opencodeProvider,
        agentRuntimeId: "OPENCODE_CLI",
        scope: "project",
        base: ".opencode/skills",
    },
    { name: "OpenCode config", provider: opencodeProvider, agentRuntimeId: "OPENCODE_CLI", scope: "global", base: "skills" },
    {
        name: "OpenCode shared root entry",
        provider: opencodeProvider,
        agentRuntimeId: "OPENCODE_CLI",
        scope: "global",
        base: "",
        rootEntry: true,
    },
    {
        name: "OpenCode external root entry",
        provider: opencodeProvider,
        agentRuntimeId: "OPENCODE_CLI",
        scope: "global",
        base: "",
        rootEntry: true,
        externalRoot: true,
    },
] as const;

let sandbox = "";
beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-skill-directory-authority-"));
    closeDb();
});
afterEach(() => {
    closeDb();
    fs.rmSync(sandbox, { recursive: true, force: true });
});

describe.each(CASES)("$name directory authority", (spec) => {
    it("imports, reopens, copies and exports nested empty directories after the source leaf is removed", async () => {
        const fixture = createFixture(spec);
        const read = await fixture.readAgain();
        const candidate = read.candidates.find((item) => item.displayName === "sample");
        if (candidate === undefined) throw new Error("Skill candidate is missing");
        const accepted = await fixture.accept(read, candidate.candidateId);
        expect(accepted.status, JSON.stringify(accepted.diagnostics)).toBe("complete");
        const original = fixture.reopen(accepted.value.assetId, accepted.value.versionId);
        expect(original.manifest.nativeRepresentations[0]).toMatchObject({
            schemaVersion: 2,
            directories: fixture.directories,
        });
        expect(candidate.nativeRepresentation).toMatchObject({
            representationSource: "separate_file_graph",
            directories: fixture.directories.map((relativePath) => ({ relativePath })),
        });
        const origins = new Map(read.observedReadEntries.map((entry) => [entry.observedReadEntryId, entry.relativePath]));
        expect([...new Set(candidate.sourceContainerEntryIds.map((id) => origins.get(id)))].sort()).toEqual(
            fixture.containerPaths,
        );
        expect(original.manifest.nativeRepresentations[0]?.files.map((file) => file.relativePath)).toEqual(fixture.files);
        expect(original.nativePayloads[0]?.files.map((file) => [...file.bytes])).toEqual([
            [...Buffer.from(ENTRY)],
            [...BINARY],
            [...Buffer.from(SCRIPT)],
        ]);

        fs.rmSync(path.join(fixture.sourceRoot.path, fixture.leaf), { recursive: true });
        const reopened = fixture.reopen(accepted.value.assetId, accepted.value.versionId);
        expect(reopened).toEqual(original);
        const assets = createCoreAssetService({
            assetsRoot: fixture.assetsRoot,
            projectsRoot: fixture.projectsRoot,
            authorityLocksRoot: fixture.locksRoot,
            db: getDb(path.join(sandbox, "state.sqlite")),
            dialectRegistry: fixture.registry,
            assertMutationScope: () => undefined,
            now: () => 2_000,
            newUuid: () => crypto.randomUUID(),
        });
        const copied = assets.copyAssetVersionToLocation({
            source: {
                assetId: original.manifest.assetId,
                versionId: original.manifest.versionId,
                versionFingerprint: original.manifest.fingerprint,
                originAuthorityFingerprint: original.manifest.originAuthority.authorityFingerprint,
            },
            destination:
                spec.scope === "project"
                    ? { scope: "global", projectId: "", scopePath: "" }
                    : { scope: "project", projectId: PROJECT_ID, scopePath: "" },
            displayName: "Copied directory Skill",
            displayDescription: "",
            userActionEvidenceId: "copy-owned-directory-skill",
        });
        expect(copied.status, JSON.stringify(copied.diagnostics)).toBe("complete");
        const copy = fixture.reopen(copied.value.asset.assetId, copied.value.version.versionId);
        expect(copy.manifest.nativeRepresentations).toEqual(original.manifest.nativeRepresentations);
        expect(copy.nativePayloads).toEqual(original.nativePayloads);
        expect(fixture.reopen(original.manifest.assetId, original.manifest.versionId)).toEqual(original);

        const archive = await buildAndVerifyNativeAssetVersionArchive({
            representation: copy.manifest.nativeRepresentations[0]!,
            payload: copy.nativePayloads[0]!,
            exportedAt: 2_000,
        });
        const zip = new ZipReader(new Uint8ArrayReader(archive.bytes), { useWebWorkers: false, strictness: "strict" });
        try {
            const entries = await zip.getEntries({ strictness: "strict" });
            expect(
                entries
                    .filter((entry) => entry.directory)
                    .map((entry) => entry.filename)
                    .sort(),
            ).toEqual(fixture.directories.map((directory) => `${directory}/`));
            expect(
                entries
                    .filter((entry) => !entry.directory)
                    .map((entry) => entry.filename)
                    .sort(),
            ).toEqual(fixture.files);
            const script = entries.find((entry) => entry.filename.endsWith("/check.sh"));
            if (script === undefined || script.directory) throw new Error("Executable file is missing from native ZIP");
            expect(script.unixMode).toBe(0o100755);
            expect(await script.getData?.(new Uint8ArrayWriter(), { useWebWorkers: false })).toEqual(
                new Uint8Array(Buffer.from(SCRIPT)),
            );
            const binary = entries.find((entry) => entry.filename.endsWith("/marker.bin"));
            if (binary === undefined || binary.directory) throw new Error("Binary file is missing from native ZIP");
            expect(await binary.getData?.(new Uint8ArrayWriter(), { useWebWorkers: false })).toEqual(BINARY);
        } finally {
            await zip.close();
        }
    });

    it.each(["add", "remove"] as const)("rejects stale acceptance when only an empty directory is %s", async (change) => {
        const fixture = createFixture(spec);
        const read = await fixture.readAgain();
        const candidate = read.candidates.find((item) => item.displayName === "sample");
        if (candidate === undefined) throw new Error("Skill candidate is missing");
        const directory = path.join(fixture.sourceRoot.path, fixture.leaf, "empty", change === "add" ? "new" : "nested");
        if (change === "add") fs.mkdirSync(directory);
        else fs.rmdirSync(directory);
        const accepted = await fixture.accept(read, candidate.candidateId);
        expect(accepted.status).toBe("failed");
        expect(accepted.diagnostics.map((diagnostic) => diagnostic.code)).toContain("import.source_changed");
        expect(fs.existsSync(fixture.assetsRoot) ? fs.readdirSync(fixture.assetsRoot) : []).toEqual([]);
    });

    it("keeps historical v1 content validation and validates the complete v2 carrier without changing the dialect", async () => {
        const fixture = createFixture(spec);
        const read = await fixture.readAgain();
        const candidate = read.candidates.find((item) => item.displayName === "sample");
        if (candidate === undefined) throw new Error("Skill candidate is missing");
        const accepted = await fixture.accept(read, candidate.candidateId);
        expect(accepted.status, JSON.stringify(accepted.diagnostics)).toBe("complete");
        const closure = fixture.reopen(accepted.value.assetId, accepted.value.versionId);
        const native = closure.manifest.nativeRepresentations[0]!;
        const contract = fixture.registry.getNative("Skill", native.dialectId);
        if (contract === null || closure.manifest.kind !== "Skill") throw new Error("Skill dialect is missing");
        const fileEnvelope = {
            schemaVersion: 1 as const,
            dialectId: native.dialectId,
            dialectContractFingerprint: native.dialectContractFingerprint,
            canonicalContentFingerprint: native.canonicalContentFingerprint,
            files: native.files,
        };
        const directoryEnvelope = { ...fileEnvelope, schemaVersion: 2 as const, directories: fixture.directories };
        const legacy = {
            ...fileEnvelope,
            representationFingerprint: computeVersionNativeRepresentationFingerprint(fileEnvelope),
        };
        for (const envelope of [
            legacy,
            { ...directoryEnvelope, representationFingerprint: computeVersionNativeRepresentationFingerprint(directoryEnvelope) },
        ]) {
            const input: NativeDialectValidationInputV1 = {
                representation: envelope,
                canonical: { kind: "Skill", typeData: closure.manifest.typeData },
                canonicalFiles: closure.files,
                nativeFiles: closure.nativePayloads[0]!.files,
            };
            expect(contract.validateSameContent(input)).toBe(true);
            const badBytes = structuredClone(input);
            badBytes.nativeFiles[0]!.bytes = Uint8Array.of(1, 2, 3);
            expect(contract.validateSameContent(badBytes)).toBe(false);
            const badCanonical = structuredClone(input);
            if (badCanonical.canonical.kind !== "Skill") throw new Error("Unexpected fixture kind");
            badCanonical.canonical.typeData.name = "different";
            expect(contract.validateSameContent(badCanonical)).toBe(false);
            expect(contract.validateSameContent({ ...input, nativeFiles: [] })).toBe(false);
            if (input.representation.schemaVersion === 2 && !fixture.containerPaths.includes("")) {
                const outsideDirectory = structuredClone(input);
                if (outsideDirectory.representation.schemaVersion !== 2) throw new Error("directory carrier required");
                const { representationFingerprint: _fingerprint, ...envelope } = outsideDirectory.representation;
                const withOutside = { ...envelope, directories: [...envelope.directories, "unowned-directory"].sort() };
                outsideDirectory.representation = {
                    ...withOutside,
                    representationFingerprint: computeVersionNativeRepresentationFingerprint(withOutside),
                };
                expect(contract.validateSameContent(outsideDirectory)).toBe(false);
            }
        }

        const historicalRoot = path.join(sandbox, "historical-assets");
        fs.cpSync(fixture.assetsRoot, historicalRoot, { recursive: true });
        const manifest = structuredClone(closure.manifest);
        manifest.nativeRepresentations = [legacy];
        manifest.fingerprint = computeVersionFingerprint(
            manifest.versionCanonicalContentFingerprint,
            manifest.nativeRepresentations,
            manifest.dialectRestorationPayloads,
            manifest.portableDialectContracts,
        );
        fs.writeFileSync(
            path.join(historicalRoot, manifest.assetId, "versions", manifest.versionId, "version.json"),
            JSON.stringify(manifest),
        );
        const historical = readVersionAuthority(
            historicalRoot,
            manifest.assetId,
            manifest.versionId,
            bindDialectRegistry(spec.provider)(),
        );
        expect(historical?.manifest.nativeRepresentations).toEqual([legacy]);
        expect(historical?.nativePayloads).toEqual(closure.nativePayloads);
    });
});

it.each(
    CASES.filter((spec) => "rootEntry" in spec),
)("preserves $name with no child directories as the historical file carrier", async (spec) => {
    const fixture = createFixture(spec);
    for (const directory of ["assets", "empty", "scripts"])
        fs.rmSync(path.join(fixture.sourceRoot.path, directory), { recursive: true });
    const read = await fixture.readAgain();
    const candidate = read.candidates.find((item) => item.displayName === "sample");
    if (candidate === undefined) throw new Error("Root Skill candidate is missing");
    expect(candidate.nativeRepresentation).toMatchObject({ representationSource: "separate_files" });
    const accepted = await fixture.accept(read, candidate.candidateId);
    expect(accepted.status, JSON.stringify(accepted.diagnostics)).toBe("complete");
    expect(fixture.reopen(accepted.value.assetId, accepted.value.versionId).manifest.nativeRepresentations[0]).toMatchObject({
        schemaVersion: 1,
        files: [{ relativePath: "SKILL.md" }],
    });
});

describe("explicit OpenCode source interpretation", () => {
    function externalSpec() {
        const spec = CASES.find((item) => item.name === "OpenCode external root entry");
        if (spec === undefined) throw new Error("External OpenCode source fixture is missing");
        return spec;
    }

    it.each([
        {},
        { agentRuntimeIds: ["OPENCODE_CLI", "OPENCODE_APP"] },
    ])("retains an import conflict for an unselected or explicitly combined interpretation: %j", async (selection) => {
        const fixture = createFixture(externalSpec(), selection);
        const read = await fixture.readAgain();
        expect(read.candidates.map((item) => item.displayName).sort()).toEqual(["neighbor", "neighbor", "sample", "sample"]);
        expect(
            read.candidates
                .filter((item) => item.displayName === "sample")
                .map((item) => item.nativeRepresentation.dialectId)
                .sort(),
        ).toEqual(["opencode-skill-directory-v1", "opencode-skill-directory-v2"]);
        const preview = fixture.service.previewImport([read]);
        expect(preview.value.items).toHaveLength(2);
        for (const item of preview.value.items)
            expect(item).toMatchObject({
                action: "blocked",
                diagnostics: [expect.objectContaining({ code: "import.same_source_interpretation_conflict" })],
            });
        expect(fs.existsSync(fixture.assetsRoot)).toBe(false);
    });

    it("imports the explicitly selected App interpretation without relabelling its native graph", async () => {
        const fixture = createFixture(externalSpec(), { agentRuntimeIds: ["OPENCODE_APP"] });
        const read = await fixture.readAgain();
        expect(read.candidates.map((item) => item.displayName).sort()).toEqual(["neighbor", "sample"]);
        const candidate = read.candidates.find((item) => item.displayName === "sample")!;
        const accepted = await fixture.accept(read, candidate.candidateId);
        expect(accepted.status, JSON.stringify(accepted.diagnostics)).toBe("complete");
        const saved = fixture.reopen(accepted.value.assetId, accepted.value.versionId);
        expect(saved.manifest.typeData).toMatchObject({ entryDialectId: "opencode-skill-markdown-v1" });
        expect(saved.manifest.nativeRepresentations[0]).toMatchObject({
            dialectId: "opencode-skill-directory-v1",
            directories: fixture.directories,
        });
    });

    it.each([
        [],
        ["UNKNOWN"],
        ["CODEX_CLI"],
        ["OPENCODE_CLI", "OPENCODE_CLI"],
        [" "],
    ])("refuses invalid runtime selection before Provider I/O: %j", async (...selection: string[]) => {
        const fixture = createFixture(externalSpec(), { agentRuntimeIds: selection });
        const read = vi.fn(opencodeProvider.read);
        const result = await executeAdapterReadWithAuthority({ ...opencodeProvider, read }, fixture.target, {
            managedTargetGuards: [],
            reservationIdentityFingerprints: [],
            transactionsRoot: fixture.transactionsRoot,
        });
        expect(result.status).toBe("failed");
        expect(result.diagnostics).toEqual(
            expect.arrayContaining([expect.objectContaining({ code: "read.agent_runtime_selection_invalid" })]),
        );
        expect(read).not.toHaveBeenCalled();
    });

    it("refuses an App selection for a root observed only for CLI before Provider I/O", async () => {
        const spec = CASES.find((item) => item.name === "OpenCode project");
        if (spec === undefined) throw new Error("Project fixture is missing");
        const fixture = createFixture(spec, { agentRuntimeIds: ["OPENCODE_APP"] });
        const read = vi.fn(opencodeProvider.read);
        const result = await executeAdapterReadWithAuthority({ ...opencodeProvider, read }, fixture.target, {
            managedTargetGuards: [],
            reservationIdentityFingerprints: [],
            transactionsRoot: fixture.transactionsRoot,
        });
        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]?.code).toBe("read.agent_runtime_selection_invalid");
        expect(read).not.toHaveBeenCalled();
    });

    it("refuses an unmatched selected root instead of silently dropping its owner", async () => {
        const spec = CASES.find((item) => item.name === "OpenCode project");
        if (spec === undefined) throw new Error("Project fixture is missing");
        const fixture = createFixture(spec);
        const selector = fixture.target.sourceSelector;
        if (selector.selectorKind !== "probe_roots") throw new Error("Expected probe selection");
        const source = selector.observation.sourceRoots[0]!;
        const appRoot = { ...source, sourceRootId: "app-only", path: path.join(sandbox, "app-only") };
        fs.mkdirSync(appRoot.path);
        selector.observation.sourceRoots.push(appRoot);
        selector.sourceRootIds.push(appRoot.sourceRootId);
        selector.observation.observedAgentRuntimes.push({
            ...selector.observation.observedAgentRuntimes[0]!,
            agentRuntimeId: "OPENCODE_APP",
            sourceRootIds: [appRoot.sourceRootId],
        });
        const read = vi.fn(opencodeProvider.read);
        const result = await executeAdapterReadWithAuthority({ ...opencodeProvider, read }, fixture.target, {
            managedTargetGuards: [],
            reservationIdentityFingerprints: [],
            transactionsRoot: fixture.transactionsRoot,
        });
        expect(result.status).toBe("failed");
        expect(result.diagnostics).toEqual(
            expect.arrayContaining([expect.objectContaining({ code: "read.source_capability_unavailable" })]),
        );
        expect(read).not.toHaveBeenCalled();
    });

    it("replays the selected interpretation at acceptance and rejects an old preview after it changes", async () => {
        const fixture = createFixture(externalSpec());
        const read = await fixture.readAgain();
        const candidate = read.candidates[0]!;
        fixture.target.agentRuntimeIds = ["OPENCODE_APP"];
        const changed = await fixture.readAgain();
        expect(read.readTarget.agentRuntimeIds).toEqual(["OPENCODE_CLI"]);
        expect(changed.readTarget.agentRuntimeIds).toEqual(["OPENCODE_APP"]);
        expect(changed.readAuthorityFingerprint).not.toBe(read.readAuthorityFingerprint);
        expect(changed.readSnapshotFingerprint).not.toBe(read.readSnapshotFingerprint);
        const accepted = await fixture.accept(read, candidate.candidateId);
        expect(accepted.status).toBe("failed");
        expect(accepted.diagnostics[0]?.code).toBe("import.source_changed");
        expect(fs.existsSync(fixture.assetsRoot)).toBe(false);
    });
});

function createFixture(
    spec: (typeof CASES)[number],
    runtimeSelection: { agentRuntimeIds?: string[] } = { agentRuntimeIds: [spec.agentRuntimeId] },
) {
    const projectRoot = path.join(sandbox, "project");
    const rootPath = spec.scope === "project" ? projectRoot : path.join(sandbox, "config");
    const rootEntry = "rootEntry" in spec && spec.rootEntry;
    const externalRoot = "externalRoot" in spec && spec.externalRoot;
    const leaf = rootEntry ? "" : spec.base === "" ? "sample" : `${spec.base}/sample`;
    const prefix = leaf === "" ? "" : `${leaf}/`;
    const containerPaths = [leaf, `${prefix}assets`, `${prefix}empty`, `${prefix}empty/nested`, `${prefix}scripts`];
    const directories = containerPaths.filter((directory) => directory !== "");
    const files = [`${prefix}SKILL.md`, `${prefix}assets/marker.bin`, `${prefix}scripts/check.sh`];
    for (const directory of directories) fs.mkdirSync(path.join(rootPath, directory), { recursive: true });
    fs.writeFileSync(path.join(rootPath, files[0]!), ENTRY);
    fs.writeFileSync(path.join(rootPath, files[1]!), BINARY);
    fs.writeFileSync(path.join(rootPath, files[2]!), SCRIPT, { mode: 0o755 });
    fs.mkdirSync(path.join(rootPath, spec.base, "sample-neighbor", "empty"), { recursive: true });
    fs.writeFileSync(
        path.join(rootPath, spec.base, "sample-neighbor", "SKILL.md"),
        ENTRY.replace("name: sample", "name: neighbor"),
    );
    const sourceRoot = fixtureSourceRoot({
        sourceRootId: "source",
        path: rootPath,
        rootRole:
            spec.scope === "project" ? "project_actual" : spec.provider.adapterId === "CODEX" || rootEntry ? "source" : "config",
        sourceDomain: externalRoot
            ? "external_managed"
            : spec.scope === "project"
              ? "project_root"
              : spec.provider.adapterId === "ANTIGRAVITY" || spec.provider.adapterId === "CODEX" || rootEntry
                ? "family_shared"
                : "agent_runtime_private",
        locatorKind: externalRoot
            ? "user_provided_path"
            : spec.scope === "project"
              ? spec.provider.adapterId === "CLAUDECODE" || spec.provider.adapterId === "CURSOR"
                  ? "user_provided_path"
                  : "project_registry_entry"
              : "runtime_known_rule",
        locatorKey: spec.scope === "project" ? "probe_project_root" : "fixture_config",
        evidenceLevel: spec.scope === "project" ? "user_provided" : "source_code",
    });
    const oaamRoot = path.join(sandbox, "oaam");
    const assetsRoot = path.join(oaamRoot, "assets");
    const projectsRoot = path.join(oaamRoot, "projects");
    const locksRoot = path.join(oaamRoot, "locks");
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(path.join(oaamRoot, "transactions"), { recursive: true });
    writeProjectManifest(projectsRoot, {
        schemaVersion: 1,
        projectId: PROJECT_ID,
        rootPath: projectRoot,
        displayName: "Owned project",
        deleted: false,
        createdAt: 1,
        updatedAt: 1,
    });
    const target: AdapterReadTarget = externalRoot
        ? {
              adapterId: spec.provider.adapterId,
              allowedKinds: ["Skill"],
              ...runtimeSelection,
              sourceSelector: {
                  selectorKind: "user_selected_root",
                  platformContext: { platform: "linux", platformInstanceId: "local", accessRootPath: sandbox },
                  binding: { sourceRoot, assetScope: "global", projectRootPath: "" },
              },
          }
        : {
              ...fixtureProbeRootTarget({
                  adapterId: spec.provider.adapterId,
                  agentRuntimeId: spec.agentRuntimeId,
                  versionText: "fixture",
                  sourceRoots: [sourceRoot],
                  allowedKinds: ["Skill"],
                  installationEvidence: [],
                  installationStatus: "available",
                  projectDiscoveryStatus: "complete",
              }),
              ...runtimeSelection,
          };
    const readAgain = () =>
        authoritativeFixtureRead({
            provider: spec.provider,
            transactionsRoot: path.join(oaamRoot, "transactions"),
            target,
        });
    const service = fixtureImportService({
        provider: spec.provider,
        assetsRoot,
        oaamRoot,
        authorityLocksRoot: locksRoot,
        projectRootPath: projectRoot,
        projectId: PROJECT_ID,
        readAgain,
    });
    const registry = bindDialectRegistry(spec.provider)();
    return {
        target,
        service,
        transactionsRoot: path.join(oaamRoot, "transactions"),
        leaf,
        directories,
        containerPaths,
        files,
        sourceRoot,
        assetsRoot,
        projectsRoot,
        locksRoot,
        registry,
        readAgain,
        accept: (read: Awaited<ReturnType<typeof readAgain>>, candidateId: string) =>
            acceptFixtureCandidate({ service, read, candidateId, userActionId: "retain-directory-graph" }),
        reopen: (assetId: UuidV4, versionId: UuidV4) => {
            const closure = readVersionAuthority(assetsRoot, assetId, versionId, registry);
            if (closure === null) throw new Error("Imported Version authority is missing");
            return closure;
        },
    };
}
