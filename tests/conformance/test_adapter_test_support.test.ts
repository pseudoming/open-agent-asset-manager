/** Conformance gate for the runtime-neutral adapter test-support owner. */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { Sha256Digest } from "@oaam/core";
import {
    failingReadAccess,
    fixtureDirectoryProbeContext,
    fixtureGlobalProbeContext,
    fixtureProjectProbeContext,
    fixtureReadAccess,
    fixtureSourceRoot,
    nonDirectoryRootReadAccess,
    unexpectedReadAccess,
} from "../../packages/adapter/test-support";

const ROOT_DIR = path.resolve(__dirname, "../..");
const DIGEST = `sha256:${"f".repeat(64)}` as Sha256Digest;

describe("adapter test-support boundary", () => {
    it("models directory, file, executable, and explicit-entry reads without hidden success", async () => {
        const root = fixtureSourceRoot({
            sourceRootId: "fixture-root",
            path: "/fixture/root",
            rootRole: "project_actual",
            sourceDomain: "project_root",
            locatorKind: "user_provided_path",
            locatorKey: "fixture",
            evidenceLevel: "user_provided",
        });
        const readAccess = fixtureReadAccess({
            root,
            fixture: {
                "docs/readme.md": "# Readme\n",
                "run.bin": { text: "run", executable: true },
            },
            digest: DIGEST,
            resolveEntries: true,
        });

        const rootResult = await readAccess.resolveRootEntry("obligation", root.sourceRootId);
        expect(rootResult.state).toBe("succeeded");
        if (rootResult.state !== "succeeded") throw new Error("fixture root was not resolved");

        const listed = await readAccess.listDirectory(rootResult.value.readEntryHandleId);
        expect(listed.state).toBe("succeeded");
        if (listed.state !== "succeeded") throw new Error("fixture root was not listed");
        expect(listed.value.children.map((child) => [child.relativePath, child.entryKind])).toEqual([
            ["docs", "directory"],
            ["run.bin", "file"],
        ]);

        const executable = await readAccess.resolveEntry("obligation", root.sourceRootId, "run.bin");
        expect(executable.state).toBe("succeeded");
        if (executable.state !== "succeeded") throw new Error("fixture file was not resolved");
        const file = await readAccess.readFile(executable.value.readEntryHandleId);
        expect(file).toMatchObject({
            state: "succeeded",
            value: { entry: { relativePath: "run.bin", executable: true } },
        });
        if (file.state !== "succeeded") throw new Error("fixture file was not read");
        expect(Buffer.from(file.value.bytes).toString("utf8")).toBe("run");
        expect(new Set([rootResult.readAccessOutcomeId, listed.readAccessOutcomeId, file.readAccessOutcomeId]).size).toBe(3);
    });

    it("keeps disabled resolution, failures, non-directory roots, and unexpected calls observable", async () => {
        const root = fixtureSourceRoot({
            sourceRootId: "fixture-root",
            path: "/fixture/root",
            rootRole: "project_actual",
            sourceDomain: "project_root",
            locatorKind: "user_provided_path",
            locatorKey: "fixture",
            evidenceLevel: "user_provided",
        });
        const withoutExplicitResolution = fixtureReadAccess({
            root,
            fixture: { "AGENTS.md": "# Guidance\n" },
            digest: DIGEST,
            resolveEntries: false,
        });
        await expect(withoutExplicitResolution.resolveEntry("obligation", root.sourceRootId, "AGENTS.md")).resolves.toMatchObject(
            { state: "failed", failureStatus: "not_found" },
        );
        await expect(failingReadAccess("permission_denied").readFile("handle")).resolves.toMatchObject({
            state: "failed",
            failureStatus: "permission_denied",
        });
        await expect(nonDirectoryRootReadAccess(root).resolveRootEntry("obligation", root.sourceRootId)).resolves.toMatchObject({
            state: "succeeded",
            value: { entryKind: "file" },
        });

        let calls = 0;
        await expect(
            unexpectedReadAccess(() => {
                calls += 1;
            }).listDirectory("handle"),
        ).rejects.toThrow("report-only capability invoked read access");
        expect(calls).toBe(1);
    });

    it("keeps issued handles opaque and rejects forged, wrong-kind, and consumed handles", async () => {
        const root = fixtureSourceRoot({
            sourceRootId: "fixture-root",
            path: "/fixture/root",
            rootRole: "project_actual",
            sourceDomain: "project_root",
            locatorKind: "user_provided_path",
            locatorKey: "fixture",
            evidenceLevel: "user_provided",
        });
        const readAccess = fixtureReadAccess({
            root,
            fixture: { "docs:archive/readme.md": "# Colon path\n" },
            digest: DIGEST,
            resolveEntries: true,
        });

        const resolved = await readAccess.resolveEntry("obligation:opaque", root.sourceRootId, "docs:archive/readme.md");
        expect(resolved.state).toBe("succeeded");
        if (resolved.state !== "succeeded") throw new Error("fixture file was not resolved");
        expect(resolved.value).toMatchObject({
            sourceReadObligationId: "obligation:opaque",
            relativePath: "docs:archive/readme.md",
            entryKind: "file",
        });
        expect(resolved.value.readEntryHandleId).not.toContain("obligation:opaque");
        expect(resolved.value.readEntryHandleId).not.toContain("docs:archive");

        await expect(readAccess.listDirectory(resolved.value.readEntryHandleId)).resolves.toMatchObject({
            state: "failed",
            failureStatus: "io_error",
        });
        await expect(readAccess.readFile("fixture-handle-forged")).resolves.toMatchObject({
            state: "failed",
            failureStatus: "io_error",
        });

        const read = await readAccess.readFile(resolved.value.readEntryHandleId);
        expect(read.state).toBe("succeeded");
        if (read.state !== "succeeded") throw new Error("colon-bearing fixture file was not read");
        expect(Buffer.from(read.value.bytes).toString("utf8")).toBe("# Colon path\n");
        await expect(readAccess.readFile(resolved.value.readEntryHandleId)).resolves.toMatchObject({
            state: "failed",
            failureStatus: "io_error",
        });
    });

    it("constructs all probe authorization scopes through one explicit platform fixture", () => {
        expect(fixtureGlobalProbeContext("wsl")).toEqual({
            authorizationScope: "global",
            platformContext: {
                platform: "wsl",
                platformInstanceId: "fixture",
                accessRootPath: "/",
            },
        });
        expect(fixtureProjectProbeContext("/project")).toMatchObject({
            authorizationScope: "project",
            projectRootPath: "/project",
        });
        expect(fixtureDirectoryProbeContext("/external")).toMatchObject({
            authorizationScope: "directory",
            directoryRootPath: "/external",
        });
    });

    it("prevents the former neutral helper implementations from returning to family suites", () => {
        const sourceFixtureFiles = [
            "packages/adapter/providers/claudecode/tests/claudecode-test-fixtures.ts",
            "packages/adapter/providers/antigravity/tests/test_source_edges.test.ts",
            "packages/adapter/providers/opencode/tests/opencode-source-test-fixtures.ts",
        ];
        for (const relativePath of sourceFixtureFiles) {
            const source = fs.readFileSync(path.join(ROOT_DIR, relativePath), "utf8");
            expect(source, relativePath).toContain("../../../test-support");
            for (const copiedOwner of [
                "function fixtureReadAccess(",
                "function parseHandle(",
                "function succeeded<",
                "function failed(",
                "function userSelectedReadInput(",
                "function platformContext(",
            ]) {
                expect(source, `${relativePath}/${copiedOwner}`).not.toContain(copiedOwner);
            }
        }

        for (const family of ["claudecode", "antigravity", "opencode"] as const) {
            const relativePath = `packages/adapter/providers/${family}/tests/test_core_conformance.test.ts`;
            const source = fs.readFileSync(path.join(ROOT_DIR, relativePath), "utf8");
            expect(source, relativePath).toContain("../../../test-support");
            for (const copiedOwner of [
                "function validateWorkflowEntryAgent(",
                "function validatePortableSelector(",
                "function dialectRegistry(",
                "function uuidFactory(",
                "function authoritativeRead(",
                "function importService(",
                "function acceptCandidate(",
                "function target(",
                "function authority(",
            ]) {
                expect(source, `${relativePath}/${copiedOwner}`).not.toContain(copiedOwner);
            }
        }

        for (const relativePath of [
            "packages/adapter/providers/antigravity/tests/test_provider.test.ts",
            "packages/adapter/providers/opencode/tests/test_probe.test.ts",
        ]) {
            const source = fs.readFileSync(path.join(ROOT_DIR, relativePath), "utf8");
            expect(source, relativePath).toContain("../../../test-support");
            expect(source, relativePath).not.toContain("function globalContext(");
            expect(source, relativePath).not.toContain("function projectContext(");
            expect(source, relativePath).not.toContain("function directoryContext(");
        }
    });
});
