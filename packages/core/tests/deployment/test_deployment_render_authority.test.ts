import { describe, expect, it } from "vitest";
import type {
    AppliedRenderDecisionV1,
    AppliedRenderSnapshotV1,
    DeploymentFileAuthorityProjectionInputV1,
    RenderOutputUnit,
    RequiredRenderSemantic,
    ResolvedPromotionAuthorization,
    SelectedOutputUnitRenderer,
} from "../../src/contracts/deployment-authority";
import type { Sha256Digest } from "../../src/contracts/primitives";
import {
    finalizeDeploymentResidualAuthority,
    finalizeTargetFileRenderProvenance,
    makeRemovalIntentFingerprint,
    parseAppliedInputsSnapshot,
    parseAppliedRenderSnapshot,
    parseAppliedRenderSnapshotRef,
    parseDeploymentFileBaselineState,
    parseDeploymentResidualAuthority,
    parseDeploymentResidualAuthorityRow,
    projectDeploymentFileAuthority,
    serializeAppliedRenderSnapshot,
    serializeAppliedInputsSnapshot,
    serializeAppliedRenderSnapshotRef,
    serializeDeploymentFileBaselineState,
    serializeDeploymentResidualAuthority,
    validateAppliedRenderSnapshot,
    validateAppliedInputsSnapshot,
    validateAppliedRenderSnapshotRef,
    validateDeploymentFileBaselineState,
    validateDeploymentResidualAuthority,
    validateTargetFileRenderProvenance,
} from "../../src/render/deployment-render-authority";
import {
    computeAppliedRenderSnapshotFingerprint,
    computeDeploymentResidualAuthorityFingerprint,
    computeRenderOutputUnitFingerprint,
    computeSemanticRefFingerprint,
} from "../../src/foundation/fingerprint";

const DEPLOYMENT_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const FILE_ID = "44444444-4444-4444-8444-444444444444";
const PROJECT_ID = "55555555-5555-4555-8555-555555555555";
const SHA_A = `sha256:${"a".repeat(64)}` as Sha256Digest;
const SHA_B = `sha256:${"b".repeat(64)}` as Sha256Digest;
const SHA_C = `sha256:${"c".repeat(64)}` as Sha256Digest;
const SHA_D = `sha256:${"d".repeat(64)}` as Sha256Digest;

function makeSemantic(
    subject: RequiredRenderSemantic["subject"] = {
        subjectKind: "asset",
        assetId: ASSET_ID,
        versionId: VERSION_ID,
    },
    semanticKind: RequiredRenderSemantic["semanticKind"] = "guidance.content",
): RequiredRenderSemantic {
    const preimage = {
        consumerAgentRuntimeId: "CLAUDE_CODE_CLI",
        subject,
        semanticKind,
    };
    return { ...preimage, semanticRefFingerprint: computeSemanticRefFingerprint(preimage) };
}

function makeUnit(relativePath = "CLAUDE.md"): RenderOutputUnit {
    const preimage = {
        outputContractId: "claude-guidance-v1",
        outputContractFingerprint: SHA_A,
        claims: [{ relativePath, contentKind: "text" as const, executable: false }],
        managedDirectoryBoundaries: [{ relativePath: ".claude", boundaryKind: "directory_inventory" as const }],
    };
    return { ...preimage, outputUnitFingerprint: computeRenderOutputUnitFingerprint(preimage) };
}

function makeAppliedSnapshot(): AppliedRenderSnapshotV1 {
    const semantics = [
        makeSemantic(),
        makeSemantic({ subjectKind: "file", assetId: ASSET_ID, versionId: VERSION_ID, fileId: FILE_ID }, "asset.file_inventory"),
        makeSemantic(
            {
                subjectKind: "missing_required_file_role",
                assetId: ASSET_ID,
                versionId: VERSION_ID,
                fileRole: "entry",
            },
            "guidance.base_context",
        ),
    ].sort((left, right) => left.semanticRefFingerprint.localeCompare(right.semanticRefFingerprint));
    const units = [makeUnit("CLAUDE.md"), makeUnit(".claude/context.md")].sort((left, right) =>
        left.outputUnitFingerprint.localeCompare(right.outputUnitFingerprint),
    );
    const decisions: AppliedRenderDecisionV1[] = [
        {
            semanticRef: semantics[0] as RequiredRenderSemantic,
            consumerOwnerAdapterId: "claudecode",
            consumerOwnerAdapterVersion: "1.0.0",
            optionFingerprint: SHA_A,
            renderStrategy: "native_file",
            approval: { approvalState: "not_required" },
            actualReverseExtractPolicy: "can_reconcile",
            outputUnitFingerprints: [units[0]?.outputUnitFingerprint as Sha256Digest],
            outcome: "preserved",
        },
        {
            semanticRef: semantics[1] as RequiredRenderSemantic,
            consumerOwnerAdapterId: "claudecode",
            consumerOwnerAdapterVersion: "1.0.0",
            optionFingerprint: SHA_B,
            renderStrategy: "inline",
            approval: {
                approvalState: "approved",
                approvalSource: "one_time_user_approval",
                userActionEvidenceId: "ua-once",
                resolvedAt: 10,
                approvalFingerprint: SHA_C,
            },
            actualReverseExtractPolicy: "ignore_generated_wrapper",
            outputUnitFingerprints: [units[1]?.outputUnitFingerprint as Sha256Digest],
            outcome: "degraded",
            degradationKinds: ["runtime_specific_metadata_lost"],
            degradationFingerprint: SHA_D,
        },
        {
            semanticRef: semantics[2] as RequiredRenderSemantic,
            consumerOwnerAdapterId: "claudecode",
            consumerOwnerAdapterVersion: "1.0.0",
            optionFingerprint: SHA_C,
            renderStrategy: "reference_with_intro",
            approval: {
                approvalState: "approved",
                approvalSource: "saved_user_policy",
                policyId: "policy-1",
                policyRevision: 2,
                resolvedAt: 11,
                approvalFingerprint: SHA_D,
            },
            actualReverseExtractPolicy: "unsupported",
            outputUnitFingerprints: [],
            outcome: "degraded",
            degradationKinds: ["memory_semantics_lost", "reverse_extract_pollution_risk"],
            degradationFingerprint: SHA_A,
        },
    ].sort((left, right) => left.semanticRef.semanticRefFingerprint.localeCompare(right.semanticRef.semanticRefFingerprint));
    const promotionAuthorizations: ResolvedPromotionAuthorization[] = [
        {
            promotionAuthorizationState: "not_required",
            assetId: ASSET_ID,
            versionId: VERSION_ID,
            target: { targetKind: "project", projectId: PROJECT_ID },
            versionOriginAuthorityFingerprint: SHA_A,
        },
        ...(["version_target_grant", "asset_all_versions_target_grant", "restricted_source_full_access"] as const).map(
            (authorizationSource, index): ResolvedPromotionAuthorization => ({
                promotionAuthorizationState: "authorized",
                assetId: ASSET_ID,
                versionId: `66666666-6666-4666-8${index}66-666666666666`,
                target: { targetKind: "global_target", targetAuthorityFingerprint: SHA_B },
                versionOriginAuthorityFingerprint: SHA_C,
                authorizationSource,
                authorityId: `authority-${index}`,
                authorityRevision: index + 1,
                authorityFingerprint: SHA_D,
            }),
        ),
    ].sort((left, right) => authorizationKey(left).localeCompare(authorizationKey(right)));
    const outputUnitRenderers: SelectedOutputUnitRenderer[] = units.map((unit) => ({
        outputUnitFingerprint: unit.outputUnitFingerprint,
        rendererAdapterId: "claudecode",
        rendererAdapterVersion: "1.0.0",
        materializerCapabilityKey: "guidance.native",
        materializationProfileId: "default",
        profileConstraintFingerprint: SHA_A,
    }));
    return {
        schemaVersion: 1,
        snapshotState: "applied",
        renderInputFingerprint: SHA_A,
        compilerPolicyVersion: "core_render_policy_v1",
        selectionFingerprint: SHA_B,
        compilationFingerprint: SHA_C,
        promotionAuthorizations,
        decisions,
        outputUnits: units,
        outputUnitRenderers,
        semanticCoverageProofs: units.map((unit) => ({
            outputUnitFingerprint: unit.outputUnitFingerprint,
            coveredSemanticRefFingerprints: semantics.map((semantic) => semantic.semanticRefFingerprint).sort(),
            coverageFingerprint: SHA_D,
        })),
    };
}

function authorizationKey(value: ResolvedPromotionAuthorization): string {
    const target =
        value.target.targetKind === "project"
            ? `project:${value.target.projectId}`
            : `global:${value.target.targetAuthorityFingerprint}`;
    return `${value.assetId}\0${value.versionId}\0${target}`;
}

function makeProvenance() {
    return finalizeTargetFileRenderProvenance({
        schemaVersion: 1,
        appliedRenderSnapshotFingerprint: SHA_A,
        outputUnitFingerprint: SHA_B,
        materializationFingerprint: SHA_C,
        semanticRefFingerprints: [SHA_A, SHA_B],
        sectionBindings: [
            { sectionHandle: "body", semanticRefFingerprints: [SHA_A] },
            { sectionHandle: "footer", semanticRefFingerprints: [SHA_B] },
        ],
    });
}

describe("Deployment render authority strict codecs", () => {
    it("round-trips strict applied inputs and rejects owner, case and duplicate corruption", () => {
        const snapshot = {
            schemaVersion: 1 as const,
            deploymentId: DEPLOYMENT_ID,
            consumerAgentRuntimeIds: ["ANTIGRAVITY_APP", "CLAUDE_CODE_CLI"],
            assets: [{ assetId: ASSET_ID, versionId: VERSION_ID, allowIncomplete: false }],
        };
        expect(parseAppliedInputsSnapshot(serializeAppliedInputsSnapshot(snapshot), DEPLOYMENT_ID)).toEqual(snapshot);
        expect(() => parseAppliedInputsSnapshot(serializeAppliedInputsSnapshot(snapshot), PROJECT_ID)).toThrow(/does not belong/);
        expect(() =>
            validateAppliedInputsSnapshot({
                ...snapshot,
                consumerAgentRuntimeIds: ["claude_code_cli"],
            }),
        ).toThrow(/uppercase/);
        expect(() =>
            validateAppliedInputsSnapshot({
                ...snapshot,
                assets: [...snapshot.assets, { ...snapshot.assets[0] }],
            }),
        ).toThrow(/assetId must be unique/);
        expect(() => validateAppliedInputsSnapshot({ ...snapshot, schemaVersion: 2 })).toThrow(/schemaVersion/);
    });

    it("round-trips never/applied snapshots and binds exact expected fingerprints", () => {
        const never: AppliedRenderSnapshotV1 = { schemaVersion: 1, snapshotState: "never" };
        expect(parseAppliedRenderSnapshot(serializeAppliedRenderSnapshot(never))).toEqual(never);
        expect(computeAppliedRenderSnapshotFingerprint(never)).toBe(
            "sha256:91a45e72a59c2cefe344c06edd76a7985e8f3afb3065215174d07d73f5e28890",
        );
        expect(() => parseAppliedRenderSnapshot(serializeAppliedRenderSnapshot(never), SHA_A)).toThrow(/fingerprint mismatch/);

        const applied = makeAppliedSnapshot();
        const fingerprint = computeAppliedRenderSnapshotFingerprint(applied);
        expect(parseAppliedRenderSnapshot(serializeAppliedRenderSnapshot(applied), fingerprint)).toEqual(applied);

        const emptyApplied: AppliedRenderSnapshotV1 = {
            schemaVersion: 1,
            snapshotState: "applied",
            renderInputFingerprint: SHA_A,
            compilerPolicyVersion: "core_render_policy_v1",
            selectionFingerprint: SHA_B,
            compilationFingerprint: SHA_C,
            promotionAuthorizations: [],
            decisions: [],
            outputUnits: [],
            outputUnitRenderers: [],
            semanticCoverageProofs: [],
        };
        expect(parseAppliedRenderSnapshot(serializeAppliedRenderSnapshot(emptyApplied))).toEqual(emptyApplied);
        expect(
            parseAppliedRenderSnapshot(
                '{"snapshotState":"never","schemaVersion":1}',
                computeAppliedRenderSnapshotFingerprint(never),
            ),
        ).toEqual(never);
    });

    it("round-trips one exact V2 managed-directory graph and rejects malformed directory authority", () => {
        const applied = makeAppliedSnapshot() as Extract<AppliedRenderSnapshotV1, { snapshotState: "applied" }>;
        const previous = applied.outputUnits[0]!;
        const preimage = {
            outputContractId: previous.outputContractId,
            outputContractFingerprint: previous.outputContractFingerprint,
            claims: previous.claims,
            managedDirectoryBoundaries: [
                {
                    schemaVersion: 2 as const,
                    relativePath: ".claude" as const,
                    boundaryKind: "directory_inventory" as const,
                    desiredDirectoryPaths: [".claude", ".claude/empty"] as const,
                },
            ],
        };
        const next: RenderOutputUnit = {
            ...preimage,
            outputUnitFingerprint: computeRenderOutputUnitFingerprint(preimage),
        };
        applied.outputUnits[0] = next;
        applied.outputUnits.sort((left, right) => left.outputUnitFingerprint.localeCompare(right.outputUnitFingerprint));
        for (const decision of applied.decisions) {
            decision.outputUnitFingerprints = decision.outputUnitFingerprints
                .map((fingerprint) => (fingerprint === previous.outputUnitFingerprint ? next.outputUnitFingerprint : fingerprint))
                .sort();
        }
        for (const renderer of applied.outputUnitRenderers) {
            if (renderer.outputUnitFingerprint === previous.outputUnitFingerprint) {
                renderer.outputUnitFingerprint = next.outputUnitFingerprint;
            }
        }
        applied.outputUnitRenderers.sort((left, right) => left.outputUnitFingerprint.localeCompare(right.outputUnitFingerprint));
        for (const proof of applied.semanticCoverageProofs) {
            if (proof.outputUnitFingerprint === previous.outputUnitFingerprint) {
                proof.outputUnitFingerprint = next.outputUnitFingerprint;
            }
        }
        applied.semanticCoverageProofs.sort((left, right) =>
            left.outputUnitFingerprint.localeCompare(right.outputUnitFingerprint),
        );
        expect(parseAppliedRenderSnapshot(serializeAppliedRenderSnapshot(applied))).toEqual(applied);

        for (const desiredDirectoryPaths of [
            null,
            [],
            ["../unsafe"],
            [".claude", ".claude/z", ".claude/a"],
            [".claude", ".claude/empty", ".claude/empty"],
            [".claude", "other"],
        ]) {
            const invalid = structuredClone(applied);
            const boundary = invalid.outputUnits.find((unit) => unit.outputUnitFingerprint === next.outputUnitFingerprint)!
                .managedDirectoryBoundaries[0]!;
            if (!("desiredDirectoryPaths" in boundary)) throw new Error("V2 boundary fixture is missing");
            boundary.desiredDirectoryPaths = desiredDirectoryPaths as never;
            expect(() => validateAppliedRenderSnapshot(invalid)).toThrow();
        }
    });

    it("round-trips strict snapshot references and rejects unknown branches/fields", () => {
        for (const ref of [
            { snapshotState: "never" as const },
            { snapshotState: "applied" as const, snapshotFingerprint: SHA_A },
        ]) {
            expect(parseAppliedRenderSnapshotRef(serializeAppliedRenderSnapshotRef(ref))).toEqual(ref);
        }
        for (const invalid of [
            null,
            { snapshotState: "never", extra: true },
            { snapshotState: "applied", snapshotFingerprint: "bad" },
            { snapshotState: "other" },
        ]) {
            expect(() => validateAppliedRenderSnapshotRef(invalid)).toThrow();
        }
    });

    it("finalizes exact file provenance and residual identities and round-trips both baseline branches", () => {
        const provenance = makeProvenance();
        expect(() => validateTargetFileRenderProvenance(provenance)).not.toThrow();
        const removalIntentFingerprint = makeRemovalIntentFingerprint({
            deploymentId: DEPLOYMENT_ID,
            relativePath: "CLAUDE.md",
            previousProvenanceFingerprint: provenance.provenanceFingerprint,
            nextCompilationFingerprint: SHA_B,
            reason: "absent_from_new_desired_set",
        });
        expect(
            makeRemovalIntentFingerprint({
                deploymentId: DEPLOYMENT_ID,
                relativePath: "AGENTS.md",
                previousProvenanceFingerprint: SHA_A,
                nextCompilationFingerprint: SHA_B,
                reason: "absent_from_new_desired_set",
            }),
        ).toBe("sha256:3e58e493d2850749bd53e03c40d97ac4a04fc9570cb85b42e9c6d5b89bc6c1f4");
        const residual = finalizeDeploymentResidualAuthority({
            schemaVersion: 1,
            deploymentId: DEPLOYMENT_ID,
            relativePath: "CLAUDE.md",
            appliedPayload: { contentKind: "text", contentHash: SHA_A, byteSize: 12 },
            appliedExecutable: false,
            previousProvenance: provenance,
            removalIntentFingerprint,
        });
        expect(parseDeploymentResidualAuthority(serializeDeploymentResidualAuthority(residual))).toEqual(residual);
        expect(() => validateDeploymentResidualAuthority(residual)).not.toThrow();

        const active = {
            rowState: "active" as const,
            appliedPayload: { contentKind: "text" as const, contentHash: SHA_A, byteSize: 12 },
            appliedExecutable: false,
            provenance,
        };
        const removed = {
            rowState: "removed" as const,
            latestResidualAuthorityId: residual.residualAuthorityId,
        };
        expect(parseDeploymentFileBaselineState(serializeDeploymentFileBaselineState(active))).toEqual(active);
        expect(parseDeploymentFileBaselineState(serializeDeploymentFileBaselineState(removed))).toEqual(removed);
    });

    it("rejects a malformed residual row body branch", () => {
        const provenance = makeProvenance();
        const residual = finalizeDeploymentResidualAuthority({
            schemaVersion: 1,
            deploymentId: DEPLOYMENT_ID,
            relativePath: "CLAUDE.md",
            appliedPayload: { contentKind: "text", contentHash: SHA_A, byteSize: 1 },
            appliedExecutable: false,
            previousProvenance: provenance,
            removalIntentFingerprint: SHA_B,
        });
        expect(() =>
            parseDeploymentResidualAuthorityRow({
                residualAuthorityId: residual.residualAuthorityId,
                residualAuthorityFingerprint: residual.residualAuthorityFingerprint,
                deploymentId: DEPLOYMENT_ID,
                relativePath: "CLAUDE.md",
                authorityBody: JSON.stringify({
                    schemaVersion: 2,
                    appliedPayload: residual.appliedPayload,
                    appliedExecutable: false,
                    previousProvenance: provenance,
                    removalIntentFingerprint: SHA_B,
                }),
            }),
        ).toThrow(/schemaVersion/);
    });

    it("projects only physically valid active/present, active/missing, and removed/missing rows", () => {
        const provenance = makeProvenance();
        const base = {
            deploymentFileId: "deployment-file-id",
            relativePath: "CLAUDE.md",
            observedAt: 3,
            createdAt: 1,
            updatedAt: 2,
        };
        const active = {
            rowState: "active" as const,
            appliedPayload: { contentKind: "text" as const, contentHash: SHA_A, byteSize: 12 },
            appliedExecutable: false,
            provenance,
        };
        for (const observation of [
            { observedState: "present" as const, observedContentHash: SHA_A, observedExecutable: false },
            { observedState: "missing" as const },
        ]) {
            expect(projectDeploymentFileAuthority({ ...base, baselineState: active, observation })).toMatchObject({
                rowState: "active",
                observation,
            });
        }
        const removedInput: DeploymentFileAuthorityProjectionInputV1 = {
            ...base,
            baselineState: { rowState: "removed", latestResidualAuthorityId: SHA_B },
            observation: { observedState: "missing" },
        };
        expect(projectDeploymentFileAuthority(removedInput)).toMatchObject({ rowState: "removed" });
        expect(() =>
            projectDeploymentFileAuthority({
                ...removedInput,
                observation: {
                    observedState: "present",
                    observedContentHash: SHA_A,
                    observedExecutable: false,
                },
            }),
        ).toThrow(/must be observed missing/);
    });

    it("rejects ordering, closure, reference, and recomputable fingerprint corruption", () => {
        const applied = makeAppliedSnapshot();
        const invalid: AppliedRenderSnapshotV1[] = [];
        const reversedDecisions = structuredClone(applied);
        if (reversedDecisions.snapshotState === "applied") reversedDecisions.decisions.reverse();
        invalid.push(reversedDecisions);
        const missingRenderer = structuredClone(applied);
        if (missingRenderer.snapshotState === "applied") missingRenderer.outputUnitRenderers.pop();
        invalid.push(missingRenderer);
        const missingProof = structuredClone(applied);
        if (missingProof.snapshotState === "applied") missingProof.semanticCoverageProofs.pop();
        invalid.push(missingProof);
        const unknownUnit = structuredClone(applied);
        if (unknownUnit.snapshotState === "applied") unknownUnit.decisions[0]?.outputUnitFingerprints.push(SHA_D);
        invalid.push(unknownUnit);
        const badSemantic = structuredClone(applied);
        if (badSemantic.snapshotState === "applied") {
            const semantic = badSemantic.decisions[0]?.semanticRef;
            if (semantic !== undefined) semantic.semanticKind = "memory.content";
        }
        invalid.push(badSemantic);
        const badUnit = structuredClone(applied);
        if (badUnit.snapshotState === "applied") badUnit.outputUnits[0]!.claims[0]!.executable = true;
        invalid.push(badUnit);
        for (const item of invalid) expect(() => validateAppliedRenderSnapshot(item)).toThrow();
    });

    it("rejects malformed snapshot branches rather than accepting partial JSON", () => {
        const applied = makeAppliedSnapshot() as Extract<AppliedRenderSnapshotV1, { snapshotState: "applied" }>;
        const invalid: unknown[] = [
            null,
            { schemaVersion: 1, snapshotState: "never", extra: true },
            { schemaVersion: 2, snapshotState: "never" },
            { schemaVersion: 1, snapshotState: "other" },
            { ...applied, extra: true },
            { ...applied, schemaVersion: 2 },
            { ...applied, renderInputFingerprint: "bad" },
            { ...applied, compilerPolicyVersion: "other" },
            { ...applied, selectionFingerprint: "bad" },
            { ...applied, compilationFingerprint: "bad" },
            { ...applied, promotionAuthorizations: null },
            { ...applied, decisions: null },
            { ...applied, outputUnits: null },
            { ...applied, outputUnitRenderers: null },
            { ...applied, semanticCoverageProofs: null },
        ];
        for (const item of invalid) expect(() => validateAppliedRenderSnapshot(item)).toThrow();
    });

    it("rejects strict baseline/provenance/residual/removal/projection corruption", () => {
        const provenance = makeProvenance();
        for (const invalid of [
            null,
            { ...provenance, extra: true },
            { ...provenance, schemaVersion: 2 },
            { ...provenance, provenanceFingerprint: "bad" },
            { ...provenance, appliedRenderSnapshotFingerprint: "bad" },
            { ...provenance, outputUnitFingerprint: "bad" },
            { ...provenance, materializationFingerprint: "bad" },
            { ...provenance, semanticRefFingerprints: null },
            { ...provenance, semanticRefFingerprints: [SHA_B, SHA_A] },
            { ...provenance, sectionBindings: null },
            { ...provenance, sectionBindings: [...provenance.sectionBindings].reverse() },
            {
                ...provenance,
                sectionBindings: [{ sectionHandle: "x", semanticRefFingerprints: [SHA_D] }],
            },
            { ...provenance, materializationFingerprint: SHA_D },
        ]) {
            expect(() => validateTargetFileRenderProvenance(invalid)).toThrow();
        }

        const validResidual = finalizeDeploymentResidualAuthority({
            schemaVersion: 1,
            deploymentId: DEPLOYMENT_ID,
            relativePath: "CLAUDE.md",
            appliedPayload: { contentKind: "binary", contentHash: SHA_A, byteSize: 0 },
            appliedExecutable: true,
            previousProvenance: provenance,
            removalIntentFingerprint: SHA_B,
        });
        for (const invalid of [
            null,
            { ...validResidual, extra: true },
            { ...validResidual, residualAuthorityId: SHA_A },
            { ...validResidual, residualAuthorityFingerprint: SHA_A },
            { ...validResidual, deploymentId: "bad" },
            { ...validResidual, relativePath: "../escape" },
            { ...validResidual, appliedPayload: null },
            { ...validResidual, appliedExecutable: "no" },
            { ...validResidual, previousProvenance: null },
            { ...validResidual, removalIntentFingerprint: "bad" },
            (() => {
                const sameIdDifferentBody = { ...validResidual, appliedExecutable: false };
                const { residualAuthorityFingerprint: _old, ...preimage } = sameIdDifferentBody;
                sameIdDifferentBody.residualAuthorityFingerprint = computeDeploymentResidualAuthorityFingerprint(preimage);
                return sameIdDifferentBody;
            })(),
        ]) {
            expect(() => validateDeploymentResidualAuthority(invalid)).toThrow();
        }

        for (const invalid of [
            null,
            { rowState: "other" },
            { rowState: "active", appliedPayload: null, appliedExecutable: false, provenance },
            {
                rowState: "active",
                appliedPayload: { contentKind: "text", contentHash: SHA_A, byteSize: 1 },
                appliedExecutable: "no",
                provenance,
            },
            { rowState: "removed", latestResidualAuthorityId: "bad" },
        ]) {
            expect(() => validateDeploymentFileBaselineState(invalid)).toThrow();
        }

        expect(() =>
            makeRemovalIntentFingerprint({
                deploymentId: DEPLOYMENT_ID,
                relativePath: "CLAUDE.md",
                previousProvenanceFingerprint: SHA_A,
                nextCompilationFingerprint: SHA_B,
                reason: "other" as never,
            }),
        ).toThrow(/reason/);
        const activeInput = {
            deploymentFileId: " ",
            relativePath: "../bad",
            baselineState: {
                rowState: "active" as const,
                appliedPayload: { contentKind: "text" as const, contentHash: SHA_A, byteSize: 1 },
                appliedExecutable: false,
                provenance,
            },
            observation: { observedState: "missing" as const },
            observedAt: -1,
            createdAt: -1,
            updatedAt: -1,
        };
        expect(() => projectDeploymentFileAuthority(activeInput)).toThrow();
    });

    it("rejects every strict discriminant and scalar invariant at its owning branch", () => {
        const snapshot = makeAppliedSnapshot() as Extract<AppliedRenderSnapshotV1, { snapshotState: "applied" }>;
        const mutateSnapshot = (mutate: (copy: typeof snapshot) => void): void => {
            const copy = structuredClone(snapshot);
            mutate(copy);
            expect(() => validateAppliedRenderSnapshot(copy)).toThrow();
        };
        mutateSnapshot((copy) => {
            copy.decisions[0]!.semanticRef.subject = {
                subjectKind: "missing_required_file_role",
                assetId: ASSET_ID,
                versionId: VERSION_ID,
                fileRole: "resource" as never,
            };
        });
        mutateSnapshot((copy) => {
            copy.decisions[0]!.semanticRef.subject = { subjectKind: "other" } as never;
        });
        mutateSnapshot((copy) => {
            copy.promotionAuthorizations[0]!.promotionAuthorizationState = "other" as never;
        });
        mutateSnapshot((copy) => {
            copy.promotionAuthorizations[0]!.target = { targetKind: "other" } as never;
        });
        mutateSnapshot((copy) => {
            copy.decisions[0]!.outcome = "other" as never;
        });
        mutateSnapshot((copy) => {
            const degraded = copy.decisions.find((decision) => decision.outcome === "degraded");
            if (degraded?.outcome === "degraded") degraded.degradationKinds = [] as never;
        });
        mutateSnapshot((copy) => {
            copy.decisions[0]!.approval = { approvalState: "other" } as never;
        });
        mutateSnapshot((copy) => {
            copy.decisions[0]!.approval = {
                approvalState: "approved",
                approvalSource: "other",
            } as never;
        });
        mutateSnapshot((copy) => {
            const saved = copy.decisions.find(
                (decision) =>
                    decision.approval.approvalState === "approved" && decision.approval.approvalSource === "saved_user_policy",
            );
            if (saved?.approval.approvalState === "approved" && saved.approval.approvalSource === "saved_user_policy") {
                saved.approval.policyRevision = 0;
            }
        });
        mutateSnapshot((copy) => {
            const approved = copy.decisions.find((decision) => decision.approval.approvalState === "approved");
            if (approved?.approval.approvalState === "approved") approved.approval.resolvedAt = -1;
        });
        mutateSnapshot((copy) => {
            copy.outputUnits[0]!.managedDirectoryBoundaries[0]!.boundaryKind = "other" as never;
        });
        mutateSnapshot((copy) => {
            copy.decisions[0]!.semanticRef.semanticKind = "other" as never;
        });
        mutateSnapshot((copy) => {
            copy.outputUnits[0]!.claims[0]!.contentKind = 1 as never;
        });

        const provenance = makeProvenance();
        expect(() =>
            finalizeDeploymentResidualAuthority({
                schemaVersion: 2 as never,
                deploymentId: DEPLOYMENT_ID,
                relativePath: "CLAUDE.md",
                appliedPayload: { contentKind: "text", contentHash: SHA_A, byteSize: 1 },
                appliedExecutable: false,
                previousProvenance: provenance,
                removalIntentFingerprint: SHA_B,
            }),
        ).toThrow(/schemaVersion/);
        expect(() =>
            validateDeploymentFileBaselineState({
                rowState: "active",
                appliedPayload: { contentKind: "text", contentHash: SHA_A, byteSize: -1 },
                appliedExecutable: false,
                provenance,
            }),
        ).toThrow(/byteSize/);
        expect(() =>
            projectDeploymentFileAuthority({
                deploymentFileId: "id",
                relativePath: "CLAUDE.md",
                baselineState: {
                    rowState: "active",
                    appliedPayload: { contentKind: "text", contentHash: SHA_A, byteSize: 1 },
                    appliedExecutable: false,
                    provenance,
                },
                observation: { observedState: "other" } as never,
                observedAt: 0,
                createdAt: 0,
                updatedAt: 0,
            }),
        ).toThrow(/observedState/);
        for (const timestamp of ["observedAt", "createdAt", "updatedAt"] as const) {
            const input: DeploymentFileAuthorityProjectionInputV1 = {
                deploymentFileId: "id",
                relativePath: "CLAUDE.md",
                baselineState: {
                    rowState: "active",
                    appliedPayload: { contentKind: "text", contentHash: SHA_A, byteSize: 1 },
                    appliedExecutable: false,
                    provenance,
                },
                observation: { observedState: "missing" },
                observedAt: 0,
                createdAt: 0,
                updatedAt: 0,
            };
            input[timestamp] = -1;
            expect(() => projectDeploymentFileAuthority(input)).toThrow(/non-negative/);
        }
    });
});
