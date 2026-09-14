/** Global-scope authority and compatibility guards for exact native graphs. */

import { describe, expect, it } from "vitest";
import { validateAdapterRenderContractRegistration } from "../../src/render/adapter-render-contract-registration";
import { makeNativeProjectExactGraphContractParts } from "../../src/render/native-project-exact-graph";
import { makeExactGraphApplicabilityPredicateRef } from "../../src/render/native-project-exact-graph-profiles";
import {
    asExactGraphProvider,
    exactGraphMaterializationInput,
    makeExactGraphFixture,
    makeGlobalExactGraphFixture,
} from "./fixtures/native-project-exact-graph-test-fixtures";

describe("native global exact-graph contract", () => {
    it("registers and materializes one global Asset without manufacturing a Project identity", () => {
        const fixture = makeGlobalExactGraphFixture();
        expect(validateAdapterRenderContractRegistration([asExactGraphProvider(fixture)])).toEqual([]);
        expect(fixture.support.renderContractDeclaration).toMatchObject({
            declarationKind: "native_global_exact_graph_v1",
            agentRuntimeId: fixture.descriptor.agentRuntimeId,
            assetKind: "Skill",
        });
        expect(fixture.deployment).toMatchObject({ projectId: "", assets: [{ scope: "global", projectId: "" }] });
        expect(fixture.components.targetApplicabilityPredicates[0]!.ref.componentId).toContain("native-global-exact-graph");

        const analysis = fixture.support.analyze(fixture.analysisInput);
        expect(analysis).toMatchObject({ status: "complete", blockedSemanticRefs: [] });
        expect(analysis.semanticOptions.every((option) => option.reasonCode === "native_global_exact_graph_preserved")).toBe(
            true,
        );
        const materialization = fixture.support.materialize(exactGraphMaterializationInput(fixture));
        expect(materialization).toMatchObject({ status: "complete", materializationState: "materialized" });
    });

    it("keeps project and global Assets on opposite fail-closed scope branches", () => {
        const globalProjectAsset = makeGlobalExactGraphFixture();
        globalProjectAsset.analysisInput.deployment.assets[0]!.scope = "project";
        globalProjectAsset.analysisInput.deployment.assets[0]!.projectId = globalProjectAsset.deployment.deploymentId;
        expect(globalProjectAsset.support.analyze(globalProjectAsset.analysisInput)).toMatchObject({
            status: "failed",
            outputUnits: [],
        });

        const globalWithProjectIdentity = makeGlobalExactGraphFixture();
        globalWithProjectIdentity.analysisInput.deployment.assets[0]!.projectId =
            globalWithProjectIdentity.deployment.deploymentId;
        expect(globalWithProjectIdentity.support.analyze(globalWithProjectIdentity.analysisInput)).toMatchObject({
            status: "failed",
            outputUnits: [],
        });

        const projectGlobalAsset = makeExactGraphFixture();
        projectGlobalAsset.analysisInput.deployment.assets[0]!.scope = "global";
        projectGlobalAsset.analysisInput.deployment.assets[0]!.projectId = "";
        expect(projectGlobalAsset.support.analyze(projectGlobalAsset.analysisInput)).toMatchObject({
            status: "failed",
            outputUnits: [],
        });
    });

    it("preserves the frozen project-v1 contract and build identities while deriving a distinct global contract", () => {
        const project = makeExactGraphFixture();
        const global = makeGlobalExactGraphFixture();
        const projectContract = makeNativeProjectExactGraphContractParts(project.support.renderContractDeclaration);
        const globalContract = makeNativeProjectExactGraphContractParts(global.support.renderContractDeclaration);

        expect(project.build.fixtureSetFingerprint).toBe(
            "sha256:98eabcf3838fda08f1f2c4e6c3582e1dd086da89e1b5513ad3160e9712098645",
        );
        expect(projectContract.outputContract.outputContractFingerprint).toBe(
            "sha256:6d0941f3be53a9baf4bce0f3072e88d91038188366404479171bb6218c0b0bc7",
        );
        expect(projectContract.outputContract.materializationProfiles[0]!.profileConstraintFingerprint).toBe(
            "sha256:61de3da43ea66ce4866f30d304d39efa34ed66b938a64a03aa37c4a2320ca511",
        );
        expect(makeExactGraphApplicabilityPredicateRef(project.build)).toEqual(
            makeExactGraphApplicabilityPredicateRef(project.build, "project"),
        );
        expect(global.build.fixtureSetFingerprint).not.toBe(project.build.fixtureSetFingerprint);
        expect(globalContract.outputContract.outputContractFingerprint).not.toBe(
            projectContract.outputContract.outputContractFingerprint,
        );
        expect(globalContract.profile.targetScope).toBe("global");
    });

    it("rejects malformed global validator authority at registration", () => {
        const fixture = makeGlobalExactGraphFixture();
        const provider = asExactGraphProvider(fixture);
        const declaration = provider.renderContractDeclarations[0];
        if (declaration?.declarationKind !== "native_global_exact_graph_v1") {
            throw new Error("global exact graph declaration fixture is missing");
        }
        declaration.globalGraphValidator.componentId = "";
        expect(validateAdapterRenderContractRegistration([provider])[0]?.message).toMatch(/global graph validator/);
    });
});
