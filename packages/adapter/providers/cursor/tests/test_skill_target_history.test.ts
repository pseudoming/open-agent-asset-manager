/** Independent pre-change B6 goldens preserve every old target and dialect definition. */
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
import { cursorProvider } from "../src/cursor-provider";
const OLD_NATIVE = {
    "cursor-guidance-markdown-v1": "sha256:c0e5662eb9af88078f39da6d519519bb564583f11db4f94f81111ce7042acf6a",
    "cursor-skill-directory-v1": "sha256:76c88fd3c3810884f51678fe4922f0593acaeee0c30fda49a2506ce4dcb0639c",
    "cursor-rule-mdc-v1": "sha256:4bc9085d7b5168cf8a141ed157812d754120d5f77a911713f467962a0487b7fd",
    "cursor-agent-command-markdown-v1": "sha256:ca3178aad9aef9f1593cf8a7068f6e2c38c162da2830f71fde599117450f6ed6",
    "cursor-subagent-markdown-v1": "sha256:c8cb833e255633347f4a0c1cb8d94a26eea227927bf31cc51e211c8dffdf246b",
    "cursor-app-command-document-v1": "sha256:ac37dccbc41ed6bc62a89d3964ce1f9cc48987de67a09df43e3e7e8605226040",
    "cursor-app-remote-memory-readonly-snapshot-v1": "sha256:8d59b5f287480f418f7262edaf8350ad75ef669d437825ea6ae8b6ad78381d2d",
};
const OLD_ENTRY = {
    "cursor-skill-directory-v1": "sha256:557b642b53ef1772cd224ce5b986e6992eaffbe3a7107bf2708acd7ca1868958",
    "cursor-agent-command-markdown-v1": "sha256:ea1b31d1db69b818cb5d50eb24d98b62f3dcda25e7e093b293b3518b548ec9fa",
    "cursor-app-command-document-v1": "sha256:73071eb574296f616ee171cca244043f634d618f6ab87b081515dcdf3322bc60",
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
describe("Cursor current Skill conversion and historical target metadata", () => {
    it("retains exact 0.1.0 metadata and every native/entry fingerprint captured before the change", () => {
        const binding = cursorProvider.retainedInspectionBindings?.[0];
        if (binding === undefined) throw new Error("missing historical target partition");
        expect(binding.rendererVersion).toBe("0.1.0");
        const { schemaVersion: _schema, rendererVersion: _version, inspectRenderedTarget: _inspect, ...metadata } = binding;
        const serial = JSON.parse(JSON.stringify(metadata));
        expect(
            createHash("sha256")
                .update(JSON.stringify(ordered(serial)))
                .digest("hex"),
        ).toBe("d90cae1331bec291aecf66b06d91af4e6cce2b3062f035389b69a0eb19a13ade");
        for (const [id, fingerprint] of Object.entries(OLD_NATIVE)) {
            const contract = cursorProvider.dialectContracts.native.find((item) => item.definition.dialectId === id)!;
            expect(computeNativeDialectContractFingerprint(contract.definition)).toBe(fingerprint);
        }
        for (const [id, fingerprint] of Object.entries(OLD_ENTRY)) {
            const contract = cursorProvider.dialectContracts.portableEntries.find((item) => item.definition.dialectId === id)!;
            expect(computePortableEntryDialectContractFingerprint(contract.definition)).toBe(fingerprint);
        }
        expect(binding).not.toHaveProperty("materializeRender");
        expect(binding).not.toHaveProperty("read");
        expect(binding).not.toHaveProperty("targetRender");
        expect(cursorProvider.version).toBe("0.2.0");
    });
    it("only resolves the enabled exact old renderer and keeps its compiled registry fingerprint", () => {
        expect(registerAdapterProvider(cursorProvider).status).toBe("complete");
        expect(freezeRegistry().status).toBe("complete");
        expect(disableAdapter("CURSOR").status).toBe("complete");
        expect(getRegisteredRetainedInspectionRegistry("CURSOR", "0.1.0")).toBeNull();
        expect(enableAdapter("CURSOR").status).toBe("complete");
        expect(getRegisteredRetainedInspectionRegistry("CURSOR", "0.1.0")?.fingerprint).toBe(
            "sha256:5336c766240eaf929418c4997a27ccd08886bdcf9a7cc185e3de4d4c0192b289",
        );
        expect(getRegisteredRetainedInspectionRegistry("CURSOR", "0.0.0")).toBeNull();
    });
});
