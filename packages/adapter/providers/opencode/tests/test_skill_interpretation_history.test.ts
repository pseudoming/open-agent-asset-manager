import * as crypto from "node:crypto";
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
    getRegisteredVersionDialectRegistry,
    registerAdapterProvider,
} from "../../../../core/src/orchestration/adapter-registry";
import { opencodeProvider } from "../src/opencode-provider";
import { OPENCODE_NATIVE_DIALECTS } from "../src/opencode-source-read-model";
import { validateOpencodeNativeDialect } from "../src/opencode-source-read-native";
import { readBoth, validationInput } from "./opencode-skill-interpretation-test-fixtures";
import { fm, readProject } from "./opencode-source-test-fixtures";

const LEGACY_METADATA_SHA = "54ae33851b77ca86addc4e7ae9ef2b47c215660c94516e2fc07642136dc842dd";
const OLD_NATIVE = {
    "opencode-guidance-markdown-v1": "sha256:ec8ccdf6838f27c8fdc3451407b7b9c7da3f2d8bd707f13ae8e098779b885aea",
    "opencode-instructions-config-graph-v1": "sha256:ace5d1e86c710d165265282de6f8e4b3937847f43b2d6151078057ba0ed15db5",
    "opencode-command-markdown-v1": "sha256:08bcac1ccd5b48870f355168aeca4fb1a11a33660c9d136d746fb7bae25df515",
    "opencode-skill-directory-v1": "sha256:9a175ade6a9f3a62db878053dc105c4d10e3b99aa735e5ae14447940eab3e409",
    "opencode-subagent-markdown-v1": "sha256:a757f9dfa32999d22225bffd437c659b5a2ab48d4f217de2de56f1b41c5e729a",
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
describe("OpenCode Skill interpretation generations and retained metadata", () => {
    it("preserves exact 0.9.0 target metadata and every historical native/entry contract fingerprint", () => {
        const binding = opencodeProvider.retainedInspectionBindings?.[0];
        if (binding === undefined) throw new Error("missing retained binding");
        expect(binding.rendererVersion).toBe("0.9.0");
        const {
            schemaVersion: _schema,
            rendererVersion: _version,
            inspectRenderedTarget: _inspect,
            canonicalMaterializationValidators,
            ...metadata
        } = binding;
        const snapshot = {
            ...metadata,
            canonicalMaterializationValidators: canonicalMaterializationValidators?.map(
                ({ validateEntry: _validate, ...identity }) => identity,
            ),
        };
        expect(
            crypto
                .createHash("sha256")
                .update(JSON.stringify(ordered(snapshot)))
                .digest("hex"),
        ).toBe(LEGACY_METADATA_SHA);
        for (const [id, fingerprint] of Object.entries(OLD_NATIVE)) {
            const contract = opencodeProvider.dialectContracts.native.find((x) => x.definition.dialectId === id)!;
            expect(computeNativeDialectContractFingerprint(contract.definition)).toBe(fingerprint);
        }
        for (const [id, fingerprint] of [
            ["opencode-command-markdown-v1", "sha256:affec92f9aa52e8bdd58ad8ac479b5ccb7563543dfd847ca4e363c7ef62e907e"],
            ["opencode-skill-markdown-v1", "sha256:9f7582d83772ce457831aebf6994c45a32555d53ac8bac9d5e0d4e6dfa763312"],
        ]) {
            const contract = opencodeProvider.dialectContracts.portableEntries.find((x) => x.definition.dialectId === id)!;
            expect(computePortableEntryDialectContractFingerprint(contract.definition)).toBe(fingerprint);
        }
        expect(binding).not.toHaveProperty("materializeRender");
        expect(binding).not.toHaveProperty("read");
        expect(opencodeProvider.version).toBe("0.11.0");
    });
    it("retains B6 0.10.0 metadata and dialect fingerprints frozen before source assessment changed", () => {
        const binding = opencodeProvider.retainedInspectionBindings?.find((item) => item.rendererVersion === "0.10.0");
        if (binding === undefined) throw new Error("missing B6 historical binding");
        const { schemaVersion: _schema, rendererVersion: _version, inspectRenderedTarget: _inspect, ...metadata } = binding;
        expect(
            crypto
                .createHash("sha256")
                .update(JSON.stringify(ordered(JSON.parse(JSON.stringify(metadata)))))
                .digest("hex"),
        ).toBe("5af27b3112378b7e0fe47b92cc1f617cbf5d44d988d00e8449c6ecb19666d472");
        const native = {
            "opencode-guidance-markdown-v1": "sha256:ec8ccdf6838f27c8fdc3451407b7b9c7da3f2d8bd707f13ae8e098779b885aea",
            "opencode-instructions-config-graph-v1": "sha256:ace5d1e86c710d165265282de6f8e4b3937847f43b2d6151078057ba0ed15db5",
            "opencode-command-markdown-v1": "sha256:08bcac1ccd5b48870f355168aeca4fb1a11a33660c9d136d746fb7bae25df515",
            "opencode-skill-directory-v1": "sha256:9a175ade6a9f3a62db878053dc105c4d10e3b99aa735e5ae14447940eab3e409",
            "opencode-skill-directory-v2": "sha256:870a6c6352cb7c3dd2fa2afcce851473ec2aa32b77a66c0482cd08ae98993d6e",
            "opencode-subagent-markdown-v1": "sha256:a757f9dfa32999d22225bffd437c659b5a2ab48d4f217de2de56f1b41c5e729a",
        };
        const entries = {
            "opencode-command-markdown-v1": "sha256:affec92f9aa52e8bdd58ad8ac479b5ccb7563543dfd847ca4e363c7ef62e907e",
            "opencode-skill-markdown-v1": "sha256:9f7582d83772ce457831aebf6994c45a32555d53ac8bac9d5e0d4e6dfa763312",
            "opencode-skill-markdown-v2": "sha256:46cc3aaf4b1d85d8174bf33ef947402d58f472a724c43212bee9c40584753066",
        };
        for (const [id, fingerprint] of Object.entries(native)) {
            const contract = opencodeProvider.dialectContracts.native.find((item) => item.definition.dialectId === id)!;
            expect(computeNativeDialectContractFingerprint(contract.definition)).toBe(fingerprint);
        }
        for (const [id, fingerprint] of Object.entries(entries)) {
            const contract = opencodeProvider.dialectContracts.portableEntries.find((item) => item.definition.dialectId === id)!;
            expect(computePortableEntryDialectContractFingerprint(contract.definition)).toBe(fingerprint);
        }
        expect(binding).not.toHaveProperty("materializeRender");
        expect(binding).not.toHaveProperty("read");
        expect(registerAdapterProvider(opencodeProvider).status).toBe("complete");
        expect(freezeRegistry().status).toBe("complete");
        expect(enableAdapter("OPENCODE").status).toBe("complete");
        expect(getRegisteredRetainedInspectionRegistry("OPENCODE", "0.10.0")?.fingerprint).toBe(
            "sha256:5dfce0270ad947ad13ea9df202eca7e9a299aaf1f7d05cb96a68c00d83237b1b",
        );
    });
    it.each([
        { slash: "", direct: false },
        { slash: "slash: false", direct: false },
        { slash: "slash: true", direct: true },
    ])("keeps CLI and App source interpretations separate for $slash", async ({ slash, direct }) => {
        const { current, historical } = await readBoth(slash);
        expect(current.nativeRepresentation.dialectId).toBe(OPENCODE_NATIVE_DIALECTS.skillCli);
        expect(current.typeData.entryDialectId).toBe("opencode-skill-markdown-v2");
        expect(current.typeData.invocation.user).toEqual({ mode: "direct", commandName: "review" });
        expect(historical.nativeRepresentation.dialectId).toBe(OPENCODE_NATIVE_DIALECTS.skill);
        expect(historical.typeData.entryDialectId).toBe("opencode-skill-markdown-v1");
        expect(historical.typeData.invocation.user).toEqual(
            direct ? { mode: "direct", commandName: "review" } : { mode: "not_directly_invocable" },
        );
        const modern = validationInput(current),
            old = validationInput(historical);
        expect(validateOpencodeNativeDialect(modern)).toBe(true);
        expect(validateOpencodeNativeDialect(old)).toBe(true);
        const forged = structuredClone(modern);
        forged.representation.dialectId = OPENCODE_NATIVE_DIALECTS.skill;
        expect(validateOpencodeNativeDialect(forged)).toBe(false);
        const relabeled = structuredClone(old);
        relabeled.representation.dialectId = OPENCODE_NATIVE_DIALECTS.skillCli;
        expect(validateOpencodeNativeDialect(relabeled)).toBe(false);
        expect(modern.nativeFiles).toEqual(old.nativeFiles);
        expect(modern.canonicalFiles.find((file) => file.file.logicalPath === "run.py")?.file.executable).toBe(true);
    });
    it("retains unowned frontmatter bytes and reports the existing incomplete source boundary", async () => {
        const text = fm("name: review\ndescription: Review\nfuture-field: retain", "Review changes.");
        const result = await readProject(["Skill"], { ".opencode/skills/review/SKILL.md": text });
        const candidate = result.candidates[0]!;
        expect(candidate.status).toBe("incomplete");
        expect(candidate.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    code: "opencode.declaration_unknown_behavior",
                    severity: "error",
                }),
            ]),
        );
        if (candidate.nativeRepresentation.representationSource === "canonical_files") throw new Error("native bytes missing");
        expect(new TextDecoder().decode(candidate.nativeRepresentation.files[0]?.bytes)).toBe(text);
    });

    it("keeps old native validation while disabled and only enables the exact historical inspection partition", async () => {
        const { historical } = await readBoth(""),
            old = validationInput(historical);
        clearRegistry();
        expect(registerAdapterProvider(opencodeProvider).status).toBe("complete");
        expect(freezeRegistry().status).toBe("complete");
        expect(disableAdapter("OPENCODE").status).toBe("complete");
        expect(
            getRegisteredVersionDialectRegistry().getNative("Skill", OPENCODE_NATIVE_DIALECTS.skill)?.validateSameContent(old),
        ).toBe(true);
        expect(getRegisteredRetainedInspectionRegistry("OPENCODE", "0.9.0")).toBeNull();
        expect(enableAdapter("OPENCODE").status).toBe("complete");
        expect(getRegisteredRetainedInspectionRegistry("OPENCODE", "0.9.0")?.fingerprint).toBe(
            "sha256:0a165bed3b88435cb9c4ee70d15d1e84d801d17e231054d9843cf005f2b3ef7a",
        );
        expect(getRegisteredRetainedInspectionRegistry("OPENCODE", "0.8.0")).toBeNull();
    });
});
