/** Independent pre-change B5 goldens preserve every old target and dialect definition. */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
    computeNativeDialectContractFingerprint,
    computePortableEntryDialectContractFingerprint,
} from "../../../../core/src/foundation/fingerprint";
import {
    clearRegistry,
    disableAdapter,
    enableAdapter,
    freezeRegistry,
    getRegisteredRetainedInspectionRegistry,
    registerAdapterProvider,
} from "../../../../core/src/orchestration/adapter-registry";
import { codexProvider } from "../src/codex-provider";
const OLD_NATIVE = {
    "codex-guidance-markdown-v1": "sha256:e55f914c7ff163c5f5cd0a87331c3e4ab980ebc7685187b095b32efea3934129",
    "codex-skill-directory-v1": "sha256:89effc92b216e9b948c1ffc868ff187f176a244bdb0328e035181bd31801dd30",
    "codex-subagent-toml-v1": "sha256:7dd9d706b94da63eba0cc42264835bc988d2cece81610c12dd130be1020d95b6",
    "codex-subagent-toml-v2": "sha256:c3c477b5549c8e200475964894ed59028700151d4732fe56c570ee676fe12cfb",
    "codex-custom-prompt-markdown-v1": "sha256:d7038568ed566c2d8da426c99b96907dd4aa455cdf7e57ab5f504394c602cab9",
    "codex-workflow-as-skill-v1": "sha256:226deb2eafb0b8bb349fb6584c5e2314eba9e529cf85e7f553b45e2f5f1157be",
    "codex-consolidated-memory-v1": "sha256:97c8b346f925a9ddae7a83614519a1b9602db9cfc00c1d3644db840551684272",
};
const OLD_ENTRY = {
    "codex-skill-markdown-v1": "sha256:f46772346a3b75a5f63a794c94a6ee5492067bd7848068fdf33ae63aa04896d1",
    "codex-custom-prompt-markdown-v1": "sha256:594fb0f73b2e1d1fef431e94489ca3a4093cb475891126cc594016a61cdb203f",
};
function ordered(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(ordered);
    if (value !== null && typeof value === "object")
        return Object.fromEntries(
            Object.entries(value)
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([key, v]) => [key, ordered(v)]),
        );
    return value;
}
afterEach(() => clearRegistry());
describe("Codex current Skill conversion and historical target metadata", () => {
    it.each([
        { version: "0.17.0", metadataSha256: "f9c0f1c3ba6ee7c61f68d696eb1779cd418fee99463fb590d11f93e2033b83f7" },
        { version: "0.18.0", metadataSha256: "1b400ba58304ffd892bfc5c39fcb28bc9f32d8791b88d2efbcf29b60198fbd4e" },
    ])("retains exact $version metadata and every pre-change native/entry fingerprint", ({ version, metadataSha256 }) => {
        const binding = codexProvider.retainedInspectionBindings?.find((item) => item.rendererVersion === version);
        if (binding === undefined) throw new Error("missing historical target partition");
        expect(binding.rendererVersion).toBe(version);
        const { schemaVersion: _schema, rendererVersion: _version, inspectRenderedTarget: _inspect, ...metadata } = binding;
        const serial = JSON.parse(JSON.stringify(metadata));
        expect(
            createHash("sha256")
                .update(JSON.stringify(ordered(serial)))
                .digest("hex"),
        ).toBe(metadataSha256);
        for (const [id, fingerprint] of Object.entries(OLD_NATIVE)) {
            const contract = codexProvider.dialectContracts.native.find((item) => item.definition.dialectId === id)!;
            expect(computeNativeDialectContractFingerprint(contract.definition)).toBe(fingerprint);
        }
        for (const [id, fingerprint] of Object.entries(OLD_ENTRY)) {
            const contract = codexProvider.dialectContracts.portableEntries.find((item) => item.definition.dialectId === id)!;
            expect(computePortableEntryDialectContractFingerprint(contract.definition)).toBe(fingerprint);
        }
        expect(binding).not.toHaveProperty("materializeRender");
        expect(binding).not.toHaveProperty("read");
        expect(binding).not.toHaveProperty("targetRender");
        expect(codexProvider.version).toBe("0.19.0");
    });
    it("only resolves the enabled exact old renderer and keeps its compiled registry fingerprint", () => {
        expect(registerAdapterProvider(codexProvider).status).toBe("complete");
        expect(freezeRegistry().status).toBe("complete");
        expect(disableAdapter("CODEX").status).toBe("complete");
        expect(getRegisteredRetainedInspectionRegistry("CODEX", "0.17.0")).toBeNull();
        expect(enableAdapter("CODEX").status).toBe("complete");
        expect(getRegisteredRetainedInspectionRegistry("CODEX", "0.17.0")?.fingerprint).toBe(
            "sha256:2510d085f982a1af9a6c902d235c1240ccf1696b7ee257bf79a1419ecab91b2f",
        );
        expect(getRegisteredRetainedInspectionRegistry("CODEX", "0.18.0")?.fingerprint).toBe(
            "sha256:ccb6ca9e4154d575b239e8b24c90be1014fea402404dc072a32453b2ca314a0d",
        );
        expect(getRegisteredRetainedInspectionRegistry("CODEX", "0.16.0")).toBeNull();
    });
});
