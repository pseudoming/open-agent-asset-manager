import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { textPayloadStats } from "../../src/catalog/payload-store";
import { computeVersionNativeRepresentationFingerprint } from "../../src/foundation/fingerprint";
import type { RenderBaseAuthority } from "../../src/orchestration/deployment-render-authority";
import {
    prepareRenderOperation,
    reprojectObservedReverseRenderOperation,
} from "../../src/orchestration/deployment-render-service";
import { deriveRequiredRenderSemanticsV1, validateRenderDeploymentInput } from "../../src/render/render-semantics";
import { makeVersionClosure, VERSION_ID_2 } from "../catalog/fixtures/version-v2";
import {
    CATALOG_ASSET_ID,
    CATALOG_TEXT,
    CATALOG_VERSION_ID,
    CHANGED_CATALOG_TEXT,
    changedCatalogCanonical,
    makeMemoryCatalogExactFileFixture,
    MEMORY_CATALOG_PATH,
    TEST_HASH,
} from "./fixtures/native-project-memory-catalog-test-fixtures";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("reverse staged render projection", () => {
    it("rebuilds the new Catalog Version, dialect, semantics and current target receipt", async () => {
        const { base, operation, dependencies } = await observedCatalog();
        const staged = structuredClone(base);
        const closure = makeVersionClosure({
            assetId: CATALOG_ASSET_ID,
            versionId: VERSION_ID_2,
            sourceVersionId: CATALOG_VERSION_ID,
            revision: 2,
            changeKind: "edit",
            canonical: changedCatalogCanonical(),
            files: [],
        });
        const catalog = staged.assets[0]!;
        catalog.version = {
            ...catalog.version,
            ref: { assetId: CATALOG_ASSET_ID, versionId: VERSION_ID_2 },
            versionFingerprint: closure.manifest.fingerprint,
            versionCanonicalContentFingerprint: closure.manifest.versionCanonicalContentFingerprint,
            canonical: changedCatalogCanonical(),
            files: closure.files,
        };
        const dialect = structuredClone(staged.dialectInputs[0]!);
        dialect.targetVersion = structuredClone(catalog.version.ref);
        const native = dialect.inputs[0];
        if (native?.inputKind !== "native_representation") throw new Error("Catalog native fixture missing");
        const file = native.files[0];
        if (file?.contentKind !== "text") throw new Error("Catalog native text fixture missing");
        const changedFile = { ...file, ...textPayloadStats(CHANGED_CATALOG_TEXT), text: CHANGED_CATALOG_TEXT };
        const { text: _text, ...descriptor } = changedFile;
        const { representationFingerprint: _fingerprint, ...metadata } = native.representation;
        const representation = {
            ...metadata,
            canonicalContentFingerprint: closure.manifest.versionCanonicalContentFingerprint,
            files: [descriptor],
        };
        native.representation = {
            ...representation,
            representationFingerprint: computeVersionNativeRepresentationFingerprint(representation),
        };
        native.files = [changedFile];
        // Both old and new dialects are available; only new-Version semantics can
        // select the Catalog input needed to capture its current target receipt.
        staged.dialectInputs.push(dialect);
        staged.appliedInputsSnapshot.assets[0]!.versionId = VERSION_ID_2;
        fs.writeFileSync(path.join(base.targetRootPath, MEMORY_CATALOG_PATH), CHANGED_CATALOG_TEXT);
        const originalOperation = structuredClone({ deployment: operation.deployment, dialectInputs: operation.dialectInputs });
        const projected = reprojectObservedReverseRenderOperation(staged, { base, operation }, dependencies);

        expect(projected.deployment.assets).toEqual(staged.assets);
        expect(projected.dialectInputs).toEqual(staged.dialectInputs);
        expect(projected.deployment.targetContexts).toEqual(operation.deployment.targetContexts);
        expect(projected.deployment.targetContexts).not.toBe(operation.deployment.targetContexts);
        expect(projected.deployment.renderInputFingerprint).not.toBe(operation.deployment.renderInputFingerprint);
        expect(projected.deployment.targetFileSnapshots).toEqual([
            {
                relativePath: MEMORY_CATALOG_PATH,
                snapshotState: "present",
                ...textPayloadStats(CHANGED_CATALOG_TEXT),
                executable: false,
            },
        ]);
        const catalogSemantics = deriveRequiredRenderSemanticsV1(projected.deployment).filter(
            (semantic) => semantic.subject.assetId === CATALOG_ASSET_ID,
        );
        expect(catalogSemantics.length).toBeGreaterThan(0);
        expect(catalogSemantics.every((semantic) => semantic.subject.versionId === VERSION_ID_2)).toBe(true);
        expect(() => validateRenderDeploymentInput(projected.deployment, projected.registry)).not.toThrow();
        expect({ deployment: operation.deployment, dialectInputs: operation.dialectInputs }).toEqual(originalOperation);
    });

    it.each(["missing", "unsafe", "removed Catalog"])("does not reuse the old Catalog receipt for %s", async (change) => {
        const { base, operation, dependencies } = await observedCatalog();
        const staged = structuredClone(base);
        const target = path.join(base.targetRootPath, MEMORY_CATALOG_PATH);
        fs.unlinkSync(target);
        if (change === "unsafe") fs.mkdirSync(target);
        if (change === "removed Catalog") staged.assets = staged.assets.slice(1);
        const project = () => reprojectObservedReverseRenderOperation(staged, { base, operation }, dependencies);
        if (change === "unsafe") {
            expect(project).toThrow(/snapshot failed/);
        } else {
            expect(project().deployment.targetFileSnapshots).toEqual(
                change === "missing" ? [{ relativePath: MEMORY_CATALOG_PATH, snapshotState: "missing" }] : undefined,
            );
        }
        expect(operation.deployment.targetFileSnapshots?.[0]?.snapshotState).toBe("present");
    });

    it.each([
        "deploymentId",
        "consumerAgentRuntimeIds",
        "platform",
        "platformInstanceId",
        "targetRootPath",
        "projectId",
        "projectRootPath",
        "assetKinds",
    ])("rejects changed physical input %s", async (field) => {
        const { base, operation, dependencies } = await observedCatalog();
        const staged = structuredClone(base);
        switch (field) {
            case "deploymentId":
                staged.deploymentId = VERSION_ID_2;
                break;
            case "consumerAgentRuntimeIds":
                staged.consumerAgentRuntimeIds = ["OTHER_CLI"];
                break;
            case "platform":
                staged.platform = "linux";
                break;
            case "platformInstanceId":
                staged.platformInstanceId = "other-instance";
                break;
            case "targetRootPath":
                staged.targetRootPath += "/other";
                break;
            case "projectId":
                staged.projectId = VERSION_ID_2;
                break;
            case "projectRootPath":
                staged.projectRootPath += "/other";
                break;
            case "assetKinds":
                staged.assets[0]!.version.canonical = { kind: "Guidance", typeData: { schemaVersion: 1 } };
                break;
        }
        expect(() => reprojectObservedReverseRenderOperation(staged, { base, operation }, dependencies)).toThrow(
            expect.objectContaining({ code: "render.action_time_context_changed" }),
        );
    });

    it.each(["operation target", "observed registry", "operation registry"])("rejects mismatched %s", async (change) => {
        const { base, operation, dependencies } = await observedCatalog();
        if (change === "operation target") operation.deployment.targetRootPath += "/other";
        if (change === "observed registry") operation.registry = { ...operation.registry, fingerprint: TEST_HASH };
        if (change === "operation registry") operation.deployment.renderRegistryFingerprint = TEST_HASH;
        expect(() => reprojectObservedReverseRenderOperation(base, { base, operation }, dependencies)).toThrow(
            expect.objectContaining({ code: "render.action_time_context_changed" }),
        );
    });
});

async function observedCatalog() {
    const fixture = makeMemoryCatalogExactFileFixture();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-reverse-render-projection-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, MEMORY_CATALOG_PATH), CATALOG_TEXT);
    const base: RenderBaseAuthority = {
        deploymentId: fixture.deployment.deploymentId,
        consumerAgentRuntimeIds: fixture.deployment.consumerAgentRuntimeIds,
        platform: fixture.deployment.platform,
        platformInstanceId: fixture.deployment.platformInstanceId,
        targetRootPath: root,
        projectId: fixture.deployment.projectId,
        projectRootPath: root,
        assets: fixture.deployment.assets,
        dialectInputs: fixture.analysisInput.dialectInputs,
        appliedInputsSnapshot: {
            schemaVersion: 1,
            deploymentId: fixture.deployment.deploymentId,
            consumerAgentRuntimeIds: fixture.deployment.consumerAgentRuntimeIds,
            assets: fixture.deployment.assets.map((asset) => ({ ...asset.version.ref, allowIncomplete: false })),
        },
    };
    const dependencies = {
        buildRenderRegistry: () => fixture.registry,
        probeAdapters: async () => ({
            status: "complete",
            value: [
                {
                    observation: {
                        adapterId: fixture.provider.adapterId,
                        platformContext: {
                            platform: base.platform,
                            platformInstanceId: base.platformInstanceId,
                            accessRootPath: root,
                        },
                        observedAgentRuntimes: [],
                    },
                },
            ],
            diagnostics: [],
        }),
        resolveObservedTargetContext: () => ({
            status: "complete",
            targetContext: fixture.deployment.targetContexts[0],
            diagnostics: [],
        }),
    };
    const operation = await prepareRenderOperation(
        base,
        {
            platformContexts: [{ platform: base.platform, platformInstanceId: base.platformInstanceId, accessRootPath: root }],
        } as never,
        dependencies as never,
    );
    return { base, operation, dependencies };
}
