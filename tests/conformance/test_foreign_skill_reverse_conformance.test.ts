import { approvedSkillSelection, fixtureProjectSkillTargetContext, requireComplete } from "./skill-public-conformance-support";
/** Real source imports, reviewed conversion and source-native reverse through public Core and Host. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProtocolRequest } from "../../packages/app-server/protocol/src/index";
import { dispatchH1Long } from "../../packages/app-server/host/src/dispatch-registry";
import { createHostRenderApprovalAuthority } from "../../packages/app-server/host/src/render-approval-authority";
import { antigravityProvider } from "../../packages/adapter/providers/antigravity/src/antigravity-provider";
import { claudecodeProvider } from "../../packages/adapter/providers/claudecode/src/claudecode-provider";
import { codexProvider } from "../../packages/adapter/providers/codex/src/codex-provider";
import { cursorProvider } from "../../packages/adapter/providers/cursor/src/cursor-provider";
import { opencodeProvider } from "../../packages/adapter/providers/opencode/src/opencode-provider";
import { readVersionAuthority } from "../../packages/core/src/catalog/version-authority";
import { createVersionDialectRegistry } from "../../packages/core/src/catalog/version-dialect-registry";
import { clearRegistry } from "../../packages/core/src/orchestration/adapter-registry";
import { createCoreServiceForTest } from "../../packages/core/src/orchestration/core-service";
import { closeDb } from "../../packages/core/src/persistence/db";
import type { AdapterProvider, PlatformContext, ProbeResult, RenderDegradationKind, UuidV4 } from "../../packages/core/src/types";

const NAME = "documentation-review";
const BODY = "# Documentation review\nRead resources/checklist.md and keep generated notes in reports/.\n";
const BASE_HEADER =
    "---\nname: documentation-review\ndescription: Review project documentation and its bundled references.\n---\n";
const SUFFIX = "\n- Check the migrated target checklist after an external edit.\n";
const SOURCES = [
    {
        provider: claudecodeProvider,
        agentRuntimeId: "CLAUDE_CODE_CLI",
        version: "2.1.191",
        folder: ".claude",
        nativeDialect: "claudecode-skill-directory-v1",
        entryDialect: "claudecode-skill-markdown-v1",
        rich: false,
        flat: false,
        sourceOnlyMetadata: "",
    },
    {
        provider: opencodeProvider,
        agentRuntimeId: "OPENCODE_CLI",
        version: "1.18.11",
        folder: ".opencode",
        nativeDialect: "opencode-skill-directory-v2",
        entryDialect: "opencode-skill-markdown-v2",
        rich: true,
        flat: false,
        sourceOnlyMetadata: "",
    },
    {
        provider: claudecodeProvider,
        agentRuntimeId: "CLAUDE_CODE_CLI",
        version: "2.1.191",
        folder: ".claude",
        nativeDialect: "claudecode-skill-directory-v1",
        entryDialect: "claudecode-skill-markdown-v1",
        rich: false,
        flat: false,
        sourceOnlyMetadata: 'version: "2026-09"\n',
    },
] as const;
const TARGETS = [
    { provider: antigravityProvider, agentRuntimeId: "ANTIGRAVITY_CLI", folder: ".agents" },
    { provider: cursorProvider, agentRuntimeId: "CURSOR_AGENT_CLI", folder: ".cursor" },
    { provider: codexProvider, agentRuntimeId: "CODEX_CLI", folder: ".agents" },
] as const;
const ANTIGRAVITY_FLAT_SOURCE = {
    provider: antigravityProvider,
    agentRuntimeId: "ANTIGRAVITY_CLI",
    version: "1.1.10",
    folder: ".agents",
    nativeDialect: "antigravity-skill-flat-v1",
    entryDialect: "antigravity-skill-markdown-v1",
    rich: false,
    flat: true,
    sourceOnlyMetadata: "",
} as const;
const CLAUDE_TARGET = { provider: claudecodeProvider, agentRuntimeId: "CLAUDE_CODE_CLI", folder: ".claude" } as const;
const CASES = [
    ...[
        ANTIGRAVITY_FLAT_SOURCE,
        { ...ANTIGRAVITY_FLAT_SOURCE, flat: false, nativeDialect: "antigravity-skill-folder-v1" },
        SOURCES[1],
    ].map((source) => ({ source, target: CLAUDE_TARGET, label: source.nativeDialect + " to CLAUDE_CODE_CLI" })),
    {
        source: ANTIGRAVITY_FLAT_SOURCE,
        target: TARGETS[2],
        label: "Antigravity flat Skill to CODEX_CLI",
    },
    ...SOURCES.flatMap((source) =>
        TARGETS.map((target) => ({
            source,
            target,
            label:
                source.agentRuntimeId +
                (source.sourceOnlyMetadata ? " with version metadata" : "") +
                " to " +
                target.agentRuntimeId,
        })),
    ),
    ...[SOURCES[0], SOURCES[2]].map((source) => ({
        source,
        target: { provider: opencodeProvider, agentRuntimeId: "OPENCODE_CLI" as const, folder: ".opencode" },
        label: source.agentRuntimeId + (source.sourceOnlyMetadata ? " with version metadata" : "") + " to OPENCODE_CLI",
    })),
];

describe.each(CASES)("foreign-source Skill public reverse: $label", ({ source, target }) => {
    const providers = [source.provider, target.provider];
    const body = source.flat
        ? "# Documentation review\nReview the project documentation for clear wording and consistent terminology.\n"
        : BODY;
    const expectedLosses: RenderDegradationKind[] =
        target.provider === antigravityProvider
            ? ["permission_or_tool_boundary_lost", "runtime_specific_metadata_lost", "trigger_or_loading_level_lost"]
            : source.sourceOnlyMetadata || (target.provider === cursorProvider && source.rich)
              ? ["runtime_specific_metadata_lost"]
              : [];
    const portableHeader = source.rich
        ? BASE_HEADER.replace(
              "\n---\n",
              '\nlicense: MIT\ncompatibility: Local documentation only\nmetadata:\n  owner: ordinary-user\n  revision: "2"\n---\n',
          )
        : BASE_HEADER;
    const explicitDefaults =
        source.provider === claudecodeProvider
            ? "disable-model-invocation: false\nuser-invocable: true\n"
            : source.provider === opencodeProvider
              ? "slash: true\n"
              : "";
    const HEADER = portableHeader.replace("\n---\n", "\n" + explicitDefaults + source.sourceOnlyMetadata + "---\n");
    let sandbox: string;
    let projectRoot: string;
    let oaamRoot: string;
    let platformContext: PlatformContext;
    beforeEach(() => {
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-foreign-skill-public-"));
        projectRoot = path.join(sandbox, "project");
        oaamRoot = path.join(sandbox, "oaam");
        platformContext = { platform: "wsl", platformInstanceId: "test-wsl", accessRootPath: sandbox };
        const sourceRootPath = path.join(projectRoot, source.folder, "skills", source.flat ? "" : NAME);
        fs.mkdirSync(sourceRootPath, { recursive: true });
        if (source.flat) {
            fs.writeFileSync(path.join(sourceRootPath, NAME + ".md"), HEADER + body);
        } else {
            for (const directory of ["resources", "examples", "scripts", "reports/pending"])
                fs.mkdirSync(path.join(sourceRootPath, directory), { recursive: true });
            fs.writeFileSync(path.join(sourceRootPath, "SKILL.md"), HEADER + body);
            fs.writeFileSync(path.join(sourceRootPath, "resources/checklist.md"), "Check references and paths.\n");
            fs.writeFileSync(path.join(sourceRootPath, "resources/附录.md"), "Keep the source language.\n");
            fs.writeFileSync(path.join(sourceRootPath, "examples/reference.bin"), Buffer.from([0, 255, 1, 2]));
            fs.writeFileSync(path.join(sourceRootPath, "scripts/report.sh"), "#!/bin/sh\nprintf 'review\\n'\n", { mode: 0o755 });
        }
        clearRegistry();
        closeDb();
    });
    afterEach(() => {
        closeDb();
        clearRegistry();
        fs.rmSync(sandbox, { recursive: true, force: true });
    });

    it("saves one changed body as a source-native Version and advances the same applied Deployment", async () => {
        let clock = 1000;
        let sequence = 0;
        const authority = createHostRenderApprovalAuthority(() => ++clock);
        const core = createCoreServiceForTest(
            {
                providers,
                platformContexts: [platformContext],
                oaamRoot,
                databasePath: path.join(sandbox, "state.db"),
                now: () => ++clock,
                confirmOneTimeRenderApproval: (input) => authority.confirmOneTimeApproval(input),
                newUuid: () => `20000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}` as UuidV4,
            },
            {
                async probeAdapters() {
                    return { status: "complete", value: providers.map(probe), diagnostics: [] };
                },
                resolveObservedTargetContext() {
                    return {
                        status: "complete",
                        targetContext: fixtureProjectSkillTargetContext(target.provider, target.agentRuntimeId),
                        diagnostics: [],
                    };
                },
            },
        );
        const enablement = core.getAdapterEnablement();
        requireComplete(
            core.replaceAdapterEnablement({
                expectedRevision: enablement.value.revision,
                expectedSettingFingerprint: enablement.value.settingFingerprint,
                enabledAdapterIds: providers.map((p) => p.adapterId),
                userActionId: "enable-foreign-source-skill-tools",
            }),
            "enable Providers",
        );
        const project = core.registerProject({ rootPath: projectRoot, displayName: "Foreign Skill public path" });
        requireComplete(project, "register Project");
        const read = await core.readAssetsFromAdapter({
            adapterId: source.provider.adapterId,
            allowedKinds: ["Skill"],
            sourceSelector: {
                selectorKind: "probe_roots",
                observation: probe(source.provider).observation,
                sourceRootIds: [sourceRoot().sourceRootId],
            },
        });
        requireComplete(read, "read actual source Skill");
        expect(read.value.candidates).toHaveLength(1);
        expect(read.value.candidates[0]!.status, JSON.stringify(read.value.candidates[0]!.diagnostics)).toBe("complete");
        const preview = core.previewImport([read.value]);
        requireComplete(preview, "preview actual source");
        const candidateId = preview.value.items[0]!.candidateId;
        const imported = await core.acceptImport({
            previewSnapshot: preview.value,
            decision: {
                candidateId,
                action: "create_asset",
                freshness: { freshnessAction: "require_current_source" },
                promotion: {
                    promotionAction: "grant_current_version_current_target",
                    target: { targetKind: "project", projectId: project.value.projectId },
                    userActionId: "authorize-original-source-version",
                },
                callableBindings: [],
            },
        });
        requireComplete(imported, "import source");
        const { assetId, versionId } = imported.value;
        const registry = createVersionDialectRegistry(
            providers.flatMap((p) => p.dialectContracts.native),
            providers.flatMap((p) => p.dialectContracts.restoration),
            providers.flatMap((p) => p.dialectContracts.portableEntries),
            providers.flatMap((p) => p.dialectContracts.portableSelectors),
        );
        const original = readVersionAuthority(path.join(oaamRoot, "assets"), assetId, versionId, registry)!;
        expect(original.manifest.typeData).toMatchObject({
            entryDialectId: source.entryDialect,
            whenToUse: source.provider === antigravityProvider ? "Review project documentation and its bundled references." : "",
        });
        expect(original.manifest.nativeRepresentations[0]).toMatchObject({
            schemaVersion: source.flat ? 1 : 2,
            dialectId: source.nativeDialect,
        });
        const deployment = core.createDeployment({
            projectId: project.value.projectId,
            consumerAgentRuntimeIds: [target.agentRuntimeId],
            platform: "wsl",
            platformInstanceId: platformContext.platformInstanceId,
            targetRootPath: projectRoot,
            assets: [{ assetId, versionId, allowIncomplete: false }],
        });
        requireComplete(deployment, "create foreign Deployment");
        const deploymentId = deployment.value.deploymentId;
        const analysis = await core.analyzeDeploymentRender(deploymentId);
        requireComplete(analysis, "analyze foreign conversion");
        if (target.provider === codexProvider || target.provider === opencodeProvider) {
            const options = analysis.value.analyses.flatMap((row) => row.semanticOptions);
            expect(options.length).toBeGreaterThan(0);
            expect(options.every((option) => option.outcome === (source.sourceOnlyMetadata ? "degraded" : "preserved"))).toBe(
                true,
            );
            expect(
                options.every(
                    (option) =>
                        option.approvalRequirement.approvalState === (source.sourceOnlyMetadata ? "required" : "not_required"),
                ),
            ).toBe(true);
        }
        const selectionRequest = approvedSkillSelection(analysis.value, expectedLosses);
        const forwardResolutions = authority.createResolutions(selectionRequest);
        const applyPreview = await authority.runWithResolutions(selectionRequest, forwardResolutions, () =>
            core.previewDeploymentRender({ deploymentId, selectionRequest }),
        );
        requireComplete(applyPreview, "preview converted graph");
        requireComplete(
            await authority.runWithResolutions(selectionRequest, forwardResolutions, () =>
                core.deployDeployment({
                    deploymentId,
                    selectionRequest,
                    expectedPreviewFingerprint: applyPreview.value.previewFingerprint,
                    deploymentAction: "apply",
                }),
            ),
            "apply converted graph",
        );
        const targetRoot = path.join(
            projectRoot,
            target.folder,
            "skills",
            target.provider === claudecodeProvider ? NAME : `oaam-skill-${assetId.slice(0, 8)}`,
        );
        const targetEntry = path.join(targetRoot, "SKILL.md");
        expect(fs.readFileSync(targetEntry, "utf8")).toContain(body);
        if (!source.flat) {
            expect(fs.existsSync(path.join(targetRoot, "reports/pending"))).toBe(true);
            expect(fs.statSync(path.join(targetRoot, "scripts/report.sh")).mode & 0o111).not.toBe(0);
        } else {
            expect(fs.readdirSync(targetRoot)).toEqual(["SKILL.md"]);
        }
        fs.appendFileSync(targetEntry, SUFFIX);
        const changed = fs.readFileSync(targetEntry);
        const inspected = await core.inspectDeploymentRenderedTarget(deploymentId);
        requireComplete(inspected, "inspect foreign body edit");
        expect(inspected.value.changes).toHaveLength(1);
        const prepared = await core.prepareRenderedTargetAccept({
            deploymentId,
            inspectionResultFingerprint: inspected.value.inspectionResultFingerprint,
        });
        requireComplete(prepared, "prepare foreign reverse");
        if (prepared.value.preparationState !== "prepared") throw new Error("Foreign reverse was not prepared");
        const preparedValue = prepared.value;
        if (target.provider === opencodeProvider || source.flat) {
            const expectedLosses = source.sourceOnlyMetadata ? ["runtime_specific_metadata_lost"] : [];
            const options = preparedValue.renderAnalysis.analyses.flatMap((row) => row.semanticOptions);
            expect(options.length).toBeGreaterThan(0);
            for (const option of options) {
                expect(option.outcome).toBe(expectedLosses.length ? "degraded" : "preserved");
                expect(option.approvalRequirement.approvalState).toBe(expectedLosses.length ? "required" : "not_required");
                if (option.outcome === "degraded") expect(option.degradationKinds).toEqual(expectedLosses);
            }
        }
        const reverseSelection = approvedSkillSelection(preparedValue.renderAnalysis, expectedLosses);
        const committed = (await dispatchH1Long(
            core,
            createProtocolRequest("foreign-reverse", "reverse_accept.commit", {
                preparationId: preparedValue.preparationId,
                expectedPreparationRevision: preparedValue.preparationRevision,
                userActionId: "save-foreign-body-change",
                newVersionPromotion: "grant_staged_version_current_target",
                renderSelection: {
                    schemaVersion: 1,
                    renderInputFingerprint: reverseSelection.renderInputFingerprint.slice(7),
                    semanticOptions: reverseSelection.semanticOptions.map((option) => ({
                        optionFingerprint: option.optionFingerprint.slice(7),
                        approval:
                            option.approvalRequest.approvalAction === "none"
                                ? { action: "none" }
                                : { action: "approve_once", userActionId: "approve-disclosed-foreign-conversion" },
                    })),
                },
            }),
            undefined,
            undefined,
            authority,
        )) as Awaited<ReturnType<typeof core.commitRenderedTargetAccept>>;
        requireComplete(committed, "commit foreign reverse");
        if (committed.value.commitState !== "committed") throw new Error("Foreign reverse was not committed");
        const accepted = readVersionAuthority(
            path.join(oaamRoot, "assets"),
            assetId,
            committed.value.version.versionId,
            registry,
        )!;
        expect(accepted.manifest.typeData).toEqual(original.manifest.typeData);
        expect(accepted.manifest.sourceVersionId).toBe(versionId);
        expect(accepted.files.find((f) => f.file.role === "entry")).toMatchObject({ text: body + SUFFIX });
        const acceptedNative = accepted.manifest.nativeRepresentations[0]!;
        const originalNative = original.manifest.nativeRepresentations[0]!;
        if (source.flat) {
            expect(acceptedNative.schemaVersion).toBe(1);
            expect(acceptedNative).not.toHaveProperty("directories");
        } else {
            if (acceptedNative.schemaVersion !== 2 || originalNative.schemaVersion !== 2)
                throw new Error("Foreign reverse must retain the complete source-native directory graph");
            expect(acceptedNative.directories).toEqual(originalNative.directories);
        }
        const oldNative = original.nativePayloads[0]!;
        expect(
            accepted.nativePayloads[0]!.files.map((file) => ({
                path: file.relativePath,
                value: Buffer.from(file.bytes).toString("hex"),
            })),
        ).toEqual(
            oldNative.files.map((file) => ({
                path: file.relativePath,
                value: (source.flat || file.relativePath.endsWith("/SKILL.md")
                    ? Buffer.from(HEADER + body + SUFFIX)
                    : Buffer.from(file.bytes)
                ).toString("hex"),
            })),
        );
        expect(readVersionAuthority(path.join(oaamRoot, "assets"), assetId, versionId, registry)).toEqual(original);
        expect(
            fs.readFileSync(
                path.join(projectRoot, source.folder, "skills", ...(source.flat ? [NAME + ".md"] : [NAME, "SKILL.md"])),
                "utf8",
            ),
        ).toBe(HEADER + body);
        expect(fs.readFileSync(targetEntry)).toEqual(changed);
        expect(core.getDeployment(deploymentId)).toMatchObject({
            status: "complete",
            value: {
                found: true,
                value: {
                    derivedStatus: { stage: "in_sync" },
                    assets: [{ assetId, versionId: committed.value.version.versionId }],
                },
            },
        });
    });

    function sourceRoot() {
        return {
            sourceRootId: "selected-project-root",
            rootRole: "project_actual" as const,
            sourceDomain: "project_root" as const,
            path: projectRoot,
            accessStatus: "available" as const,
            locatorEvidence: [
                {
                    locatorKind: "user_provided_path" as const,
                    locatorKey:
                        source.provider === opencodeProvider
                            ? "probe_project_root:project_config_on:external_skills_on:claude_prompt_on:claude_skills_on"
                            : "selected-project-root",
                    evidenceLevel: "user_provided" as const,
                },
            ],
            diagnostics: [],
        };
    }
    function probe(provider: AdapterProvider): ProbeResult {
        const agentRuntimeId = provider === source.provider ? source.agentRuntimeId : target.agentRuntimeId;
        const versionText =
            provider === source.provider
                ? source.version
                : fixtureProjectSkillTargetContext(target.provider, target.agentRuntimeId).versionText;
        return {
            status: "complete",
            observation: {
                adapterId: provider.adapterId,
                platformContext,
                observedAgentRuntimes: [
                    {
                        agentRuntimeId,
                        versionText,
                        installationEvidence: [
                            {
                                kind: "executable",
                                path: path.join(sandbox, "fixture-bin", agentRuntimeId),
                                evidenceLevel: "agent_runtime_verified",
                                diagnostics: [],
                            },
                        ],
                        sourceRootIds: [sourceRoot().sourceRootId],
                        agentRuntimeResourceIds: [],
                        observedProjectIds: [],
                        installationStatus: "available",
                        projectDiscoveryStatus: "complete",
                        diagnostics: [],
                    },
                ],
                sourceRoots: [sourceRoot()],
                agentRuntimeResources: [],
                observedProjects: [],
                targetCandidates: [
                    {
                        targetCandidateId: "foreign-skill-target",
                        targetRootPath: projectRoot,
                        targetKind: "project",
                        displayName: NAME,
                        entryApplicabilities: [
                            {
                                agentRuntimeId,
                                status: "ready_for_plan",
                                locatorEvidence: [
                                    {
                                        locatorKind: "user_provided_path",
                                        locatorKey: "probe_project_root",
                                        evidenceLevel: "user_provided",
                                    },
                                ],
                                diagnostics: [],
                            },
                        ],
                        diagnostics: [],
                    },
                ],
            },
            diagnostics: [],
        };
    }
});
