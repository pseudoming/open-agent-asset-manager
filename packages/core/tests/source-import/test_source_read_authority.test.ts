/** Phase 21 T3 durable managed-target and in-flight source-read authority tests. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../../src/persistence/db";
import { publishJournal } from "../../src/deployment/deployment-journal";
import { bytesToBase64, sha256Bytes } from "../../src/foundation/crypto-bytes";
import { computePhysicalKeys } from "../../src/foundation/physical-path-locks";
import {
    finalizeDeploymentResidualAuthority,
    finalizeTargetFileRenderProvenance,
    serializeAppliedRenderSnapshot,
    serializeAppliedRenderSnapshotRef,
    serializeDeploymentFileBaselineState,
    serializeDeploymentResidualAuthorityBody,
} from "../../src/render/deployment-render-authority";
import { computeAppliedRenderSnapshotFingerprint, computeRenderOutputUnitFingerprint } from "../../src/foundation/fingerprint";
import {
    deriveAdapterReadAuthorityContext,
    readAuthorityContextsAreExact,
    type SourceReadAuthorityError,
} from "../../src/source-import/source-read-authority";
import {
    insertDeployment,
    insertDeploymentRenderSnapshot,
    insertDeploymentResidualAuthority,
    upsertDeploymentFile,
} from "../../src/persistence/state-db";
import type {
    AdapterId,
    AdapterReadTarget,
    AppliedRenderSnapshotV1,
    Platform,
    Sha256Digest,
    SourceRoot,
    UuidV4,
} from "../../src/types";

const D1 = "00000000-0000-4000-8000-000000000001" as UuidV4;
const TX1 = "00000000-0000-4000-8000-000000000002" as UuidV4;
const SHA_A = `sha256:${"a".repeat(64)}` as Sha256Digest;
const SHA_B = `sha256:${"b".repeat(64)}` as Sha256Digest;
const ADAPTER = "AUTHORITY_FAKE" as AdapterId;

let sandbox = "";
let transactionsRoot = "";
let targetRoot = "";

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-source-authority-"));
    transactionsRoot = path.join(sandbox, "transactions");
    targetRoot = path.join(sandbox, "project");
    closeDb();
});

afterEach(() => {
    closeDb();
    fs.rmSync(sandbox, { recursive: true, force: true });
});

function sourceRoot(rootPath = targetRoot, sourceRootId = "root-1"): SourceRoot {
    return {
        sourceRootId,
        rootRole: "source",
        sourceDomain: "project_root",
        path: rootPath,
        accessStatus: "available",
        locatorEvidence: [
            {
                locatorKind: "runtime_known_rule",
                locatorKey: "project",
                evidenceLevel: "agent_runtime_verified",
            },
        ],
        diagnostics: [],
    };
}

function readTarget(root = sourceRoot(), platform: Platform = "linux"): AdapterReadTarget {
    return {
        adapterId: ADAPTER,
        allowedKinds: ["Guidance"],
        sourceSelector: {
            selectorKind: "probe_roots",
            observation: {
                adapterId: ADAPTER,
                platformContext: {
                    platform,
                    platformInstanceId: "local",
                    accessRootPath: platform === "win32" ? "C:\\" : "/",
                },
                observedAgentRuntimes: [],
                sourceRoots: [root],
                agentRuntimeResources: [],
                observedProjects: [],
                targetCandidates: [],
            },
            sourceRootIds: [root.sourceRootId],
        },
    };
}

function seedDeployment(platform: Platform = "linux", root = targetRoot): ReturnType<typeof getDb> {
    const db = getDb(path.join(sandbox, "state.db"));
    insertDeployment(db, {
        deploymentId: D1,
        consumerAgentRuntimeIds: JSON.stringify(["CLAUDE_CODE_CLI"]),
        platform,
        platformInstanceId: "local",
        targetRootPath: root,
        projectId: "",
        committedTransactionId: "",
        appliedInputsSnapshot: JSON.stringify({
            schemaVersion: 1,
            deploymentId: D1,
            consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
            assets: [],
        }),
        appliedRenderSnapshotRef: JSON.stringify({ snapshotState: "never" }),
        observationState: "never",
        observationAttemptedAt: 0,
        lastCompleteObservationAt: 0,
        blockingEvidence: "{}",
        deleted: 0,
        createdAt: 1,
        updatedAt: 1,
    });
    return db;
}

function seedActiveAuthority(input: {
    relativePath: string;
    boundaries?: string[];
    deploymentDeleted?: boolean;
    fileDeleted?: boolean;
    platform?: Platform;
    targetRootPath?: string;
}): { outputUnitFingerprint: Sha256Digest; snapshotFingerprint: Sha256Digest } {
    const db = seedDeployment(input.platform, input.targetRootPath);
    const unitPreimage = {
        outputContractId: "AUTHORITY_TEST_V1",
        outputContractFingerprint: SHA_A,
        claims: [
            {
                relativePath: input.relativePath,
                contentKind: "text" as const,
                executable: false,
            },
        ],
        managedDirectoryBoundaries: (input.boundaries ?? []).map((relativePath) => ({
            relativePath,
            boundaryKind: "directory_inventory" as const,
        })),
    };
    const outputUnitFingerprint = computeRenderOutputUnitFingerprint(unitPreimage);
    const outputUnit = { ...unitPreimage, outputUnitFingerprint };
    const snapshot: Extract<AppliedRenderSnapshotV1, { snapshotState: "applied" }> = {
        schemaVersion: 1,
        snapshotState: "applied",
        renderInputFingerprint: SHA_A,
        compilerPolicyVersion: "core_render_policy_v1",
        selectionFingerprint: SHA_B,
        compilationFingerprint: SHA_A,
        promotionAuthorizations: [],
        decisions: [],
        outputUnits: [outputUnit],
        outputUnitRenderers: [
            {
                outputUnitFingerprint,
                rendererAdapterId: ADAPTER,
                rendererAdapterVersion: "1",
                materializerCapabilityKey: "authority.test",
                materializationProfileId: "default",
                profileConstraintFingerprint: SHA_A,
            },
        ],
        semanticCoverageProofs: [
            {
                outputUnitFingerprint,
                coveredSemanticRefFingerprints: [],
                coverageFingerprint: SHA_B,
            },
        ],
    };
    const snapshotFingerprint = computeAppliedRenderSnapshotFingerprint(snapshot);
    insertDeploymentRenderSnapshot(db, {
        snapshotFingerprint,
        deploymentId: D1,
        snapshotJson: serializeAppliedRenderSnapshot(snapshot),
        deleted: 0,
        createdAt: 2,
        updatedAt: 2,
    });
    db.prepare("UPDATE deployments SET applied_render_snapshot_ref = ?, deleted = ? WHERE deployment_id = ?").run(
        serializeAppliedRenderSnapshotRef({ snapshotState: "applied", snapshotFingerprint }),
        input.deploymentDeleted ? 1 : 0,
        D1,
    );
    const provenance = finalizeTargetFileRenderProvenance({
        schemaVersion: 1,
        appliedRenderSnapshotFingerprint: snapshotFingerprint,
        outputUnitFingerprint,
        materializationFingerprint: SHA_B,
        semanticRefFingerprints: [],
        sectionBindings: [],
    });
    upsertDeploymentFile(
        db,
        D1,
        input.relativePath,
        serializeDeploymentFileBaselineState({
            rowState: "active",
            appliedPayload: { contentKind: "text", contentHash: SHA_A, byteSize: 1 },
            appliedExecutable: false,
            provenance,
        }),
        "present",
        SHA_A,
        0,
        2,
        2,
    );
    if (input.fileDeleted) {
        db.prepare("UPDATE deployment_files SET deleted = 1 WHERE deployment_id = ?").run(D1);
    }
    return { outputUnitFingerprint, snapshotFingerprint };
}

function replaceActiveBaselineSnapshot(
    relativePath: string,
    outputUnitFingerprint: Sha256Digest,
    snapshot: AppliedRenderSnapshotV1,
): Sha256Digest {
    const db = getDb();
    const snapshotFingerprint = computeAppliedRenderSnapshotFingerprint(snapshot);
    insertDeploymentRenderSnapshot(db, {
        snapshotFingerprint,
        deploymentId: D1,
        snapshotJson: serializeAppliedRenderSnapshot(snapshot),
        deleted: 0,
        createdAt: 4,
        updatedAt: 4,
    });
    const provenance = finalizeTargetFileRenderProvenance({
        schemaVersion: 1,
        appliedRenderSnapshotFingerprint: snapshotFingerprint,
        outputUnitFingerprint,
        materializationFingerprint: SHA_B,
        semanticRefFingerprints: [],
        sectionBindings: [],
    });
    upsertDeploymentFile(
        db,
        D1,
        relativePath,
        serializeDeploymentFileBaselineState({
            rowState: "active",
            appliedPayload: { contentKind: "text", contentHash: SHA_A, byteSize: 1 },
            appliedExecutable: false,
            provenance,
        }),
        "present",
        SHA_A,
        0,
        4,
        4,
    );
    return snapshotFingerprint;
}

function publishReservation(reservedPhysicalKeys: string[]): void {
    const oldBytes = new Uint8Array(Buffer.from("old", "utf-8"));
    const newBytes = new Uint8Array(Buffer.from("new", "utf-8"));
    publishJournal(transactionsRoot, {
        schemaVersion: 1,
        transactionId: TX1,
        deploymentId: D1,
        createdAt: 1,
        compilationFingerprint: SHA_A,
        reservedPhysicalKeys: [...reservedPhysicalKeys].sort(),
        entries: [
            {
                relativePath: "AGENTS.md",
                oldHash: sha256Bytes(oldBytes),
                oldBytesBase64: bytesToBase64(oldBytes),
                oldExecutable: false,
                oldProvenanceFingerprint: SHA_A,
                oldMaterializationFingerprint: SHA_A,
                newHash: sha256Bytes(newBytes),
                newBytesBase64: bytesToBase64(newBytes),
                newExecutable: false,
                newProvenanceFingerprint: SHA_B,
                newMaterializationFingerprint: SHA_B,
                isRemoval: false,
            },
        ],
    });
}

describe("Core durable source-read authority", () => {
    it("derives exact, equal-root, boundary-prefix, and boundary-descendant guards", () => {
        const seeded = seedActiveAuthority({
            relativePath: ".agents/AGENTS.md",
            boundaries: [".agents"],
        });
        const db = getDb();
        const project = deriveAdapterReadAuthorityContext({
            db,
            target: readTarget(),
            transactionsRoot,
        });
        expect(project.managedTargetGuards).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    matchKind: "exact_file",
                    relativePath: ".agents/AGENTS.md",
                    managementState: "active_managed",
                    appliedContentHash: SHA_A,
                }),
                expect.objectContaining({
                    matchKind: "directory_prefix",
                    relativePath: ".agents",
                    outputUnitFingerprint: seeded.outputUnitFingerprint,
                }),
            ]),
        );

        const exactFile = deriveAdapterReadAuthorityContext({
            db,
            target: readTarget(sourceRoot(path.join(targetRoot, ".agents", "AGENTS.md"))),
            transactionsRoot,
        });
        expect(exactFile.managedTargetGuards).toContainEqual(
            expect.objectContaining({
                matchKind: "entire_root",
                outputUnitFingerprint: seeded.outputUnitFingerprint,
            }),
        );

        const insideBoundary = deriveAdapterReadAuthorityContext({
            db,
            target: readTarget(sourceRoot(path.join(targetRoot, ".agents", "skills"))),
            transactionsRoot,
        });
        expect(insideBoundary.managedTargetGuards).toContainEqual(
            expect.objectContaining({
                matchKind: "entire_root",
                outputUnitFingerprint: seeded.outputUnitFingerprint,
            }),
        );
        expect(readAuthorityContextsAreExact(project, structuredClone(project))).toBe(true);
        expect(readAuthorityContextsAreExact(project, exactFile)).toBe(false);

        const disjoint = deriveAdapterReadAuthorityContext({
            db,
            target: readTarget(sourceRoot(path.join(sandbox, "different-project"))),
            transactionsRoot,
        });
        expect(disjoint.managedTargetGuards).toEqual([]);
    });

    it("does not project managed-target guards across platform instances", () => {
        seedActiveAuthority({ relativePath: "AGENTS.md" });
        getDb().prepare("UPDATE deployments SET platform_instance_id = ? WHERE deployment_id = ?").run("other-linux", D1);

        const authority = deriveAdapterReadAuthorityContext({
            db: getDb(),
            target: readTarget(),
            transactionsRoot,
        });

        expect(authority.managedTargetGuards).toEqual([]);
    });

    it("keeps deleted deployment/file and removed-baseline authority residual", () => {
        const seeded = seedActiveAuthority({
            relativePath: "AGENTS.md",
            deploymentDeleted: true,
            fileDeleted: true,
        });
        const db = getDb();
        const activeResidual = deriveAdapterReadAuthorityContext({
            db,
            target: readTarget(),
            transactionsRoot,
        });
        expect(activeResidual.managedTargetGuards).toContainEqual(
            expect.objectContaining({
                managementState: "residual_managed",
                matchKind: "exact_file",
            }),
        );

        db.prepare("DELETE FROM deployment_files").run();
        const residual = finalizeDeploymentResidualAuthority({
            schemaVersion: 1,
            deploymentId: D1,
            relativePath: "retired.md",
            appliedPayload: { contentKind: "text", contentHash: SHA_B, byteSize: 1 },
            appliedExecutable: false,
            previousProvenance: finalizeTargetFileRenderProvenance({
                schemaVersion: 1,
                appliedRenderSnapshotFingerprint: seeded.snapshotFingerprint,
                outputUnitFingerprint: seeded.outputUnitFingerprint,
                materializationFingerprint: SHA_B,
                semanticRefFingerprints: [],
                sectionBindings: [],
            }),
            removalIntentFingerprint: SHA_A,
        });
        insertDeploymentResidualAuthority(db, {
            residualAuthorityId: residual.residualAuthorityId,
            deploymentId: D1,
            relativePath: residual.relativePath,
            authorityBody: serializeDeploymentResidualAuthorityBody(residual),
            residualAuthorityFingerprint: residual.residualAuthorityFingerprint,
            deleted: 1,
            createdAt: 3,
            updatedAt: 3,
        });
        const result = deriveAdapterReadAuthorityContext({
            db,
            target: readTarget(),
            transactionsRoot,
        });
        expect(result.managedTargetGuards).toContainEqual(
            expect.objectContaining({
                relativePath: "retired.md",
                managementState: "residual_managed",
                appliedContentHash: SHA_B,
            }),
        );
    });

    it("rejects malformed durable IDs/paths and ignores a valid removed baseline row", () => {
        const db = seedDeployment();
        db.prepare("UPDATE deployments SET deployment_id = ? WHERE deployment_id = ?").run("not-a-uuid", D1);
        expect(() =>
            deriveAdapterReadAuthorityContext({
                db,
                target: readTarget(),
                transactionsRoot,
            }),
        ).toThrowError(/deployment id is invalid/);
        db.prepare("UPDATE deployments SET deployment_id = ? WHERE deployment_id = ?").run(D1, "not-a-uuid");
        db.prepare("UPDATE deployments SET target_root_path = ? WHERE deployment_id = ?").run("relative/root", D1);
        expect(() =>
            deriveAdapterReadAuthorityContext({
                db,
                target: readTarget(),
                transactionsRoot,
            }),
        ).toThrowError(/deployment target root is invalid/);

        db.prepare("DELETE FROM deployments").run();
        seedActiveAuthority({ relativePath: "AGENTS.md" });
        db.prepare("UPDATE deployment_files SET relative_path = ?").run("../escape.md");
        expect(() =>
            deriveAdapterReadAuthorityContext({
                db,
                target: readTarget(),
                transactionsRoot,
            }),
        ).toThrowError(/deployment file path is invalid/);
        db.prepare("UPDATE deployment_files SET relative_path = ?, baseline_state = ?").run(
            "AGENTS.md",
            serializeDeploymentFileBaselineState({
                rowState: "removed",
                latestResidualAuthorityId: SHA_B,
            }),
        );
        expect(
            deriveAdapterReadAuthorityContext({
                db,
                target: readTarget(),
                transactionsRoot,
            }).managedTargetGuards,
        ).toEqual([]);
    });

    it("fails closed when active provenance points to a never snapshot or absent output unit", () => {
        const seeded = seedActiveAuthority({ relativePath: "AGENTS.md" });
        const never: AppliedRenderSnapshotV1 = { schemaVersion: 1, snapshotState: "never" };
        replaceActiveBaselineSnapshot("AGENTS.md", seeded.outputUnitFingerprint, never);
        expect(() =>
            deriveAdapterReadAuthorityContext({
                db: getDb(),
                target: readTarget(),
                transactionsRoot,
            }),
        ).toThrowError(/never render snapshot/);

        const empty: Extract<AppliedRenderSnapshotV1, { snapshotState: "applied" }> = {
            schemaVersion: 1,
            snapshotState: "applied",
            renderInputFingerprint: SHA_A,
            compilerPolicyVersion: "core_render_policy_v1",
            selectionFingerprint: SHA_B,
            compilationFingerprint: SHA_A,
            promotionAuthorizations: [],
            decisions: [],
            outputUnits: [],
            outputUnitRenderers: [],
            semanticCoverageProofs: [],
        };
        replaceActiveBaselineSnapshot("AGENTS.md", seeded.outputUnitFingerprint, empty);
        expect(() =>
            deriveAdapterReadAuthorityContext({
                db: getDb(),
                target: readTarget(),
                transactionsRoot,
            }),
        ).toThrowError(/output unit is absent/);
    });

    it("uses Windows path grammar and skips durable authorities from another platform", () => {
        const windowsRoot = "C:\\oaam-project";
        seedActiveAuthority({
            relativePath: ".agents/AGENTS.md",
            platform: "win32",
            targetRootPath: windowsRoot,
        });
        expect(
            deriveAdapterReadAuthorityContext({
                db: getDb(),
                target: readTarget(),
                transactionsRoot,
            }).managedTargetGuards,
        ).toEqual([]);
        const windows = deriveAdapterReadAuthorityContext({
            db: getDb(),
            target: readTarget(sourceRoot(windowsRoot), "win32"),
            transactionsRoot,
        });
        expect(windows.managedTargetGuards).toContainEqual(
            expect.objectContaining({
                matchKind: "exact_file",
                relativePath: ".agents/AGENTS.md",
            }),
        );
    });

    it("turns intersecting journal file/parent reservations into honest in-flight guards", () => {
        const db = seedDeployment();
        const oldBytes = new Uint8Array(Buffer.from("old", "utf-8"));
        const newBytes = new Uint8Array(Buffer.from("new", "utf-8"));
        publishJournal(transactionsRoot, {
            schemaVersion: 1,
            transactionId: TX1,
            deploymentId: D1,
            createdAt: 1,
            compilationFingerprint: SHA_A,
            reservedPhysicalKeys: computePhysicalKeys("linux", targetRoot, ["", "AGENTS.md"]),
            entries: [
                {
                    relativePath: "AGENTS.md",
                    oldHash: sha256Bytes(oldBytes),
                    oldBytesBase64: bytesToBase64(oldBytes),
                    oldExecutable: false,
                    oldProvenanceFingerprint: SHA_A,
                    oldMaterializationFingerprint: SHA_A,
                    newHash: sha256Bytes(newBytes),
                    newBytesBase64: bytesToBase64(newBytes),
                    newExecutable: false,
                    newProvenanceFingerprint: SHA_B,
                    newMaterializationFingerprint: SHA_B,
                    isRemoval: false,
                },
            ],
        });
        const result = deriveAdapterReadAuthorityContext({
            db,
            target: readTarget(),
            transactionsRoot,
        });
        expect(result.reservationIdentityFingerprints).toHaveLength(1);
        expect(result.managedTargetGuards).toContainEqual(
            expect.objectContaining({
                managementState: "in_flight_managed",
                matchKind: "entire_root",
                reservationIdentityFingerprint: result.reservationIdentityFingerprints[0],
            }),
        );
        expect(
            result.managedTargetGuards.some(
                (guard) => "outputUnitFingerprint" in guard && guard.managementState === "in_flight_managed",
            ),
        ).toBe(false);
    });

    it("ignores other-platform/disjoint reservations and maps a nested reservation to a prefix", () => {
        const db = seedDeployment();
        publishReservation(["darwin\0/elsewhere/AGENTS.md", "win32\0C:\\outside\\AGENTS.md", "wsl\0/elsewhere/AGENTS.md"]);
        expect(
            deriveAdapterReadAuthorityContext({
                db,
                target: readTarget(),
                transactionsRoot,
            }).reservationIdentityFingerprints,
        ).toEqual([]);

        fs.rmSync(transactionsRoot, { recursive: true, force: true });
        publishReservation(["linux\0/elsewhere/AGENTS.md"]);
        expect(
            deriveAdapterReadAuthorityContext({
                db,
                target: readTarget(),
                transactionsRoot,
            }).reservationIdentityFingerprints,
        ).toEqual([]);

        fs.rmSync(transactionsRoot, { recursive: true, force: true });
        publishReservation([`linux\0${path.join(targetRoot, "nested", "AGENTS.md")}`]);
        const nested = deriveAdapterReadAuthorityContext({
            db,
            target: readTarget(),
            transactionsRoot,
        });
        expect(nested.managedTargetGuards).toContainEqual(
            expect.objectContaining({
                matchKind: "directory_prefix",
                relativePath: "nested/AGENTS.md",
                managementState: "in_flight_managed",
            }),
        );
    });

    it("fails closed when a shape-valid journal carries a non-absolute physical key", () => {
        const db = seedDeployment();
        publishReservation(["linux\0relative/AGENTS.md"]);
        expect(() =>
            deriveAdapterReadAuthorityContext({
                db,
                target: readTarget(),
                transactionsRoot,
            }),
        ).toThrowError(/journal physical reservation key is invalid/);
    });

    it("fails closed for corrupt journal and corrupt durable deployment provenance", () => {
        const db = seedDeployment();
        fs.mkdirSync(path.join(transactionsRoot, TX1), { recursive: true });
        fs.writeFileSync(path.join(transactionsRoot, TX1, "journal.json"), "not-json");
        expect(() =>
            deriveAdapterReadAuthorityContext({
                db,
                target: readTarget(),
                transactionsRoot,
            }),
        ).toThrowError(
            expect.objectContaining<Partial<SourceReadAuthorityError>>({
                code: "read_authority.corrupt_journal",
            }),
        );

        fs.rmSync(transactionsRoot, { recursive: true, force: true });
        db.prepare("DELETE FROM deployments").run();
        seedActiveAuthority({ relativePath: "AGENTS.md" });
        db.prepare("DELETE FROM deployment_render_snapshots").run();
        expect(() =>
            deriveAdapterReadAuthorityContext({
                db,
                target: readTarget(),
                transactionsRoot,
            }),
        ).toThrowError(
            expect.objectContaining<Partial<SourceReadAuthorityError>>({
                code: "read_authority.durable_state_corrupt",
            }),
        );
    });

    it("supports a Core-resolved user root and rejects ambiguous root selection", () => {
        const db = seedDeployment();
        const root = sourceRoot();
        const selected: AdapterReadTarget = {
            adapterId: ADAPTER,
            sourceSelector: {
                selectorKind: "user_selected_root",
                platformContext: {
                    platform: "linux",
                    platformInstanceId: "local",
                    accessRootPath: "/",
                },
                binding: { sourceRoot: root, assetScope: "project", projectRootPath: targetRoot },
            },
        };
        expect(
            deriveAdapterReadAuthorityContext({
                db,
                target: selected,
                transactionsRoot,
            }).managedTargetGuards,
        ).toEqual([]);

        const windowsHostedWsl = structuredClone(selected);
        if (windowsHostedWsl.sourceSelector.selectorKind !== "user_selected_root") throw new Error("fixture");
        windowsHostedWsl.sourceSelector.platformContext = {
            platform: "wsl",
            platformInstanceId: "Ubuntu",
            accessRootPath: "\\\\wsl.localhost\\Ubuntu\\home\\example",
        };
        windowsHostedWsl.sourceSelector.binding.sourceRoot.path = "\\\\wsl.localhost\\Ubuntu\\home\\example\\project\\.agents";
        expect(
            deriveAdapterReadAuthorityContext({
                db,
                target: windowsHostedWsl,
                transactionsRoot,
            }).managedTargetGuards,
        ).toEqual([]);
        windowsHostedWsl.sourceSelector.binding.sourceRoot.path = "/home/example/project/.agents";
        expect(() =>
            deriveAdapterReadAuthorityContext({
                db,
                target: windowsHostedWsl,
                transactionsRoot,
            }),
        ).toThrowError(
            expect.objectContaining<Partial<SourceReadAuthorityError>>({
                code: "read_authority.selected_root_invalid",
            }),
        );
        windowsHostedWsl.sourceSelector.binding.sourceRoot.path = "\\\\wsl.localhost\\Debian\\home\\example\\.agents";
        expect(() =>
            deriveAdapterReadAuthorityContext({
                db,
                target: windowsHostedWsl,
                transactionsRoot,
            }),
        ).toThrowError(
            expect.objectContaining<Partial<SourceReadAuthorityError>>({
                code: "read_authority.selected_root_invalid",
            }),
        );

        const duplicate = readTarget();
        if (duplicate.sourceSelector.selectorKind !== "probe_roots") throw new Error("fixture");
        duplicate.sourceSelector.sourceRootIds.push("root-1");
        expect(() =>
            deriveAdapterReadAuthorityContext({
                db,
                target: duplicate,
                transactionsRoot,
            }),
        ).toThrowError(
            expect.objectContaining<Partial<SourceReadAuthorityError>>({
                code: "read_authority.selected_root_duplicate",
            }),
        );
        duplicate.sourceSelector.sourceRootIds = ["missing"];
        expect(() =>
            deriveAdapterReadAuthorityContext({
                db,
                target: duplicate,
                transactionsRoot,
            }),
        ).toThrowError(
            expect.objectContaining<Partial<SourceReadAuthorityError>>({
                code: "read_authority.selected_root_missing",
            }),
        );
        expect(() =>
            deriveAdapterReadAuthorityContext({
                db,
                target: selected,
                transactionsRoot: "",
            }),
        ).toThrowError(
            expect.objectContaining<Partial<SourceReadAuthorityError>>({
                code: "read_authority.transactions_root_missing",
            }),
        );

        const invalidRoot = structuredClone(selected);
        if (invalidRoot.sourceSelector.selectorKind !== "user_selected_root") {
            throw new Error("user-selected fixture expected");
        }
        invalidRoot.sourceSelector.binding.sourceRoot.path = "relative/root";
        expect(() =>
            deriveAdapterReadAuthorityContext({
                db,
                target: invalidRoot,
                transactionsRoot,
            }),
        ).toThrowError(
            expect.objectContaining<Partial<SourceReadAuthorityError>>({
                code: "read_authority.selected_root_invalid",
            }),
        );
    });
});
