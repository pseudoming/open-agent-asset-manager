/** Registration identity guards for sibling native project-Guidance targets. */

import { describe, expect, it } from "vitest";
import type { AdapterProviderSummary } from "../../src/contracts/source-import";
import {
    createNativeProjectGuidanceProviderSupport,
    createVerifiedNativeProjectGuidanceBuild,
    nativeProjectGuidanceRegistryComponents,
} from "../../src/render/native-project-guidance";
import { createRenderRegistry } from "../../src/render/render-registry";
import { makeFixture } from "./fixtures/native-project-guidance-test-fixtures";

const APP_PROFILE_ID = "fixture-app-project-guidance-v1";
const APP_OUTPUT_CONTRACT_ID = "FIXTURE_APP_NATIVE_PROJECT_GUIDANCE_V1";
const APP_MATERIALIZER_KEY = "fixture.app-project-guidance-native-v1";

function makeSiblingAppSupport(
    fixture: ReturnType<typeof makeFixture>,
    materializerCapabilityKey: string | undefined = APP_MATERIALIZER_KEY,
) {
    const descriptor = {
        agentRuntimeId: "FIXTURE_APP",
        displayName: "Fixture App",
        entryClass: "app" as const,
    };
    const build = createVerifiedNativeProjectGuidanceBuild({
        agentRuntimeId: descriptor.agentRuntimeId,
        versionText: "2.3.4",
        buildIdentity: `sha256:${"8".repeat(64)}`,
        platform: "win32",
        materializationProfileId: APP_PROFILE_ID,
        fixtureId: "fixture-app-2.3.4-project-guidance-2026-08-02",
        targetRelativePath: "AGENTS.md",
        exactLoadMarker: "OAAM_FIXTURE_APP_GUIDANCE_MARKER",
        reverseFixtureId: "fixture-app-project-guidance-whole-file-reverse-v1",
    });
    const support = createNativeProjectGuidanceProviderSupport({
        adapterId: fixture.provider.adapterId,
        adapterVersion: fixture.provider.version,
        agentRuntimes: [fixture.descriptor, descriptor],
        agentRuntimeId: descriptor.agentRuntimeId,
        outputContractId: APP_OUTPUT_CONTRACT_ID,
        materializationProfileId: APP_PROFILE_ID,
        ...(materializerCapabilityKey === undefined ? {} : { materializerCapabilityKey }),
        target: {
            relativePath: "AGENTS.md",
            targetContextSchemaId: "FIXTURE_APP_PROJECT_GUIDANCE_TARGET_V1",
            requiredFacts: {},
        },
        verifiedBuilds: [build],
    });
    return { descriptor, support };
}

function siblingProvider(
    fixture: ReturnType<typeof makeFixture>,
    sibling: ReturnType<typeof makeSiblingAppSupport>,
): AdapterProviderSummary {
    return {
        ...fixture.provider,
        agentRuntimes: [...fixture.provider.agentRuntimes, sibling.descriptor],
        targetContextSchemas: [...fixture.provider.targetContextSchemas, sibling.support.targetContextSchema],
        assetTargetCapabilities: [...fixture.provider.assetTargetCapabilities, sibling.support.targetCapability],
        materializerCapabilities: [...fixture.provider.materializerCapabilities, sibling.support.materializerCapability],
        renderContractDeclarations: [...fixture.provider.renderContractDeclarations, sibling.support.renderContractDeclaration],
    };
}

function createSiblingRegistry(provider: AdapterProviderSummary) {
    return createRenderRegistry({ providers: [provider], ...nativeProjectGuidanceRegistryComponents([provider]) });
}

describe("native project Guidance registration", () => {
    it("supports distinct materializer identities for sibling runtime entries without changing the legacy default", () => {
        const fixture = makeFixture("claude");
        const sibling = makeSiblingAppSupport(fixture);
        const provider = siblingProvider(fixture, sibling);
        const registry = createSiblingRegistry(provider);

        expect(provider.materializerCapabilities.map((row) => row.materializerCapabilityKey)).toEqual([
            "claudecode.project-guidance-native-v1",
            APP_MATERIALIZER_KEY,
        ]);
        expect(registry.getOwner(fixture.agentRuntimeId)?.adapterId).toBe(fixture.adapterId);
        expect(registry.getOwner(sibling.descriptor.agentRuntimeId)?.adapterId).toBe(fixture.adapterId);
        expect(makeFixture("claude").support.materializerCapability.materializerCapabilityKey).toBe(
            "claudecode.project-guidance-native-v1",
        );
    });

    it("rejects malformed explicit and globally duplicate materializer identities", () => {
        const fixture = makeFixture("claude");
        for (const materializerCapabilityKey of ["", " padded ", "bad\0key"]) {
            expect(() => makeSiblingAppSupport(fixture, materializerCapabilityKey)).toThrow(/canonical non-blank text/);
        }

        const duplicate = makeSiblingAppSupport(fixture, fixture.support.materializerCapability.materializerCapabilityKey);
        expect(() => createSiblingRegistry(siblingProvider(fixture, duplicate))).toThrow(/duplicate materializer capability key/);
    });
});
