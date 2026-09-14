import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const DEPLOYMENT_ID = "44444444-4444-4444-8444-444444444444";
const FILE_ID = "55555555-5555-4555-8555-555555555555";
const GRANT_ID = "66666666-6666-4666-8666-666666666666";
const GUIDANCE_TEXT = "# Project guidance\n\nUse OAAM safely.\n";

function providerSummary(provider) {
    return {
        adapterId: provider.adapterId,
        displayName: provider.displayName,
        version: provider.version,
        enabled: true,
        agentRuntimes: provider.agentRuntimes,
        targetContextSchemas: provider.targetContextSchemas,
        assetSourceCapabilities: provider.assetSourceCapabilities,
        assetTargetCapabilities: provider.assetTargetCapabilities,
        materializerCapabilities: provider.materializerCapabilities,
        renderContractDeclarations: provider.renderContractDeclarations,
    };
}

function requireOne(values, label) {
    if (values.length !== 1) throw new Error(`Project Guidance production receipt has no unique ${label}`);
    return values[0];
}

function sameTextSet(left, right) {
    return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

export async function projectGuidanceProductionRenderReceipt(repositoryRoot = process.cwd()) {
    const { claudecodeProvider } = require(path.join(repositoryRoot, "packages/adapter/providers/claudecode/dist/index.js"));
    const { adapterRenderRegistryComponents } = require(
        path.join(repositoryRoot, "packages/core/dist/render/adapter-render-contract-registration.js"),
    );
    const { createRenderRegistry } = require(path.join(repositoryRoot, "packages/core/dist/render/render-registry.js"));
    const { analyzeRenderDeployment, deriveRequiredRenderSemanticsV1 } = require(
        path.join(repositoryRoot, "packages/core/dist/render/render-analysis.js"),
    );
    const { resolveAssetUsageObservationSelection } = require(
        path.join(repositoryRoot, "packages/core/dist/render/render-selection.js"),
    );
    const { materializeRenderObservation } = require(
        path.join(repositoryRoot, "packages/core/dist/render/render-materialization.js"),
    );
    const { EMPTY_VERSION_DIALECT_REGISTRY } = require(
        path.join(repositoryRoot, "packages/core/dist/catalog/version-dialect-registry.js"),
    );
    const { textPayloadStats } = require(path.join(repositoryRoot, "packages/core/dist/catalog/payload-store.js"));
    const {
        computeDeploymentRenderPreviewFingerprint,
        computeRenderInputFingerprint,
        computeTargetApplicabilityFingerprint,
        computeVersionCanonicalContentFingerprint,
    } = require(path.join(repositoryRoot, "packages/core/dist/foundation/fingerprint.js"));
    const { resolvePromotionAuthorizationInspectionFromFacts } = require(
        path.join(repositoryRoot, "packages/core/dist/render/render-promotion-authorization.js"),
    );
    const { projectDeploymentRenderPreview, projectRenderAnalysis } = require(
        path.join(repositoryRoot, "packages/app-server/host/dist/render-projection.js"),
    );

    const { canonicalMaterializationValidatorsForProviders } = require(
        path.join(repositoryRoot, "packages/core/dist/render/canonical-materialization-validation.js"),
    );
    const summary = providerSummary(claudecodeProvider);
    const registry = createRenderRegistry({
        providers: [summary],
        ...adapterRenderRegistryComponents([summary], canonicalMaterializationValidatorsForProviders([claudecodeProvider])),
    });
    const declaration = requireOne(
        summary.renderContractDeclarations.filter(
            (candidate) =>
                candidate.declarationKind === "native_project_guidance_v1" && candidate.agentRuntimeId === "CLAUDE_CODE_CLI",
        ),
        "Claude CLI project Guidance declaration",
    );
    const schema = requireOne(
        summary.targetContextSchemas.filter(
            (candidate) =>
                candidate.agentRuntimeId === "CLAUDE_CODE_CLI" &&
                candidate.targetContextSchemaId === declaration.target.targetContextSchemaId,
        ),
        "Claude CLI project target schema",
    );
    const descriptor = requireOne(
        summary.agentRuntimes.filter((candidate) => candidate.agentRuntimeId === "CLAUDE_CODE_CLI"),
        "Claude CLI descriptor",
    );
    const currentBuilds = new Map();
    for (const candidate of summary.renderContractDeclarations) {
        if (
            candidate.agentRuntimeId !== "CLAUDE_CODE_CLI" ||
            candidate.target.targetContextSchemaId !== declaration.target.targetContextSchemaId
        ) {
            continue;
        }
        for (const build of candidate.verifiedBuilds) {
            if (build.versionText === "2.1.220" && build.platform === "wsl") {
                currentBuilds.set(`${build.versionText}\0${build.buildIdentity}\0${build.platform}`, build);
            }
        }
    }
    const currentBuild = requireOne([...currentBuilds.values()], "Claude CLI 2.1.220 build identity");
    const contextPreimage = {
        schemaVersion: 1,
        agentRuntimeId: "CLAUDE_CODE_CLI",
        versionText: currentBuild.versionText,
        buildIdentity: currentBuild.buildIdentity,
        targetContextSchemaId: schema.targetContextSchemaId,
        targetContextSchemaFingerprint: schema.schemaFingerprint,
        renderFacts: [
            { key: "oaam.platform", value: "wsl", evidenceLevel: "agent_runtime_verified" },
            ...Object.entries(declaration.target.requiredFacts).map(([key, value]) => ({
                key,
                value,
                evidenceLevel: "agent_runtime_verified",
            })),
        ].sort((left, right) => left.key.localeCompare(right.key, "en")),
    };
    const targetContext = {
        ...contextPreimage,
        targetApplicabilityFingerprint: computeTargetApplicabilityFingerprint({
            context: contextPreimage,
            entryClass: descriptor.entryClass,
        }),
    };
    registry.validateTargetContext(targetContext);

    const stats = textPayloadStats(GUIDANCE_TEXT);
    const file = {
        fileId: FILE_ID,
        logicalPath: "GUIDANCE.md",
        role: "entry",
        contentHash: stats.contentHash,
        contentKind: "text",
        mediaType: "text/markdown",
        byteSize: stats.byteSize,
        executable: false,
        references: [],
    };
    const canonical = { kind: "Guidance", typeData: { schemaVersion: 1 } };
    const asset = {
        scope: "project",
        projectId: PROJECT_ID,
        scopePath: "",
        allowIncomplete: false,
        version: {
            ref: { assetId: ASSET_ID, versionId: VERSION_ID },
            versionFingerprint: stats.contentHash,
            versionCanonicalContentFingerprint: computeVersionCanonicalContentFingerprint(canonical, [file]),
            status: "complete",
            canonical,
            files: [{ contentKind: "text", text: GUIDANCE_TEXT, file }],
        },
        sectionHandles: { [FILE_ID]: "project-guidance-entry" },
    };
    const deploymentPreimage = {
        schemaVersion: 1,
        deploymentId: DEPLOYMENT_ID,
        consumerAgentRuntimeIds: ["CLAUDE_CODE_CLI"],
        platform: "wsl",
        platformInstanceId: "Ubuntu",
        targetRootPath: "/tmp/oaam-project-guidance-apply",
        projectId: PROJECT_ID,
        targetContexts: [targetContext],
        renderRegistryFingerprint: registry.fingerprint,
        assets: [asset],
    };
    const deployment = {
        ...deploymentPreimage,
        renderInputFingerprint: computeRenderInputFingerprint(deploymentPreimage),
    };
    const requiredSemantics = deriveRequiredRenderSemanticsV1(deployment);
    const analyzed = await analyzeRenderDeployment(deployment, {
        registry,
        resolveDialectInputs: () => [],
        dispatch: async (adapterId, input) => {
            if (adapterId !== claudecodeProvider.adapterId) throw new Error("unexpected render Provider owner");
            return { status: "complete", value: await claudecodeProvider.analyzeRender(input), diagnostics: [] };
        },
    });
    if (analyzed.status === "failed") throw new Error("production Project Guidance render analysis failed");
    const analysis = analyzed.value;
    const providerAnalysis = requireOne(analysis.analyses, "Claude render analysis");
    if (
        requiredSemantics.length !== providerAnalysis.semanticOptions.length ||
        !sameTextSet(
            requiredSemantics.map((semantic) => semantic.semanticRefFingerprint),
            providerAnalysis.semanticOptions.map((option) => option.semanticRefFingerprint),
        ) ||
        providerAnalysis.semanticOptions.some(
            (option) =>
                option.outcome !== "preserved" ||
                option.actualReverseExtractPolicy !== "can_reconcile" ||
                option.requiredOutputUnitFingerprints.length !== 1,
        )
    ) {
        throw new Error("production Project Guidance render analysis lacks exact semantic closure");
    }

    const observationSelection = resolveAssetUsageObservationSelection({ deployment, analysis }, registry, ["CLAUDE_CODE_CLI"]);
    if (observationSelection.status === "failed") {
        throw new Error("production Project Guidance render selection failed");
    }
    const materialized = await materializeRenderObservation(
        { deployment, analysis, observationSelection: observationSelection.value },
        {
            registry,
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            resolveDialectInputs: () => [],
            dispatch: async (adapterId, input) => {
                if (adapterId !== claudecodeProvider.adapterId) throw new Error("unexpected materializer Provider owner");
                return { status: "complete", value: await claudecodeProvider.materializeRender(input), diagnostics: [] };
            },
        },
    );
    if (materialized.status === "failed") throw new Error("production Project Guidance native materialization failed");
    const unit = requireOne(materialized.value.units, "native output unit");
    const nativeFile = requireOne(unit.files, "native output file");
    if (
        nativeFile.relativePath !== "CLAUDE.md" ||
        nativeFile.content.contentKind !== "text" ||
        !sameTextSet(
            nativeFile.semanticRefFingerprints,
            requiredSemantics.map((semantic) => semantic.semanticRefFingerprint),
        )
    ) {
        throw new Error("production Project Guidance native materialization is not one complete CLAUDE.md");
    }
    const desired = textPayloadStats(nativeFile.content.text);
    const previewFile = {
        relativePath: "CLAUDE.md",
        baselineState: "unmanaged",
        changeKind: "create",
        current: { state: "missing" },
        desired: {
            state: "present",
            contentKind: "text",
            contentHash: desired.contentHash,
            byteSize: desired.byteSize,
            executable: nativeFile.executable,
            text: nativeFile.content.text,
        },
    };
    const previewPreimage = {
        deploymentId: DEPLOYMENT_ID,
        renderInputFingerprint: deployment.renderInputFingerprint,
        selectionFingerprint: observationSelection.value.selectionFingerprint,
        compilationFingerprint: materialized.value.selectionFingerprint,
        replacementScope: { filePaths: [previewFile.relativePath], directoryPaths: [] },
        desiredFiles: [
            {
                relativePath: previewFile.relativePath,
                desired: {
                    state: "present",
                    contentKind: "text",
                    contentHash: desired.contentHash,
                    byteSize: desired.byteSize,
                    executable: nativeFile.executable,
                },
            },
        ],
        desiredDirectories: [],
        protectedFiles: [],
        protectedDirectories: [],
    };
    const preview = projectDeploymentRenderPreview("actual-render-project-guidance-preview", {
        schemaVersion: 3,
        deploymentId: previewPreimage.deploymentId,
        renderInputFingerprint: previewPreimage.renderInputFingerprint,
        selectionFingerprint: previewPreimage.selectionFingerprint,
        compilationFingerprint: previewPreimage.compilationFingerprint,
        replacementScope: previewPreimage.replacementScope,
        previewFingerprint: computeDeploymentRenderPreviewFingerprint(previewPreimage),
        actionState: "ready_apply",
        files: [previewFile],
        directories: [],
    });

    const target = { targetKind: "project", projectId: PROJECT_ID };
    const baseFacts = {
        assetId: ASSET_ID,
        versionId: VERSION_ID,
        target,
        promotionRequirement: "requires_current_authorization",
        versionOriginAuthorityFingerprint: asset.version.versionFingerprint,
    };
    const required = resolvePromotionAuthorizationInspectionFromFacts({
        ...baseFacts,
        authority: { authorityKind: "none" },
    });
    const authorized = resolvePromotionAuthorizationInspectionFromFacts({
        ...baseFacts,
        authority: {
            authorityKind: "grant",
            grant: {
                schemaVersion: 1,
                promotionGrantId: GRANT_ID,
                subject: { subjectKind: "asset_version", assetId: ASSET_ID, versionId: VERSION_ID },
                target,
                grantState: "active",
                revision: 1,
                userActionEvidenceId: "actual-render-project-guidance-grant",
                updatedAt: 3,
                grantFingerprint: observationSelection.value.selectionFingerprint,
            },
        },
    });
    const projectedRequired = projectRenderAnalysis(DEPLOYMENT_ID, {
        ...analysis,
        promotionAuthorizationInspections: [required],
    });
    const projectedAuthorized = projectRenderAnalysis(DEPLOYMENT_ID, {
        ...analysis,
        promotionAuthorizationInspections: [authorized],
    });
    const semanticClosure = projectedAuthorized.semantics
        .map((semantic) => ({
            semanticKind: semantic.semanticKind,
            semanticRefFingerprint: semantic.semanticRefFingerprint,
            optionFingerprint: requireOne(
                projectedAuthorized.options.filter((option) => option.semanticRefFingerprint === semantic.semanticRefFingerprint),
                `option for ${semantic.semanticKind}`,
            ).optionFingerprint,
        }))
        .sort((left, right) => left.semanticKind.localeCompare(right.semanticKind, "en"));
    return Object.freeze({
        schemaVersion: 1,
        required: projectedRequired,
        authorized: projectedAuthorized,
        preview,
        semanticClosure: Object.freeze(semanticClosure),
        native: Object.freeze({
            relativePath: nativeFile.relativePath,
            contentSha256: desired.contentHash.slice("sha256:".length),
            byteSize: desired.byteSize,
            semanticRefFingerprints: Object.freeze(
                nativeFile.semanticRefFingerprints.map((fingerprint) => fingerprint.slice("sha256:".length)),
            ),
        }),
    });
}
