/** Global-scope constructor and asset-shape coverage for native declaration contracts. */

import { describe, expect, it } from "vitest";
import { computeTargetApplicabilityFingerprint } from "../../src/foundation/fingerprint";
import {
    createNativeGlobalEncodedFileProviderSupport,
    createVerifiedNativeGlobalEncodedFileBuild,
} from "../../src/render/native-project-encoded-file";
import { makeEncodedFileApplicabilityPredicateRef } from "../../src/render/native-project-encoded-file-profiles";
import {
    createNativeGlobalGuidanceProviderSupport,
    createVerifiedNativeGlobalGuidanceBuild,
} from "../../src/render/native-project-guidance";
import { makeApplicabilityPredicate } from "../../src/render/native-project-guidance-behavior";
import { applicabilityPredicateRef, findNativeGuidanceDeclaration } from "../../src/render/native-project-guidance-profiles";
import { findExactGuidanceAsset } from "../../src/render/native-project-guidance-results";
import { createNativeGlobalRuleProviderSupport, createVerifiedNativeGlobalRuleBuild } from "../../src/render/native-project-rule";
import { makeRuleApplicabilityPredicateRef } from "../../src/render/native-project-rule-profiles";
import { findExactRuleAsset } from "../../src/render/native-project-rule-results";
import {
    ENCODED_DIALECT_ID,
    ENCODED_ENTRY_LOGICAL_PATH,
    ENCODED_OUTPUT_CONTRACT_ID,
    ENCODED_PARSER_REF,
    ENCODED_PATH_REF,
    ENCODED_PROMPT_LOGICAL_PATH,
    ENCODED_REBASE_REF,
    ENCODED_TARGET_PATH,
    decodeEncodedNativeFile,
    encodedRebaseMaterializer,
    makeEncodedFileFixture,
} from "./fixtures/native-project-encoded-file-test-fixtures";
import { makeFixture as makeGuidanceFixture } from "./fixtures/native-project-guidance-test-fixtures";
import { RULE_OUTPUT_CONTRACT_ID, makeRuleFixture } from "./fixtures/native-project-rule-test-fixtures";

describe("native global declaration contracts", () => {
    it("constructs and resolves a global Guidance declaration without accepting project scope", () => {
        const fixture = makeGuidanceFixture("claude");
        const build = createVerifiedNativeGlobalGuidanceBuild({
            agentRuntimeId: fixture.build.agentRuntimeId,
            versionText: fixture.build.versionText,
            buildIdentity: fixture.build.buildIdentity,
            platform: fixture.build.platform,
            materializationProfileId: "fixture-cli-global-guidance-v1",
            fixtureId: "fixture-cli-global-guidance-2026-08-04",
            targetRelativePath: "CLAUDE.md",
            exactLoadMarker: "OAAM_GLOBAL_GUIDANCE",
            reverseFixtureId: "native-global-guidance-whole-file-reverse-v1",
        });
        const support = createNativeGlobalGuidanceProviderSupport({
            adapterId: fixture.provider.adapterId,
            adapterVersion: fixture.provider.version,
            agentRuntimes: fixture.provider.agentRuntimes,
            agentRuntimeId: fixture.agentRuntimeId,
            outputContractId: "FIXTURE_NATIVE_GLOBAL_GUIDANCE_V1",
            materializationProfileId: build.materializationProfileId,
            target: {
                relativePath: "CLAUDE.md",
                targetContextSchemaId: "FIXTURE_CLI_GLOBAL_TARGET_V1",
                requiredFacts: {},
            },
            verifiedBuilds: [build],
        });
        const provider = {
            ...fixture.provider,
            renderContractDeclarations: [fixture.support.renderContractDeclaration, support.renderContractDeclaration],
        };
        expect(findNativeGuidanceDeclaration(provider, fixture.agentRuntimeId, "project")).toBe(
            fixture.support.renderContractDeclaration,
        );
        expect(findNativeGuidanceDeclaration(provider, fixture.agentRuntimeId, "global")).toBe(support.renderContractDeclaration);
        expect(() => findNativeGuidanceDeclaration(provider, "FOREIGN", "global")).toThrow(/exactly one/);
        expect(makeApplicabilityPredicate(support.renderContractDeclaration, build).ref.componentId).toContain(
            "native-global-guidance",
        );
        expect(applicabilityPredicateRef(build).componentId).toContain("native-project-guidance");

        expect(findExactGuidanceAsset(fixture.analysisInput.deployment)).not.toBeNull();
        expect(findExactGuidanceAsset(fixture.analysisInput.deployment, "global")).toBeNull();
        const globalDeployment = structuredClone(fixture.analysisInput.deployment);
        globalDeployment.assets[0]!.scope = "global";
        globalDeployment.assets[0]!.projectId = "";
        expect(findExactGuidanceAsset(globalDeployment, "global")).not.toBeNull();
        expect(findExactGuidanceAsset(globalDeployment, "project")).toBeNull();
    });

    it("constructs a global Rule declaration and keeps project/global asset shapes disjoint", () => {
        const fixture = makeRuleFixture();
        const build = createVerifiedNativeGlobalRuleBuild({
            agentRuntimeId: fixture.build.agentRuntimeId,
            versionText: fixture.build.versionText,
            buildIdentity: fixture.build.buildIdentity,
            platform: fixture.build.platform,
            materializationProfileId: "fixture-cli-global-rule-v1",
            fixtureId: "fixture-cli-global-rule-2026-08-04",
            targetRelativeDirectory: "rules",
            targetFileNameSuffix: ".md",
            fixtureRuleName: "typescript-review",
            exactLoadMarker: "OAAM_GLOBAL_RULE",
            reverseFixtureId: "native-global-rule-whole-file-reverse-v1",
        });
        const support = createNativeGlobalRuleProviderSupport({
            adapterId: fixture.provider.adapterId,
            adapterVersion: fixture.provider.version,
            agentRuntimes: fixture.provider.agentRuntimes,
            agentRuntimeId: fixture.descriptor.agentRuntimeId,
            outputContractId: `${RULE_OUTPUT_CONTRACT_ID}_GLOBAL`,
            materializationProfileId: build.materializationProfileId,
            target: {
                relativeDirectory: "rules",
                fileNameSuffix: ".md",
                targetContextSchemaId: "FIXTURE_CLI_GLOBAL_TARGET_V1",
                requiredFacts: {},
            },
            verifiedBuilds: [build],
        });
        expect(support.renderContractDeclaration).toMatchObject({
            declarationKind: "native_global_rule_v1",
            materializationProfileId: "fixture-cli-global-rule-v1",
        });
        expect(makeRuleApplicabilityPredicateRef(build).componentId).toContain("native-project-rule");

        expect(findExactRuleAsset(fixture.analysisInput.deployment)).not.toBeNull();
        expect(findExactRuleAsset(fixture.analysisInput.deployment, "global")).toBeNull();
        const globalDeployment = structuredClone(fixture.analysisInput.deployment);
        globalDeployment.assets[0]!.scope = "global";
        globalDeployment.assets[0]!.projectId = "";
        expect(findExactRuleAsset(globalDeployment, "global")).not.toBeNull();
        expect(findExactRuleAsset(globalDeployment, "project")).toBeNull();
    });

    it("constructs a global encoded Subagent contract and rejects each invalid graph-path shape", () => {
        const fixture = makeEncodedFileFixture();
        const buildInput = {
            agentRuntimeId: fixture.descriptor.agentRuntimeId,
            versionText: "1.2.3",
            buildIdentity: `sha256:${"3".repeat(64)}` as const,
            platform: "wsl" as const,
            materializationProfileId: "fixture-cli-global-subagent-encoded-v1",
            fixtureId: "fixture-cli-global-subagent-encoded-2026-08-04",
            nativeDialectId: ENCODED_DIALECT_ID,
            globalPathValidator: ENCODED_PATH_REF,
            reverseParser: ENCODED_PARSER_REF,
            rebaseMaterializer: ENCODED_REBASE_REF,
            restorationDialectIds: [] as readonly string[],
            parentRebaseFixtureId: "fixture-cli-global-subagent-parent-v1",
            targetRelativePath: ENCODED_TARGET_PATH,
            canonicalLogicalPaths: [ENCODED_ENTRY_LOGICAL_PATH, ENCODED_PROMPT_LOGICAL_PATH],
            exactLoadMarker: "OAAM_GLOBAL_SUBAGENT",
            reverseFixtureId: "native-global-subagent-encoded-reverse-v1",
        };
        const build = createVerifiedNativeGlobalEncodedFileBuild(buildInput);
        const support = createNativeGlobalEncodedFileProviderSupport({
            adapterId: "FIXTURE",
            adapterVersion: "0.1.0",
            agentRuntimes: [fixture.descriptor],
            agentRuntimeId: fixture.descriptor.agentRuntimeId,
            outputContractId: `${ENCODED_OUTPUT_CONTRACT_ID}_GLOBAL`,
            materializationProfileId: build.materializationProfileId,
            nativeDialectId: ENCODED_DIALECT_ID,
            globalPathValidator: { ref: ENCODED_PATH_REF, validate: (value) => value === ENCODED_TARGET_PATH },
            reverseParser: { ref: ENCODED_PARSER_REF, decode: decodeEncodedNativeFile },
            rebaseMaterializer: encodedRebaseMaterializer,
            restorationDialectIds: [],
            target: {
                targetContextSchemaId: "FIXTURE_CLI_GLOBAL_TARGET_V1",
                requiredFacts: { "fixture.mode": "encoded" },
            },
            verifiedBuilds: [build],
        });
        expect(support.renderContractDeclaration).toMatchObject({
            declarationKind: "native_global_encoded_file_v1",
            materializationProfileId: "fixture-cli-global-subagent-encoded-v1",
        });
        expect(makeEncodedFileApplicabilityPredicateRef(build).componentId).toContain("native-project-encoded-file");

        const analysisInput = structuredClone(fixture.analysisInput);
        analysisInput.deployment.assets[0]!.scope = "global";
        analysisInput.deployment.assets[0]!.projectId = "";
        const context = analysisInput.deployment.targetContexts[0]!;
        context.targetContextSchemaId = support.targetContextSchema.targetContextSchemaId;
        context.targetContextSchemaFingerprint = support.targetContextSchema.schemaFingerprint;
        context.renderFacts = [
            { key: "fixture.mode", value: "encoded", evidenceLevel: "agent_runtime_verified" },
            { key: "oaam.platform", value: "wsl", evidenceLevel: "agent_runtime_verified" },
        ];
        context.targetApplicabilityFingerprint = computeTargetApplicabilityFingerprint({
            context: {
                schemaVersion: context.schemaVersion,
                agentRuntimeId: context.agentRuntimeId,
                versionText: context.versionText,
                buildIdentity: context.buildIdentity,
                targetContextSchemaId: context.targetContextSchemaId,
                targetContextSchemaFingerprint: context.targetContextSchemaFingerprint,
                renderFacts: context.renderFacts,
            },
            entryClass: fixture.descriptor.entryClass,
        });
        expect(support.analyze(analysisInput).status).toBe("complete");

        const invalidPaths = [
            { targetRelativePath: "/absolute.md", canonicalLogicalPaths: [ENCODED_ENTRY_LOGICAL_PATH] },
            { targetRelativePath: ENCODED_TARGET_PATH, canonicalLogicalPaths: [] },
            {
                targetRelativePath: ENCODED_TARGET_PATH,
                canonicalLogicalPaths: [ENCODED_ENTRY_LOGICAL_PATH, ENCODED_PROMPT_LOGICAL_PATH, "third.md"],
            },
            {
                targetRelativePath: ENCODED_TARGET_PATH,
                canonicalLogicalPaths: [ENCODED_ENTRY_LOGICAL_PATH, ENCODED_ENTRY_LOGICAL_PATH],
            },
            { targetRelativePath: ENCODED_TARGET_PATH, canonicalLogicalPaths: ["../escape.md"] },
        ];
        for (const paths of invalidPaths) {
            expect(() => createVerifiedNativeGlobalEncodedFileBuild({ ...buildInput, ...paths } as never)).toThrow(
                /fixture paths are invalid/,
            );
        }
    });
});
