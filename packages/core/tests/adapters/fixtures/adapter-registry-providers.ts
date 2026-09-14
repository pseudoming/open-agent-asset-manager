import {
    createNativeProjectGuidanceProviderSupport,
    createVerifiedNativeProjectGuidanceBuild,
} from "../../../src/render/native-project-guidance";
import type { AdapterId, AdapterProvider, Sha256Digest } from "../../../src/types";
import { makeContractProvider } from "./adapter-contract-fixtures";

export function makeNativeGuidanceProvider(adapterId: AdapterId): AdapterProvider {
    const provider = makeContractProvider(adapterId);
    const agentRuntimeId = provider.agentRuntimes[0]?.agentRuntimeId;
    if (agentRuntimeId === undefined) throw new Error("test provider descriptor is missing");
    const materializationProfileId = `${adapterId.toLowerCase()}-project-guidance-v1`;
    const support = createNativeProjectGuidanceProviderSupport({
        adapterId,
        adapterVersion: provider.version,
        agentRuntimes: provider.agentRuntimes,
        agentRuntimeId,
        outputContractId: `${adapterId}_NATIVE_PROJECT_GUIDANCE_V1`,
        materializationProfileId,
        target: {
            relativePath: "MOCK.md",
            targetContextSchemaId: `${adapterId}_PROJECT_GUIDANCE_TARGET_V1`,
            requiredFacts: {},
        },
        verifiedBuilds: [
            createVerifiedNativeProjectGuidanceBuild({
                agentRuntimeId,
                versionText: "1.0.0",
                buildIdentity: `sha256:${"3".repeat(64)}` as Sha256Digest,
                platform: "linux",
                materializationProfileId,
                fixtureId: `${adapterId.toLowerCase()}-project-guidance-fixture`,
                targetRelativePath: "MOCK.md",
                exactLoadMarker: "OAAM_MOCK_PROJECT_GUIDANCE",
                reverseFixtureId: "mock-project-guidance-reverse-v1",
            }),
        ],
    });
    provider.targetContextSchemas = [support.targetContextSchema];
    provider.assetTargetCapabilities = provider.assetTargetCapabilities.map((capability) =>
        capability.assetKind === "Guidance" ? support.targetCapability : capability,
    );
    provider.materializerCapabilities = [support.materializerCapability];
    provider.renderContractDeclarations = [structuredClone(support.renderContractDeclaration)];
    provider.analyzeRender = async (input) => support.analyze(input);
    provider.materializeRender = async (input) => support.materialize(input);
    provider.inspectRenderedTarget = async (input) => support.inspect(input);
    return provider;
}
