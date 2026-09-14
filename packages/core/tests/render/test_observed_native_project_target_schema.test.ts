import { describe, expect, it } from "vitest";
import {
    createNativeProjectGuidanceProviderSupport,
    resolveObservedNativeProjectTargetContextForTest,
} from "../../src/render/native-project-guidance";
import { makeFixture } from "./fixtures/observed-native-project-guidance-test-fixtures";

describe("observed native project target Asset schema", () => {
    it("uses the exact Asset capability schema instead of borrowing a sibling declaration for the same runtime", () => {
        const fixture = makeFixture();
        const descriptor = fixture.input.provider.agentRuntimes[0];
        const originalSchemaId = fixture.input.provider.renderContractDeclarations[0]?.target.targetContextSchemaId;
        if (descriptor === undefined || originalSchemaId === undefined) {
            throw new Error("target-context schema fixture is missing");
        }
        const sibling = createNativeProjectGuidanceProviderSupport({
            adapterId: fixture.input.provider.adapterId,
            adapterVersion: fixture.input.provider.version,
            agentRuntimes: [descriptor],
            agentRuntimeId: fixture.build.agentRuntimeId,
            outputContractId: "FIXTURE_SIBLING_NATIVE_PROJECT_GUIDANCE_V1",
            materializationProfileId: "fixture-sibling-project-guidance-v1",
            target: {
                relativePath: "SIBLING.md",
                targetContextSchemaId: "FIXTURE_SIBLING_PROJECT_TARGET_V1",
                requiredFacts: {},
            },
            verifiedBuilds: [
                {
                    ...fixture.build,
                    materializationProfileId: "fixture-sibling-project-guidance-v1",
                },
            ],
        });
        fixture.input.provider.targetContextSchemas.push(sibling.targetContextSchema);
        fixture.input.provider.renderContractDeclarations.push(sibling.renderContractDeclaration);

        expect(resolveObservedNativeProjectTargetContextForTest(fixture.input, fixture.dependencies)).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "native_guidance_provider_declaration_invalid" }],
        });

        fixture.input.targetContextSchemaIds = [originalSchemaId];
        expect(resolveObservedNativeProjectTargetContextForTest(fixture.input, fixture.dependencies)).toMatchObject({
            status: "complete",
            targetContext: { targetContextSchemaId: originalSchemaId },
            diagnostics: [],
        });

        fixture.input.targetContextSchemaIds = ["FIXTURE_UNKNOWN_PROJECT_TARGET_V1"];
        expect(resolveObservedNativeProjectTargetContextForTest(fixture.input, fixture.dependencies)).toMatchObject({
            status: "failed",
            diagnostics: [{ code: "native_guidance_provider_declaration_invalid" }],
        });
    });
});
