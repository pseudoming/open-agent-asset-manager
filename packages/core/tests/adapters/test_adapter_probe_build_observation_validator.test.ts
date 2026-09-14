import { describe, expect, it } from "vitest";
import { validateAdapterProbeResult } from "../../src/adapters/adapter-contract-validator";
import type { AdapterId, PlatformContext } from "../../src/types";
import { makeContractProvider, partialUnknownProbe } from "./fixtures/adapter-contract-fixtures";

const A = "VALIDATOR_BUILD" as AdapterId;
const LINUX_CONTEXT: PlatformContext = { platform: "linux", platformInstanceId: "test", accessRootPath: "/" };

describe("adapter current-build observation validator", () => {
    it("accepts exact observations and rejects malformed or non-build evidence", () => {
        const provider = makeContractProvider(A);
        const runtimeId = provider.agentRuntimes[0]!.agentRuntimeId;
        const valid = partialUnknownProbe(runtimeId);
        const runtime = valid.observation.observedAgentRuntimes[0]!;
        runtime.installationStatus = "available";
        runtime.installationEvidence = [
            {
                kind: "executable",
                path: "/runtime/bin/consumer",
                evidenceLevel: "agent_runtime_verified",
                diagnostics: [],
                currentBuildObservation: {
                    buildIdentity: `sha256:${"a".repeat(64)}`,
                    byteSize: 128,
                    executable: true,
                    identity: { deviceId: "device", fileId: "file", entryKind: "file" },
                },
            },
        ];
        expect(validateAdapterProbeResult(provider, valid, LINUX_CONTEXT)).toEqual([]);

        for (const currentBuildObservation of [
            null,
            { ...runtime.installationEvidence[0]!.currentBuildObservation, buildIdentity: "sha256:short" },
            { ...runtime.installationEvidence[0]!.currentBuildObservation, byteSize: -1 },
            {
                ...runtime.installationEvidence[0]!.currentBuildObservation,
                identity: { deviceId: "", fileId: "file", entryKind: "file" },
            },
        ]) {
            const malformed = structuredClone(valid);
            malformed.observation.observedAgentRuntimes[0]!.installationEvidence[0]!.currentBuildObservation =
                currentBuildObservation as never;
            expect(validateAdapterProbeResult(provider, malformed, LINUX_CONTEXT).map((diagnostic) => diagnostic.code)).toContain(
                "probe.installation_build_observation_invalid",
            );
        }
        const wrongKind = structuredClone(valid);
        wrongKind.observation.observedAgentRuntimes[0]!.installationEvidence[0]!.kind = "install_root";
        expect(validateAdapterProbeResult(provider, wrongKind, LINUX_CONTEXT).map((diagnostic) => diagnostic.code)).toContain(
            "probe.installation_build_observation_invalid",
        );
    });
});
