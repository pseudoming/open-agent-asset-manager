import { approvedSkillSelection, fixtureProjectSkillTargetContext, requireComplete } from "./skill-public-conformance-support";
/** Ordinary user-created and edited Versions remain renderable without a native source seed. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cursorProvider } from "../../packages/adapter/providers/cursor/src/cursor-provider";
import { claudecodeProvider } from "../../packages/adapter/providers/claudecode/src/claudecode-provider";
import { codexProvider } from "../../packages/adapter/providers/codex/src/codex-provider";
import { createProtocolRequest } from "../../packages/app-server/protocol/src/index";
import { dispatchH1Long } from "../../packages/app-server/host/src/dispatch-registry";
import { createHostRenderApprovalAuthority } from "../../packages/app-server/host/src/render-approval-authority";
import { readVersionAuthority } from "../../packages/core/src/catalog/version-authority";
import { createVersionDialectRegistry } from "../../packages/core/src/catalog/version-dialect-registry";
import { clearRegistry } from "../../packages/core/src/orchestration/adapter-registry";
import { createCoreServiceForTest } from "../../packages/core/src/orchestration/core-service";
import { closeDb } from "../../packages/core/src/persistence/db";
import type { ProbeResult, UuidV4, VersionFileInput, SkillTypeDataV2 } from "../../packages/core/src/types";

const providers = [cursorProvider, codexProvider, claudecodeProvider];
const cases = [
    { provider: cursorProvider, agentRuntimeId: "CURSOR_AGENT_CLI", metadata: false, losses: [] },
    { provider: cursorProvider, agentRuntimeId: "CURSOR_AGENT_CLI", metadata: true, losses: ["runtime_specific_metadata_lost"] },
    { provider: codexProvider, agentRuntimeId: "CODEX_CLI", metadata: true, losses: [] },
    { provider: claudecodeProvider, agentRuntimeId: "CLAUDE_CODE_CLI", metadata: true, losses: [] },
] as const;
let sandbox: string;
afterEach(() => {
    closeDb();
    clearRegistry();
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("ordinary user Skill canonical Core path", () => {
    it.each(
        cases,
    )("creates and edits a Skill for $agentRuntimeId with metadata=$metadata through preview, Apply and reverse", async (target) => {
        clearRegistry();
        closeDb();
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-user-skill-canonical-"));
        const oaamRoot = path.join(sandbox, "oaam"),
            projectRoot = path.join(sandbox, "project");
        fs.mkdirSync(projectRoot);
        const platformContext = { platform: "wsl" as const, platformInstanceId: "test-wsl", accessRootPath: sandbox };
        const context = fixtureProjectSkillTargetContext(target.provider, target.agentRuntimeId);
        let clock = 1000,
            sequence = 0;
        const authority = createHostRenderApprovalAuthority(() => ++clock);
        const probe: ProbeResult = {
            status: "complete",
            diagnostics: [],
            observation: {
                adapterId: target.provider.adapterId,
                platformContext,
                observedAgentRuntimes: [
                    {
                        agentRuntimeId: target.agentRuntimeId,
                        versionText: context.versionText,
                        installationEvidence: [
                            {
                                kind: "executable",
                                path: path.join(sandbox, "fixture-bin", target.agentRuntimeId),
                                evidenceLevel: "agent_runtime_verified",
                                diagnostics: [],
                            },
                        ],
                        sourceRootIds: [],
                        agentRuntimeResourceIds: [],
                        observedProjectIds: [],
                        installationStatus: "available",
                        projectDiscoveryStatus: "complete",
                        diagnostics: [],
                    },
                ],
                sourceRoots: [],
                agentRuntimeResources: [],
                observedProjects: [],
                targetCandidates: [
                    {
                        targetCandidateId: "user-skill-target",
                        targetRootPath: projectRoot,
                        targetKind: "project",
                        displayName: "User Skill",
                        entryApplicabilities: [
                            {
                                agentRuntimeId: target.agentRuntimeId,
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
        };
        const core = createCoreServiceForTest(
            {
                providers,
                platformContexts: [platformContext],
                oaamRoot,
                databasePath: path.join(sandbox, "state.db"),
                now: () => ++clock,
                confirmOneTimeRenderApproval: (input) => authority.confirmOneTimeApproval(input),
                newUuid: () => ("20000000-0000-4000-8000-" + String(++sequence).padStart(12, "0")) as UuidV4,
            },
            {
                async probeAdapters() {
                    return { status: "complete", value: [probe], diagnostics: [] };
                },
                resolveObservedTargetContext() {
                    return { status: "complete", targetContext: context, diagnostics: [] };
                },
            },
        );
        const setting = core.getAdapterEnablement();
        requireComplete(
            core.replaceAdapterEnablement({
                expectedRevision: setting.value.revision,
                expectedSettingFingerprint: setting.value.settingFingerprint,
                enabledAdapterIds: providers.map((p) => p.adapterId),
                userActionId: "enable-user-skill-targets",
            }),
            "enable",
        );
        const project = core.registerProject({ rootPath: projectRoot, displayName: "User Skill" });
        requireComplete(project, "register");
        const typeData: SkillTypeDataV2 = {
            schemaVersion: 2,
            name: "documentation-review",
            description: "Review project documentation.",
            whenToUse: "",
            entryDialectId: "cursor-skill-directory-v1",
            portableMetadata: { license: "", compatibility: "", metadata: {} },
            invocation: {
                pathCondition: { mode: "none" },
                user: { mode: "direct", commandName: "documentation-review" },
                model: { mode: "model_decision" },
                argumentHint: "",
                argumentNames: [],
            },
            toolPolicy: { preapproved: [], denied: [], otherwise: "inherit_agent_runtime_policy" },
            execution: { mode: "caller", model: { mode: "inherit" }, effort: { mode: "inherit" } },
        };
        typeData.invocation.model = { mode: "model_decision" };
        if (target.provider === claudecodeProvider) {
            typeData.name = "Documentation review display name";
            typeData.whenToUse = "Use before publishing a documentation release.";
            typeData.invocation.argumentHint = "[review scope]";
        }
        if (target.metadata)
            typeData.portableMetadata = {
                license: "MIT",
                compatibility: "Local documentation",
                metadata: { owner: "ordinary-user" },
            };
        const files: VersionFileInput[] = [
            {
                logicalPath: "SKILL.md",
                role: "entry",
                contentKind: "text",
                mediaType: "text/markdown",
                text: "Review the documentation and resources/checklist.md.\n",
                executable: false,
            },
            {
                logicalPath: "resources/checklist.md",
                role: "resource",
                contentKind: "text",
                mediaType: "text/markdown",
                text: "Check the references.\n",
                executable: false,
            },
            {
                logicalPath: "examples/reference.bin",
                role: "resource",
                contentKind: "binary",
                mediaType: "application/octet-stream",
                bytes: Uint8Array.of(0, 255, 17),
                executable: false,
            },
        ];
        files.sort((a, b) => (a.logicalPath < b.logicalPath ? -1 : a.logicalPath > b.logicalPath ? 1 : 0));
        const created = core.createAsset({
            kind: "Skill",
            scope: "project",
            projectId: project.value.projectId,
            scopePath: "",
            displayName: "Documentation review",
            initialVersion: { typeData, files, changeKind: "create", userActionEvidenceId: "create-user-skill" },
        });
        requireComplete(created, "create ordinary Skill");
        const assetId = created.value.assetId;
        let versionId = created.value.versionIds[0] as UuidV4;
        const registry = createVersionDialectRegistry(
            providers.flatMap((p) => p.dialectContracts.native),
            providers.flatMap((p) => p.dialectContracts.restoration),
            providers.flatMap((p) => p.dialectContracts.portableEntries),
            providers.flatMap((p) => p.dialectContracts.portableSelectors),
        );
        for (const phase of ["created", "edited"] as const) {
            if (phase === "edited") {
                files[0] = {
                    ...files[0]!,
                    contentKind: "text",
                    text: "Review the revised documentation and resources/checklist.md.\n",
                };
                const next = core.createVersion(assetId, {
                    typeData,
                    files,
                    sourceVersionId: versionId,
                    changeKind: "edit",
                    userActionEvidenceId: "edit-user-skill",
                });
                requireComplete(next, "edit ordinary Skill");
                versionId = next.value.versionId;
            }
            const stored = readVersionAuthority(path.join(oaamRoot, "assets"), assetId, versionId, registry)!;
            expect(stored.manifest.nativeRepresentations).toEqual([]);
            expect(stored.manifest.originAuthority?.originKind).toBe("user_created");
            expect(stored.manifest.status).toBe("complete");
            const deployment = core.createDeployment({
                projectId: project.value.projectId,
                consumerAgentRuntimeIds: [target.agentRuntimeId],
                platform: "wsl",
                platformInstanceId: platformContext.platformInstanceId,
                targetRootPath: projectRoot,
                assets: [{ assetId, versionId, allowIncomplete: false }],
            });
            requireComplete(deployment, "create " + phase + " Deployment");
            const analysis = await core.analyzeDeploymentRender(deployment.value.deploymentId);
            requireComplete(analysis, "analyze " + phase + " Skill");
            const options = analysis.value.analyses.flatMap((row) => row.semanticOptions);
            expect(options.length).toBeGreaterThan(0);
            for (const option of options) {
                expect(option.outcome).toBe(target.losses.length ? "degraded" : "preserved");
                if (option.outcome === "degraded") expect(option.degradationKinds).toEqual(target.losses);
                expect(option.approvalRequirement.approvalState).toBe(target.losses.length ? "required" : "not_required");
            }
            const selection = approvedSkillSelection(analysis.value, target.losses);
            const resolutions = authority.createResolutions(selection);
            const preview = await authority.runWithResolutions(selection, resolutions, () =>
                core.previewDeploymentRender({ deploymentId: deployment.value.deploymentId, selectionRequest: selection }),
            );
            requireComplete(preview, "compile and preview " + phase + " Skill");
            expect(fs.readdirSync(projectRoot)).toEqual([]);
            expect(readVersionAuthority(path.join(oaamRoot, "assets"), assetId, versionId, registry)).toEqual(stored);
            if (phase === "created") continue;
            const deploymentId = deployment.value.deploymentId;
            expect(stored.manifest.originAuthority?.promotionRequirement).toBe("not_required");
            const applySelection = selection;
            const applyResolutions = resolutions;
            const applyPreview = preview;
            requireComplete(
                await authority.runWithResolutions(applySelection, applyResolutions, () =>
                    core.deployDeployment({
                        deploymentId,
                        selectionRequest: applySelection,
                        expectedPreviewFingerprint: applyPreview.value.previewFingerprint,
                        deploymentAction: "apply",
                    }),
                ),
                "apply ordinary user Skill",
            );
            const folder =
                target.provider === claudecodeProvider ? ".claude" : target.provider === cursorProvider ? ".cursor" : ".agents";
            const leaf = target.provider === claudecodeProvider ? "documentation-review" : "oaam-skill-" + assetId.slice(0, 8);
            const targetRoot = path.join(projectRoot, folder, "skills", leaf);
            if (target.provider === claudecodeProvider) {
                const entry = fs.readFileSync(path.join(targetRoot, "SKILL.md"), "utf8");
                expect(entry).toContain('name: "Documentation review display name"');
                expect(entry).toContain('when_to_use: "Use before publishing a documentation release."');
                expect(entry).toContain('argument-hint: "[review scope]"');
            }
            let previous = stored;
            for (const changedPath of ["SKILL.md", "resources/checklist.md"]) {
                const targetEntry = path.join(targetRoot, changedPath);
                const suffix = "\nReview the externally added release note.\n";
                fs.appendFileSync(targetEntry, suffix);
                const targetBytes = fs.readFileSync(targetEntry);
                const targetModified = fs.statSync(targetEntry).mtimeMs;
                const inspected = await core.inspectDeploymentRenderedTarget(deploymentId);
                requireComplete(inspected, "inspect user Skill body edit");
                expect(inspected.value.changes).toHaveLength(1);
                const prepared = await core.prepareRenderedTargetAccept({
                    deploymentId,
                    inspectionResultFingerprint: inspected.value.inspectionResultFingerprint,
                });
                requireComplete(prepared, "prepare user Skill reverse");
                if (prepared.value.preparationState !== "prepared") throw new Error("User Skill reverse was not prepared");
                const reverseSelection = approvedSkillSelection(prepared.value.renderAnalysis, target.losses);
                const committed = (await dispatchH1Long(
                    core,
                    createProtocolRequest("user-skill-reverse", "reverse_accept.commit", {
                        preparationId: prepared.value.preparationId,
                        expectedPreparationRevision: prepared.value.preparationRevision,
                        userActionId: "save-user-skill-body-change",
                        newVersionPromotion: "use_existing_authority",
                        renderSelection: {
                            schemaVersion: 1,
                            renderInputFingerprint: reverseSelection.renderInputFingerprint.slice(7),
                            semanticOptions: reverseSelection.semanticOptions.map((option) => ({
                                optionFingerprint: option.optionFingerprint.slice(7),
                                approval:
                                    option.approvalRequest.approvalAction === "none"
                                        ? { action: "none" as const }
                                        : {
                                              action: "approve_once" as const,
                                              userActionId: "approve-disclosed-foreign-conversion",
                                          },
                            })),
                        },
                    }),
                    undefined,
                    undefined,
                    authority,
                )) as Awaited<ReturnType<typeof core.commitRenderedTargetAccept>>;
                requireComplete(committed, "commit user Skill reverse");
                if (committed.value.commitState !== "committed") throw new Error("User Skill reverse was not committed");
                const accepted = readVersionAuthority(
                    path.join(oaamRoot, "assets"),
                    assetId,
                    committed.value.version.versionId,
                    registry,
                )!;
                expect(accepted.manifest.typeData).toEqual(stored.manifest.typeData);
                expect(accepted.manifest.nativeRepresentations).toEqual([]);
                expect(accepted.manifest.sourceVersionId).toBe(previous.manifest.versionId);
                expect(accepted.nativePayloads).toEqual([]);
                const priorChangedFile = previous.files.find((file) => file.file.logicalPath === changedPath);
                if (priorChangedFile?.contentKind !== "text") throw new Error("Changed source file must be text");
                expect(accepted.files.find((file) => file.file.logicalPath === changedPath)).toMatchObject({
                    contentKind: "text",
                    text: priorChangedFile.text + suffix,
                });
                expect(accepted.files.filter((file) => file.file.logicalPath !== changedPath)).toEqual(
                    previous.files.filter((file) => file.file.logicalPath !== changedPath),
                );
                expect(
                    readVersionAuthority(path.join(oaamRoot, "assets"), assetId, previous.manifest.versionId, registry),
                ).toEqual(previous);
                expect(readVersionAuthority(path.join(oaamRoot, "assets"), assetId, versionId, registry)).toEqual(stored);
                expect(fs.readFileSync(targetEntry)).toEqual(targetBytes);
                expect(fs.statSync(targetEntry).mtimeMs).toBe(targetModified);
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
                previous = accepted;
            }
            const nativeEntry = path.join(targetRoot, "SKILL.md");
            const priorEntry = fs.readFileSync(nativeEntry, "utf8");
            expect(priorEntry).toMatch(/^description:/m);
            fs.writeFileSync(nativeEntry, priorEntry.replace(/^description:.*$/m, "description: Different target behavior"));
            const changedMetadata = await core.inspectDeploymentRenderedTarget(deploymentId);
            expect(changedMetadata.value.files).toEqual(
                expect.arrayContaining([expect.objectContaining({ attributionState: "conflict" })]),
            );
            const refused = await core.prepareRenderedTargetAccept({
                deploymentId,
                inspectionResultFingerprint: changedMetadata.value.inspectionResultFingerprint,
            });
            expect(refused.status).toBe("failed");
            expect(readVersionAuthority(path.join(oaamRoot, "assets"), assetId, previous.manifest.versionId, registry)).toEqual(
                previous,
            );
            expect(fs.readFileSync(nativeEntry, "utf8")).toContain("description: Different target behavior");
        }
    });
});
