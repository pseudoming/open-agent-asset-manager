/** Rule reverse staging must follow the exact applied render contract. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { publishInitialAssetVersion } from "../../src/catalog/version-authority";
import { createVersionDialectRegistry } from "../../src/catalog/version-dialect-registry";
import { deploymentLifecycleInternalsForTest } from "../../src/orchestration/deployment-lifecycle-service";
import type { UuidV4 } from "../../src/types";
import {
    ASSET_ID,
    FILE_ID,
    makeAsset,
    makeTextFile,
    makeVersionClosure,
    PROJECT_ID,
    VERSION_ID,
    VERSION_ID_2,
} from "../catalog/fixtures/version-v2";
import { type Inspected, inspectedFor, renderBase, SHA_A, SHA_B } from "./fixtures/deployment-lifecycle-test-fixtures";

describe("deployment lifecycle Rule reverse contract authority", () => {
    it("stages one legacy T5 Rule change while its applied render contract remains current", () => {
        const assetsRoot = path.join(os.tmpdir(), `oaam-stage-rule-${process.pid}-${Date.now()}`);
        const canonical = {
            kind: "Rule" as const,
            typeData: {
                schemaVersion: 2 as const,
                name: "review",
                description: "",
                activation: { mode: "always" as const },
            },
        };
        try {
            publishInitialAssetVersion({
                assetsRoot,
                transactionId: "txn-stage-rule",
                asset: makeAsset([VERSION_ID], {
                    kind: "Rule",
                    scope: "project",
                    projectId: PROJECT_ID,
                    scopePath: "",
                }),
                version: makeVersionClosure({ canonical, files: [makeTextFile("# old\n", "RULE.md")] }),
                dialectRegistry: createVersionDialectRegistry([], [], [], []),
            });
            const inspected = inspectedFor() as Inspected;
            const declarations = attachLegacyRuleReverseContract(inspected, {
                decisions: [
                    {
                        consumerOwnerAdapterId: "CLAUDECODE",
                        consumerOwnerAdapterVersion: "fixture-version",
                        outputUnitFingerprints: [SHA_A],
                        semanticRef: {
                            semanticRefFingerprint: SHA_B,
                            semanticKind: "rule.content",
                            consumerAgentRuntimeId: "CLAUDE_CODE_CLI",
                            subject: {
                                subjectKind: "file",
                                assetId: ASSET_ID,
                                versionId: VERSION_ID,
                                fileId: FILE_ID,
                            },
                        },
                    },
                ],
            });
            const base = renderBase();
            base.assets[0]!.assetKind = "Rule";
            base.assets[0]!.version.canonical = canonical;
            const configuration = {
                render: { assetsRoot, dialectRegistry: createVersionDialectRegistry([], [], [], []) },
            } as Parameters<typeof deploymentLifecycleInternalsForTest.buildStagedReverseVersionContent>[0];

            expect(
                deploymentLifecycleInternalsForTest.buildStagedReverseVersionContent(
                    configuration,
                    inspected,
                    base,
                    VERSION_ID_2 as UuidV4,
                ),
            ).toMatchObject({ canonical, files: [{ text: "# changed\n" }] });

            declarations.splice(0);
            expect(() =>
                deploymentLifecycleInternalsForTest.buildStagedReverseVersionContent(
                    configuration,
                    inspected,
                    base,
                    VERSION_ID_2 as UuidV4,
                ),
            ).toThrow(/no unique current reverse contract/);
        } finally {
            fs.rmSync(assetsRoot, { recursive: true, force: true });
        }
    });

    it("classifies Rule reverse only from one complete current applied render contract", () => {
        expect(ruleReverseContractFixture("native_project_rule_v1").classify()).toBe("native_project_rule_v1");
        expect(ruleReverseContractFixture("native_global_rule_v1").classify()).toBe("native_global_rule_v1");
        expect(ruleReverseContractFixture("native_project_exact_file_v1").classify()).toBe("native_project_exact_file_v1");

        const missingSnapshotCases: Array<(fixture: RuleReverseContractFixture) => void> = [
            (fixture) => {
                fixture.snapshot.outputUnits = undefined;
            },
            (fixture) => {
                fixture.snapshot.outputUnitRenderers = undefined;
            },
            (fixture) => {
                fixture.decision.outputUnitFingerprints = undefined;
            },
            (fixture) => {
                fixture.snapshot.outputUnits = [];
            },
            (fixture) => {
                fixture.snapshot.outputUnitRenderers = [];
            },
        ];
        for (const mutate of missingSnapshotCases) {
            const fixture = ruleReverseContractFixture();
            mutate(fixture);
            expect(fixture.classify()).toBe("unknown");
        }

        const staleAuthorityCases: Array<(fixture: RuleReverseContractFixture) => void> = [
            (fixture) => {
                fixture.state.owner = null;
            },
            (fixture) => {
                fixture.state.owner!.version = "stale-provider-version";
            },
            (fixture) => {
                fixture.snapshot.outputUnitRenderers![0]!.rendererAdapterId = "FOREIGN";
            },
            (fixture) => {
                fixture.snapshot.outputUnitRenderers![0]!.rendererAdapterVersion = "stale-renderer-version";
            },
            (fixture) => {
                fixture.state.outputContract = null;
            },
            (fixture) => {
                fixture.state.outputContract!.outputContractFingerprint = SHA_A;
            },
            (fixture) => {
                fixture.state.outputContract!.materializationProfiles = [];
            },
            (fixture) => {
                fixture.state.outputContract!.materializationProfiles[0]!.materializationProfileId = "stale-profile";
            },
            (fixture) => {
                fixture.state.outputContract!.materializationProfiles[0]!.profileConstraintFingerprint = SHA_B;
            },
        ];
        for (const mutate of staleAuthorityCases) {
            const fixture = ruleReverseContractFixture();
            mutate(fixture);
            expect(fixture.classify()).toBe("unknown");
        }

        const staleDeclarationCases: Array<(declaration: RuleReverseDeclarationFixture) => void> = [
            (declaration) => {
                declaration.agentRuntimeId = "FOREIGN_RUNTIME";
            },
            (declaration) => {
                declaration.outputContractId = "FOREIGN_CONTRACT_V1";
            },
            (declaration) => {
                declaration.materializationProfileId = "foreign-profile";
            },
            (declaration) => {
                declaration.declarationKind = "native_project_guidance_v1";
            },
            (declaration) => {
                declaration.declarationKind = "native_project_exact_file_v1";
                declaration.assetKind = "Skill";
            },
        ];
        for (const mutate of staleDeclarationCases) {
            const fixture = ruleReverseContractFixture();
            mutate(fixture.state.owner!.renderContractDeclarations[0]!);
            expect(fixture.classify()).toBe("unknown");
        }

        const duplicate = ruleReverseContractFixture();
        duplicate.state.owner!.renderContractDeclarations.push(
            structuredClone(duplicate.state.owner!.renderContractDeclarations[0]!),
        );
        expect(duplicate.classify()).toBe("unknown");
    });
});

function attachLegacyRuleReverseContract(
    inspected: Inspected,
    input: { decisions: unknown[] },
): Array<{ declarationKind: "native_project_rule_v1" }> {
    const outputContractId = "FIXTURE_NATIVE_PROJECT_RULE_V1";
    const materializationProfileId = "fixture-native-project-rule";
    const declarations = [
        {
            schemaVersion: 1 as const,
            declarationKind: "native_project_rule_v1" as const,
            outputContractId,
            materializationProfileId,
            agentRuntimeId: "CLAUDE_CODE_CLI" as const,
        },
    ];
    Object.assign(inspected, {
        appliedRenderSnapshot: {
            decisions: input.decisions,
            outputUnits: [
                {
                    outputUnitFingerprint: SHA_A,
                    outputContractId,
                    outputContractFingerprint: SHA_B,
                },
            ],
            outputUnitRenderers: [
                {
                    outputUnitFingerprint: SHA_A,
                    rendererAdapterId: "CLAUDECODE",
                    rendererAdapterVersion: "fixture-version",
                    materializationProfileId,
                    profileConstraintFingerprint: SHA_A,
                },
            ],
        },
        operation: {
            registry: {
                getProvider(adapterId: string) {
                    return adapterId === "CLAUDECODE"
                        ? {
                              adapterId: "CLAUDECODE",
                              version: "fixture-version",
                              renderContractDeclarations: declarations,
                          }
                        : null;
                },
                getOutputContract(candidateId: string) {
                    return candidateId === outputContractId
                        ? {
                              outputContractFingerprint: SHA_B,
                              materializationProfiles: [
                                  {
                                      materializationProfileId,
                                      profileConstraintFingerprint: SHA_A,
                                  },
                              ],
                          }
                        : null;
                },
            },
        },
    });
    return declarations;
}

type RuleReverseDeclarationFixture = {
    schemaVersion: 1;
    declarationKind:
        | "native_project_rule_v1"
        | "native_global_rule_v1"
        | "native_project_exact_file_v1"
        | "native_project_guidance_v1";
    outputContractId: string;
    materializationProfileId: string;
    agentRuntimeId: string;
    assetKind?: "Rule" | "Skill";
};

type RuleReverseContractFixture = ReturnType<typeof ruleReverseContractFixture>;

function ruleReverseContractFixture(
    declarationKind:
        | "native_project_rule_v1"
        | "native_global_rule_v1"
        | "native_project_exact_file_v1" = "native_project_rule_v1",
) {
    const outputContractId = "FIXTURE_RULE_REVERSE_CONTRACT_V1";
    const materializationProfileId = "fixture-rule-reverse-profile";
    const decision = {
        consumerOwnerAdapterId: "CLAUDECODE",
        consumerOwnerAdapterVersion: "fixture-provider-version",
        outputUnitFingerprints: [SHA_A] as string[] | undefined,
        semanticRef: {
            consumerAgentRuntimeId: "CLAUDE_CODE_CLI",
        },
    };
    const snapshot: {
        decisions: unknown[];
        outputUnits?: Array<{
            outputUnitFingerprint: string;
            outputContractId: string;
            outputContractFingerprint: string;
        }>;
        outputUnitRenderers?: Array<{
            outputUnitFingerprint: string;
            rendererAdapterId: string;
            rendererAdapterVersion: string;
            materializationProfileId: string;
            profileConstraintFingerprint: string;
        }>;
    } = {
        decisions: [decision],
        outputUnits: [
            {
                outputUnitFingerprint: SHA_A,
                outputContractId,
                outputContractFingerprint: SHA_B,
            },
        ],
        outputUnitRenderers: [
            {
                outputUnitFingerprint: SHA_A,
                rendererAdapterId: "CLAUDECODE",
                rendererAdapterVersion: "fixture-provider-version",
                materializationProfileId,
                profileConstraintFingerprint: SHA_A,
            },
        ],
    };
    const declaration: RuleReverseDeclarationFixture = {
        schemaVersion: 1,
        declarationKind,
        outputContractId,
        materializationProfileId,
        agentRuntimeId: "CLAUDE_CODE_CLI",
        ...(declarationKind === "native_project_exact_file_v1" ? { assetKind: "Rule" as const } : {}),
    };
    const state: {
        owner: {
            adapterId: string;
            version: string;
            renderContractDeclarations: RuleReverseDeclarationFixture[];
        } | null;
        outputContract: {
            outputContractFingerprint: string;
            materializationProfiles: Array<{
                materializationProfileId: string;
                profileConstraintFingerprint: string;
            }>;
        } | null;
    } = {
        owner: {
            adapterId: "CLAUDECODE",
            version: "fixture-provider-version",
            renderContractDeclarations: [declaration],
        },
        outputContract: {
            outputContractFingerprint: SHA_B,
            materializationProfiles: [{ materializationProfileId, profileConstraintFingerprint: SHA_A }],
        },
    };
    const inspected = inspectedFor() as Inspected;
    Object.assign(inspected, {
        appliedRenderSnapshot: snapshot,
        operation: {
            registry: {
                getProvider(adapterId: string) {
                    return adapterId === "CLAUDECODE" ? state.owner : null;
                },
                getOutputContract(candidateId: string) {
                    return candidateId === outputContractId ? state.outputContract : null;
                },
            },
        },
    });
    return {
        inspected,
        decision,
        snapshot,
        state,
        classify() {
            return deploymentLifecycleInternalsForTest.appliedRuleReverseContractKind(
                inspected,
                decision as Parameters<typeof deploymentLifecycleInternalsForTest.appliedRuleReverseContractKind>[1],
            );
        },
    };
}
