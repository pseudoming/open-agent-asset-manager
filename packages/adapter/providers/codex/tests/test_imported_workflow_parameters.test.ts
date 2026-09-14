import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RenderDeploymentInput, UuidV4 } from "@oaam/core";
import { readVersionAuthority } from "../../../core/src/catalog/version-authority";
import { deriveRequiredRenderSemanticsV1 } from "../../../core/src/render/render-semantics";
import { resolveProviderExactFileDialectInputs } from "../../../core/src/render/render-dialect-authority";
import {
    bindAcceptFixtureCandidate,
    bindAuthoritativeFixtureRead,
    bindDialectRegistry,
    bindFixtureImportService,
    bindFixtureProbeRootTarget,
} from "../../../test-support";
import { claudecodeProvider } from "../../claudecode/src/claudecode-provider";
import { projectRoot } from "../../claudecode/tests/claudecode-test-fixtures";
import { codexProvider } from "../src/codex-provider";
import { createCodexWorkflowMigrationTargetSupports } from "../src/codex-target-workflow-migration";

const HASH = `sha256:${"8".repeat(64)}` as const;
const PROJECT_ID = "11111111-1111-4111-8111-111111111111" as UuidV4;
let sandbox = "";
beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-workflow-parameters-"));
});
afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("source-authentic Workflow parameter conversion", () => {
    it.each([
        ["Review $ARGUMENTS.\n", "failed"],
        ["Review $ARGUMENTS[0].\n", "failed"],
        ["Review $0 and $1.\n", "failed"],
        ["Review !`printf ready`.\n", "failed"],
        ["```!\nprintf ready\n```\n", "failed"],
        ["Read ${CLAUDE_SKILL_DIR}/checklist.md.\n", "failed"],
        ["Review session ${CLAUDE_SESSION_ID}.\n", "failed"],
        ["```bash\nprintf '%s\\n' \"$TARGET_DIR\"\n```\n", "complete"],
        ["Keep adjacent code spans literal: `foo`!`bar`.\n", "complete"],
    ] as const)("checks actual imported Claude command semantics before migrating %s", async (body, expectedStatus) => {
        const project = path.join(sandbox, "project");
        const transactions = path.join(sandbox, "transactions");
        const assets = path.join(sandbox, "assets");
        fs.mkdirSync(path.join(project, ".claude", "commands"), { recursive: true });
        fs.mkdirSync(transactions);
        const source = `---\ndescription: Review the selected change\n---\n${body}`;
        fs.writeFileSync(path.join(project, ".claude", "commands", "review.md"), source);
        const target = bindFixtureProbeRootTarget({
            adapterId: "CLAUDECODE",
            agentRuntimeId: "CLAUDE_CODE_CLI",
            versionText: "fixture",
            installationStatus: "available",
            projectDiscoveryStatus: "complete",
            installationEvidence: [
                { kind: "executable", path: "/fixture/claude", evidenceLevel: "local_artifact", diagnostics: [] },
            ],
        });
        const readSource = bindAuthoritativeFixtureRead({
            provider: claudecodeProvider,
            target,
            transactionsRoot: () => transactions,
        });
        const readAgain = () => readSource({ ...projectRoot(), path: project }, ["Workflow"]);
        const read = await readAgain();
        const candidate = read.candidates[0]!;
        expect(read.candidates).toHaveLength(1);
        expect(candidate).toMatchObject({
            kind: "Workflow",
            status: "complete",
            typeData: { invocation: { argumentNames: [], argumentHint: "" } },
        });
        const service = bindFixtureImportService({
            provider: claudecodeProvider,
            assetsRoot: () => assets,
            oaamRoot: () => path.join(sandbox, "oaam"),
            authorityLocksRoot: () => path.join(sandbox, "locks"),
            projectRootPath: () => project,
            projectId: PROJECT_ID,
        })(readAgain);
        const accepted = await bindAcceptFixtureCandidate("workflow-parameter-conformance")(service, read, candidate.candidateId);
        expect(accepted.status, JSON.stringify(accepted.diagnostics)).toBe("complete");
        const closure = readVersionAuthority(
            assets,
            accepted.value.assetId,
            accepted.value.versionId,
            bindDialectRegistry(claudecodeProvider)(),
        );
        if (closure?.manifest.kind !== "Workflow") throw new Error("saved Workflow Version missing");
        expect(closure.manifest.typeData.implementation).toMatchObject({
            instructionDialectId: "claudecode-command-markdown-v1",
            execution: { shell: { mode: "selected", dialectId: "claudecode-shell-selector-v1", selector: "bash" } },
        });
        expect(Buffer.from(closure.nativePayloads[0]!.files[0]!.bytes).toString("utf8")).toBe(source);
        const support = createCodexWorkflowMigrationTargetSupports({
            adapterVersion: codexProvider.version,
            agentRuntimes: codexProvider.agentRuntimes,
        }).CODEX_CLI.project;
        const anchor = support.renderContractDeclaration.verifiedBuilds.find((build) => build.platform === "wsl")!;
        const deployment: RenderDeploymentInput = {
            schemaVersion: 1,
            deploymentId: "22222222-2222-4222-8222-222222222222",
            consumerAgentRuntimeIds: ["CODEX_CLI"],
            platform: "wsl",
            platformInstanceId: "test-wsl",
            targetRootPath: project,
            projectId: PROJECT_ID,
            renderRegistryFingerprint: HASH,
            renderInputFingerprint: HASH,
            targetContexts: [
                {
                    schemaVersion: 1,
                    agentRuntimeId: "CODEX_CLI",
                    versionText: anchor.versionText,
                    buildIdentity: anchor.buildIdentity,
                    targetContextSchemaId: support.targetContextSchema.targetContextSchemaId,
                    targetContextSchemaFingerprint: support.targetContextSchema.schemaFingerprint,
                    targetApplicabilityFingerprint: HASH,
                    renderFacts: [
                        { key: "oaam.platform", value: "wsl", evidenceLevel: "agent_runtime_verified" },
                        { key: "oaam.project-binding", value: "registered", evidenceLevel: "user_provided" },
                    ],
                },
            ],
            assets: [
                {
                    scope: "project",
                    projectId: PROJECT_ID,
                    scopePath: "",
                    allowIncomplete: false,
                    version: {
                        ref: { assetId: closure.manifest.assetId, versionId: closure.manifest.versionId },
                        versionFingerprint: closure.manifest.fingerprint,
                        versionCanonicalContentFingerprint: closure.manifest.versionCanonicalContentFingerprint,
                        status: closure.manifest.status,
                        canonical: { kind: "Workflow", typeData: closure.manifest.typeData },
                        files: closure.files,
                    },
                    sectionHandles: Object.fromEntries(closure.files.map((file) => [file.file.fileId, "workflow-entry"])),
                },
            ],
        };
        const requiredSemantics = deriveRequiredRenderSemanticsV1(deployment);
        const dialectInputs = resolveProviderExactFileDialectInputs({
            provider: codexProvider,
            deployment,
            semantics: requiredSemantics,
            available: [],
        });
        const analysis = support.analyze({ schemaVersion: 1, deployment, requiredSemantics, dialectInputs });
        expect(analysis.status, JSON.stringify(analysis.diagnostics)).toBe(expectedStatus);
        if (expectedStatus === "complete") {
            expect(analysis.semanticOptions).toHaveLength(requiredSemantics.length);
            expect(analysis.semanticOptions).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        outcome: "degraded",
                        reasonCode: "codex_workflow_converted_to_skill",
                        approvalRequirement: expect.objectContaining({ approvalState: "required" }),
                    }),
                ]),
            );
        }
        expect(fs.readFileSync(path.join(project, ".claude", "commands", "review.md"), "utf8")).toBe(source);
    });
});
