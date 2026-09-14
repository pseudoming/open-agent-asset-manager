import { describe, expect, it } from "vitest";
import { nonDirectoryRootReadAccess, readAccessFailed } from "../../../test-support";
import { codexProvider } from "../src/codex-provider";
import { resolveCodexSourceContext, scanCodexReadObligation } from "../src/codex-source-read";
import {
    configRoot,
    externalRoot,
    guidanceCapability,
    guidanceCapabilityForRuntime,
    projectRoot,
    rawReadInput,
    readGuidance,
    userSelectedReadInput,
} from "./codex-source-test-fixtures";

describe("Codex Guidance source read", () => {
    it("binds the exact App capability to the same physical project Guidance parser", async () => {
        const root = projectRoot();
        const capability = guidanceCapabilityForRuntime(root, "CODEX_APP");
        const result = await codexProvider.read(rawReadInput(root, [capability], { "AGENTS.md": "App guidance\n" }));

        expect(capability).toMatchObject({ agentRuntimeId: "CODEX_APP", entrySupportStatus: "supported" });
        expect(result.candidates).toEqual([
            expect.objectContaining({
                kind: "Guidance",
                scope: "project",
                files: [expect.objectContaining({ text: "App guidance\n" })],
            }),
        ]);
        expect(result.sourceParseReports[0]?.sourceReadObligationIds).toEqual(["obligation-Guidance-0"]);
    });

    it("applies global override precedence and falls through an empty override", async () => {
        const preferred = await readGuidance(configRoot(), {
            "AGENTS.override.md": "Private override\n",
            "AGENTS.md": "Global base\n",
            "nested/AGENTS.md": "Not global\n",
        });
        expect(preferred.candidates).toEqual([
            expect.objectContaining({
                kind: "Guidance",
                displayName: "AGENTS.override.md",
                promotionSafety: "requires_user_confirmation",
                scope: "global",
                scopePath: "",
                files: [expect.objectContaining({ logicalPath: "GUIDANCE.md", text: "Private override\n" })],
                nativeRepresentation: expect.objectContaining({
                    representationSource: "separate_files",
                    dialectId: "codex-guidance-markdown-v1",
                    files: [expect.objectContaining({ relativePath: "AGENTS.override.md" })],
                }),
            }),
        ]);
        expect(preferred.sourceParseReports[0]?.readEntryDispositions).toContainEqual(
            expect.objectContaining({ disposition: "ignored", reasonCode: "shadowed_guidance_source" }),
        );

        const emptyOverride = await readGuidance(configRoot(), {
            "AGENTS.override.md": " \n",
            "AGENTS.md": "Global base\n",
        });
        expect(emptyOverride.candidates).toEqual([
            expect.objectContaining({ displayName: "AGENTS.md", promotionSafety: "default_promotable" }),
        ]);
    });

    it("reads only standard project Guidance names when fallback configuration is not bound", async () => {
        const result = await readGuidance(projectRoot(), {
            "AGENTS.md": "Root guidance\n",
            "src/AGENTS.override.md": "Source override\n",
            "src/AGENTS.md": "Shadowed source base\n",
            "src/deep/AGENTS.override.md": "\n",
            "src/deep/TEAM_GUIDE.md": "Configured fallback\n",
            "docs/.agents.md": "Docs fallback\n",
            "docs/unrelated.md": "Ignored\n",
        });
        expect(
            result.candidates.map((candidate) => [candidate.scopePath, candidate.displayName, candidate.files[0]?.text]),
        ).toEqual([
            ["", "AGENTS.md", "Root guidance\n"],
            ["src", "AGENTS.override.md", "Source override\n"],
        ]);
        expect(result.candidates.every((candidate) => candidate.scope === "project")).toBe(true);
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({ code: "codex.guidance_fallback_configuration_unknown", severity: "warning" }),
        );
        expect(result.sourceParseReports[0]?.readEntryDispositions).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ disposition: "ignored", reasonCode: "shadowed_guidance_source" }),
                expect.objectContaining({ disposition: "ignored", reasonCode: "empty_guidance" }),
                expect.objectContaining({ disposition: "ignored", reasonCode: "outside_source_pattern" }),
            ]),
        );
    });

    it("blocks lower-priority fallback for non-UTF-8, executable, or unreadable preferred files", async () => {
        const invalidCases = [
            { preferred: new Uint8Array([0xff]), code: "codex.guidance_not_utf8" },
            { preferred: { text: "Executable\n", executable: true } as const, code: "codex.guidance_executable_rejected" },
        ];
        for (const invalid of invalidCases) {
            const result = await readGuidance(configRoot(), {
                "AGENTS.override.md": invalid.preferred,
                "AGENTS.md": "Must not win\n",
            });
            expect(result.candidates).toEqual([]);
            expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: invalid.code, severity: "error" }));
        }

        const root = configRoot();
        const input = rawReadInput(root, [guidanceCapability(root)], {
            "AGENTS.override.md": "Unreadable\n",
            "AGENTS.md": "Must not win\n",
        });
        const base = input.readAccess;
        const paths = new Map<string, string>();
        input.readAccess = {
            ...base,
            async resolveRootEntry(obligationId, sourceRootId) {
                const result = await base.resolveRootEntry(obligationId, sourceRootId);
                if (result.state === "succeeded") paths.set(result.value.readEntryHandleId, result.value.relativePath);
                return result;
            },
            async listDirectory(handleId) {
                const result = await base.listDirectory(handleId);
                if (result.state === "succeeded") {
                    for (const child of result.value.children) paths.set(child.readEntryHandleId, child.relativePath);
                }
                return result;
            },
            async readFile(handleId) {
                return paths.get(handleId) === "AGENTS.override.md"
                    ? readAccessFailed("fixture-resource-limit", "resource_limit_exceeded")
                    : base.readFile(handleId);
            },
        };
        const unreadable = await codexProvider.read(input);
        expect(unreadable.candidates).toEqual([]);
        expect(unreadable.diagnostics).toContainEqual(
            expect.objectContaining({ code: "codex.guidance_preferred_source_unreadable" }),
        );
    });

    it("reports unavailable fallback configuration for an explicit project root instead of guessing", async () => {
        const root = externalRoot();
        const result = await codexProvider.read(
            userSelectedReadInput(root, guidanceCapability(root), "project", "/fixture/external", {
                "AGENTS.md": "Known winner\n",
                "TEAM_GUIDE.md": "Unknown configured fallback\n",
            }),
        );
        expect(result.candidates).toEqual([expect.objectContaining({ displayName: "AGENTS.md" })]);
        expect(result.diagnostics).toContainEqual(
            expect.objectContaining({ code: "codex.guidance_fallback_configuration_unknown", severity: "warning" }),
        );

        const global = await codexProvider.read(
            userSelectedReadInput(root, guidanceCapability(root), "global", "", { "AGENTS.md": "Global explicit root\n" }),
        );
        expect(global.candidates).toEqual([expect.objectContaining({ scope: "global", scopePath: "" })]);
        expect(global.diagnostics).not.toContainEqual(
            expect.objectContaining({ code: "codex.guidance_fallback_configuration_unknown" }),
        );
    });

    it("fails closed for a wrong root kind or a non-callable source mechanism", async () => {
        const root = configRoot();
        const capability = guidanceCapability(root);
        const wrongRoot = rawReadInput(root, [capability], { "AGENTS.md": "Body\n" });
        wrongRoot.readAccess = nonDirectoryRootReadAccess(root);
        const result = await codexProvider.read(wrongRoot);
        expect(result.candidates).toEqual([]);
        expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "codex.source_root_not_directory" }));

        const context = resolveCodexSourceContext(rawReadInput(root, [capability], {}), root, capability);
        if (context === null) throw new Error("missing Codex Guidance context");
        const scan = await scanCodexReadObligation(
            rawReadInput(root, [capability], {}),
            {
                sourceReadObligationId: "fixture-non-callable",
                sourceRootId: root.sourceRootId,
                sourceCapabilityFingerprint: capability.sourceCapabilityFingerprint,
            },
            { ...capability, sourcePathMechanism: "unknown" },
            context,
        );
        expect(scan.diagnostics).toEqual([expect.objectContaining({ code: "codex.source_path_mechanism_not_callable" })]);
    });
});
