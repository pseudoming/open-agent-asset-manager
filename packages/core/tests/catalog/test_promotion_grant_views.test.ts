import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCoreServiceForTest } from "../../src/orchestration/core-service";
import { clearRegistry } from "../../src/orchestration/adapter-registry";
import { createPromotionGrantQuery } from "../../src/orchestration/promotion-grant-view";
import { computeGlobalPromotionTargetAuthorityFingerprint } from "../../src/foundation/fingerprint-render";
import { resolvePromotionGrantAuthority } from "../../src/catalog/promotion-grant-store";
import { closeDb, getDb } from "../../src/persistence/db";
import { insertDeployment } from "../../src/persistence/state-db";
import type { CoreService, PromotionGrantTarget, UuidV4 } from "../../src/types";
import { makeContractProvider } from "../adapters/fixtures/adapter-contract-fixtures";

let root: string;
let core: CoreService;
let assetId: UuidV4;
let versionId: UuidV4;
const id = (n: number): UuidV4 => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-grant-view-"));
    clearRegistry();
    closeDb();
    let sequence = 1;
    core = createCoreServiceForTest(
        {
            providers: [makeContractProvider("GRANT_FIXTURE")],
            platformContexts: [{ platform: "linux", platformInstanceId: "local", accessRootPath: "/" }],
            oaamRoot: path.join(root, "oaam"),
            databasePath: path.join(root, "state.db"),
            now: () => 1000,
            newUuid: () => id(sequence++),
        },
        {},
    );
    const created = core.createAsset({
        kind: "Guidance",
        scope: "global",
        projectId: "",
        scopePath: "",
        displayName: "Grant Asset",
        displayDescription: "",
        initialVersion: {
            typeData: { schemaVersion: 1 },
            files: [
                {
                    logicalPath: "AGENTS.md",
                    role: "entry",
                    contentKind: "text",
                    mediaType: "text/markdown",
                    text: "# Keep\n",
                    executable: false,
                    references: [],
                },
            ],
            userActionEvidenceId: "fixture-create",
            changeKind: "create",
        },
    });
    expect(created.status, JSON.stringify(created.diagnostics)).toBe("complete");
    assetId = created.value.assetId;
    versionId = created.value.versionIds[0] as UuidV4;
});

afterEach(() => {
    closeDb();
    clearRegistry();
    fs.rmSync(root, { recursive: true, force: true });
});

function grant(target: PromotionGrantTarget, allVersions = false) {
    const result = core.createPromotionGrant(
        allVersions
            ? { promotionAction: "grant_asset_all_versions_current_target", assetId, target, userActionId: "fixture-grant" }
            : {
                  promotionAction: "grant_current_version_current_target",
                  assetId,
                  versionId,
                  target,
                  userActionId: "fixture-grant",
              },
    );
    expect(result.status).toBe("complete");
    return result.value;
}

const globalLocation = {
    platform: "wsl" as const,
    platformInstanceId: "Ubuntu-fixture",
    targetRootPath: "/home/fixture/.agent",
    consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
};

function deployment(n: number, fields: Record<string, string | number> = {}) {
    insertDeployment(getDb(path.join(root, "state.db")), {
        deploymentId: id(n),
        ...globalLocation,
        consumerAgentRuntimeIds: JSON.stringify(globalLocation.consumerAgentRuntimeIds),
        projectId: "",
        committedTransactionId: "",
        appliedInputsSnapshot: "{}",
        appliedRenderSnapshotRef: '{"state":"never"}',
        observationState: "never",
        observationAttemptedAt: 0,
        lastCompleteObservationAt: 0,
        blockingEvidence: "{}",
        deleted: 0,
        createdAt: 1,
        updatedAt: 1,
        ...fields,
    });
}

describe("saved grant read views through Core", () => {
    it("describes a real Project and revokes the exact grant without changing Asset or Project material", () => {
        const projectRoot = path.join(root, "project");
        fs.mkdirSync(projectRoot);
        const project = core.registerProject({ rootPath: projectRoot, displayName: "Project A" }).value;
        fs.writeFileSync(path.join(projectRoot, "keep.txt"), "untouched");
        const target = { targetKind: "project" as const, projectId: project.projectId };
        const created = grant(target);
        expect(core.listPromotionGrantViews(assetId).value).toEqual([
            {
                ...created,
                targetDescription: {
                    status: "available",
                    targetKind: "project",
                    displayName: "Project A",
                    rootPath: projectRoot,
                },
            },
        ]);
        const authority = () =>
            resolvePromotionGrantAuthority({ assetsRoot: path.join(root, "oaam/assets"), assetId, versionId, target });
        expect(authority()).not.toBeNull();
        const input = {
            promotionGrantId: created.promotionGrantId,
            expectedRevision: created.revision,
            expectedGrantFingerprint: created.grantFingerprint,
            userActionId: "fixture-revoke",
        };
        expect(core.revokePromotionGrant(input).value.grantState).toBe("revoked");
        expect(authority()).toBeNull();
        expect(core.listPromotionGrantViews(assetId).value[0]).toMatchObject({
            grantState: "revoked",
            targetDescription: { displayName: "Project A" },
        });
        expect(core.revokePromotionGrant(input).status).toBe("failed");
        expect(core.getAsset(assetId).value).toMatchObject({ found: true, value: { versionIds: [versionId] } });
        expect(core.getProject(project.projectId).value).toEqual({ found: true, value: project });
        expect(fs.readFileSync(path.join(projectRoot, "keep.txt"), "utf8")).toBe("untouched");
    });

    it("retains missing Project descriptions and all-version scope without losing revocation", () => {
        const created = grant({ targetKind: "project", projectId: id(901) }, true);
        expect(core.listPromotionGrantViews(assetId).value).toEqual([
            { ...created, targetDescription: { status: "unavailable" } },
        ]);
        expect(
            core.revokePromotionGrant({
                promotionGrantId: created.promotionGrantId,
                expectedRevision: created.revision,
                expectedGrantFingerprint: created.grantFingerprint,
                userActionId: "missing-project-revoke",
            }).value.grantState,
        ).toBe("revoked");
    });

    it("matches exact saved global metadata including deleted and duplicate deployments, with no target access", () => {
        const created = grant({
            targetKind: "global_target",
            targetAuthorityFingerprint: computeGlobalPromotionTargetAuthorityFingerprint(globalLocation),
        });
        expect(core.listPromotionGrantViews(assetId).value[0]?.targetDescription).toEqual({ status: "unavailable" });
        deployment(101, { targetRootPath: "/another-root" });
        deployment(102, { platformInstanceId: "Other-Ubuntu" });
        deployment(103, { consumerAgentRuntimeIds: '["CODEX_CLI"]' });
        deployment(104, { projectId: id(901) });
        // Deliberately corrupt saved description material through SQLite's explicit test control.
        const db = getDb(path.join(root, "state.db"));
        db.pragma("ignore_check_constraints = ON");
        try {
            deployment(105, { platform: "invalid-platform" });
            deployment(106, { consumerAgentRuntimeIds: "invalid-json" });
            deployment(109, { platformInstanceId: " " });
            deployment(110, { targetRootPath: " " });
            deployment(111, { consumerAgentRuntimeIds: "[]" });
            deployment(112, { consumerAgentRuntimeIds: '[" "]' });
        } finally {
            db.pragma("ignore_check_constraints = OFF");
        }
        expect(core.listPromotionGrantViews(assetId).value[0]?.targetDescription).toEqual({ status: "unavailable" });
        deployment(107, { deleted: 1 });
        deployment(108);
        expect(core.listPromotionGrantViews(assetId).value).toEqual([
            { ...created, targetDescription: { status: "available", targetKind: "global_target", ...globalLocation } },
        ]);
        expect(core.listPromotionGrants(assetId).value).toEqual([created]);
    });

    it("keeps a damaged Project description unavailable and reports the underlying grant read failure", () => {
        const projectRoot = path.join(root, "project");
        fs.mkdirSync(projectRoot);
        const project = core.registerProject({ rootPath: projectRoot }).value;
        grant({ targetKind: "project", projectId: project.projectId });
        fs.writeFileSync(path.join(root, "oaam/projects", project.projectId, "project.json"), "invalid");
        expect(core.listPromotionGrantViews(assetId).value[0]?.targetDescription).toEqual({ status: "unavailable" });
        const failure = core.listPromotionGrants("invalid-id" as UuidV4);
        expect(failure.status).toBe("failed");
        const query = createPromotionGrantQuery(getDb(path.join(root, "state.db")), core, core);
        expect(query.listPromotionGrantViews("invalid-id" as UuidV4)).toEqual({ ...failure, value: [] });
    });

    it("keeps filesystem grants reviewable and revocable when the auxiliary State database is closed", () => {
        const created = grant({
            targetKind: "global_target",
            targetAuthorityFingerprint: computeGlobalPromotionTargetAuthorityFingerprint(globalLocation),
        });
        const db = getDb(path.join(root, "state.db"));
        const query = createPromotionGrantQuery(db, core, core);
        db.close();
        expect(query.listPromotionGrantViews(assetId).value).toEqual([
            { ...created, targetDescription: { status: "unavailable" } },
        ]);
        expect(
            core.revokePromotionGrant({
                promotionGrantId: created.promotionGrantId,
                expectedRevision: created.revision,
                expectedGrantFingerprint: created.grantFingerprint,
                userActionId: "closed-description-revoke",
            }).value.grantState,
        ).toBe("revoked");
    });
});
