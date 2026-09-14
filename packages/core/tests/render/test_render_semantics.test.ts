/** Authority-focused split from the original oversized render test suite. */

import { describe, expect, it } from "vitest";
import type { RenderDeploymentInput } from "../../src/contracts/render";
import { deriveRequiredRenderSemanticsV1, validateRenderDeploymentInput } from "../../src/render/render-analysis";
import { computeVersionCanonicalContentFingerprint } from "../../src/foundation/fingerprint";
import { binaryPayloadStats } from "../../src/catalog/payload-store";
import {
    makeGuidanceRenderAsset,
    makeRenderDeployment,
    makeRenderRegistry,
    RENDER_PROJECT_ID,
} from "./fixtures/render-contract-fixtures";
import { rehashDeployment } from "./fixtures/render-analysis-test-fixtures";

describe("required render semantics", () => {
    it("derives the six AssetKind semantic sets and Workflow references deterministically", () => {
        const registry = makeRenderRegistry();
        const cases = [
            ["Guidance", ["asset.file_inventory", "guidance.base_context", "guidance.content"]],
            ["Rule", ["asset.file_inventory", "rule.activation", "rule.content"]],
            ["Workflow", ["asset.file_inventory", "workflow.activation", "workflow.content"]],
            ["Skill", ["asset.file_inventory", "skill.discovery_metadata", "skill.body"]],
            [
                "Subagent",
                [
                    "asset.file_inventory",
                    "subagent.delegation_metadata",
                    "subagent.tool_boundary",
                    "subagent.model_hint",
                    "subagent.invoked_context",
                ],
            ],
            ["Memory", ["asset.file_inventory", "memory.support", "memory.content"]],
        ] as const;
        for (const [kind, expected] of cases) {
            const asset = makeGuidanceRenderAsset();
            asset.version.canonical = { kind, typeData: {} } as never;
            const deployment = makeRenderDeployment(registry, undefined, { assets: [asset] });
            const actual = deriveRequiredRenderSemanticsV1(deployment).map((item) => item.semanticKind);
            expect(actual.sort()).toEqual([...expected].sort());
        }

        const workflow = makeGuidanceRenderAsset();
        workflow.version.canonical = { kind: "Workflow", typeData: {} } as never;
        workflow.version.files[0]!.file.references = [
            {
                referenceId: "ref",
                required: false,
                resolution: "unresolved",
                targetLogicalPath: "other.md",
            },
        ];
        const deployment = makeRenderDeployment(registry, undefined, { assets: [workflow] });
        expect(deriveRequiredRenderSemanticsV1(deployment).map((item) => item.semanticKind)).toContain("workflow.reference");

        for (const [kind, semanticKind] of [
            ["Skill", "skill.resource"],
            ["Subagent", "subagent.resource"],
        ] as const) {
            const asset = makeGuidanceRenderAsset();
            asset.version.canonical = { kind, typeData: {} } as never;
            asset.version.files[0]!.file.role = "resource";
            const resourceDeployment = makeRenderDeployment(registry, undefined, {
                assets: [asset],
            });
            expect(deriveRequiredRenderSemanticsV1(resourceDeployment).map((item) => item.semanticKind)).toContain(semanticKind);
        }
    });

    it("turns a missing required entry into a Core-owned blocked semantic", () => {
        const registry = makeRenderRegistry();
        const expected = [
            ["Guidance", "guidance.content"],
            ["Rule", "rule.content"],
            ["Workflow", "workflow.content"],
            ["Skill", "skill.body"],
            ["Subagent", "subagent.invoked_context"],
            ["Memory", "memory.content"],
        ] as const;
        for (const [kind, semanticKind] of expected) {
            const asset = makeGuidanceRenderAsset();
            asset.allowIncomplete = true;
            asset.version.status = "incomplete";
            asset.version.canonical = { kind, typeData: {} } as never;
            asset.version.files = [];
            asset.sectionHandles = {};
            const deployment = makeRenderDeployment(registry, undefined, { assets: [asset] });
            const missing = deriveRequiredRenderSemanticsV1(deployment).find(
                (item) => item.subject.subjectKind === "missing_required_file_role",
            );
            expect(missing).toEqual(expect.objectContaining({ semanticKind }));
        }
    });
});

describe("render deployment input validation", () => {
    it("accepts the canonical deployment and rejects stale identity/root/registry/cardinality facts", () => {
        const registry = makeRenderRegistry();
        const valid = makeRenderDeployment(registry);
        expect(() => validateRenderDeploymentInput(valid, registry)).not.toThrow();

        const cases: Array<[string, (value: RenderDeploymentInput) => void]> = [
            [
                "render.input_identity_invalid",
                (value) => {
                    value.schemaVersion = 2 as never;
                },
            ],
            [
                "render.target_root_invalid",
                (value) => {
                    value.targetRootPath = "relative";
                },
            ],
            [
                "render.environment_identity_invalid",
                (value) => {
                    value.platformInstanceId = " ";
                },
            ],
            [
                "render.consumer_missing",
                (value) => {
                    value.consumerAgentRuntimeIds = [];
                },
            ],
            [
                "render.noncanonical_set",
                (value) => {
                    value.consumerAgentRuntimeIds.push(value.consumerAgentRuntimeIds[0]!);
                },
            ],
            [
                "render.project_invalid",
                (value) => {
                    value.projectId = "bad";
                },
            ],
            [
                "render.registry_stale",
                (value) => {
                    value.renderRegistryFingerprint = `sha256:${"9".repeat(64)}`;
                },
            ],
            [
                "render.context_duplicate",
                (value) => {
                    value.targetContexts.push(structuredClone(value.targetContexts[0]!));
                },
            ],
            [
                "render.context_cardinality",
                (value) => {
                    value.targetContexts = [];
                },
            ],
            [
                "render.input_fingerprint_mismatch",
                (value) => {
                    value.renderInputFingerprint = `sha256:${"8".repeat(64)}`;
                },
            ],
        ];
        for (const [code, mutate] of cases) {
            const value = structuredClone(valid);
            mutate(value);
            expect(() => validateRenderDeploymentInput(value, registry)).toThrow();
            try {
                validateRenderDeploymentInput(value, registry);
            } catch (error) {
                expect((error as { code?: string }).code).toBe(code);
            }
        }
    });

    it("rejects duplicate Assets, invalid scope, incomplete denial, payload lies, and section drift", () => {
        const registry = makeRenderRegistry();
        const valid = makeRenderDeployment(registry);
        const cases: Array<[string, (value: RenderDeploymentInput) => void]> = [
            [
                "render.asset_duplicate",
                (value) => {
                    value.assets.push(structuredClone(value.assets[0]!));
                },
            ],
            [
                "render.asset_scope_invalid",
                (value) => {
                    value.assets[0]!.scope = "project";
                },
            ],
            [
                "render.version_ref_invalid",
                (value) => {
                    value.assets[0]!.version.ref.versionId = "bad";
                },
            ],
            [
                "render.version_fingerprint_invalid",
                (value) => {
                    value.assets[0]!.version.versionFingerprint = "bad" as never;
                },
            ],
            [
                "render.incomplete_not_allowed",
                (value) => {
                    value.assets[0]!.version.status = "incomplete";
                },
            ],
            [
                "render.asset_incomplete_policy_invalid",
                (value) => {
                    value.assets[0]!.allowIncomplete = "yes" as never;
                },
            ],
            [
                "render.version_status_invalid",
                (value) => {
                    value.assets[0]!.version.status = "unknown" as never;
                },
            ],
            [
                "render.asset_kind_invalid",
                (value) => {
                    value.assets[0]!.version.canonical = {
                        kind: "Foreign",
                        typeData: {},
                    } as never;
                },
            ],
            [
                "render.asset_type_data_invalid",
                (value) => {
                    value.assets[0]!.version.canonical = {
                        kind: "Guidance",
                        typeData: { schemaVersion: 999 },
                    } as never;
                },
            ],
            [
                "render.file_id_duplicate",
                (value) => {
                    value.assets[0]!.version.files.push(structuredClone(value.assets[0]!.version.files[0]!));
                },
            ],
            [
                "render.file_payload_mismatch",
                (value) => {
                    if (value.assets[0]!.version.files[0]!.contentKind === "text")
                        value.assets[0]!.version.files[0]!.text = "changed";
                },
            ],
            [
                "render.file_identity_invalid",
                (value) => {
                    value.assets[0]!.version.files[0]!.file.logicalPath = "../bad";
                },
            ],
            [
                "render.file_content_kind_mismatch",
                (value) => {
                    value.assets[0]!.version.files[0]!.file.contentKind = "binary";
                },
            ],
            [
                "render.complete_version_invalid",
                (value) => {
                    value.assets[0]!.version.files = [];
                    value.assets[0]!.sectionHandles = {};
                },
            ],
            [
                "render.section_handle_closure",
                (value) => {
                    value.assets[0]!.sectionHandles = {};
                },
            ],
            [
                "render.section_handle_closure",
                (value) => {
                    const key = Object.keys(value.assets[0]!.sectionHandles)[0]!;
                    value.assets[0]!.sectionHandles[key] = " ";
                },
            ],
            [
                "render.canonical_fingerprint_mismatch",
                (value) => {
                    value.assets[0]!.version.versionCanonicalContentFingerprint = `sha256:${"7".repeat(64)}`;
                },
            ],
        ];
        for (const [code, mutate] of cases) {
            const value = structuredClone(valid);
            mutate(value);
            rehashDeployment(value);
            try {
                validateRenderDeploymentInput(value, registry);
                throw new Error("expected validation failure");
            } catch (error) {
                expect((error as { code?: string }).code).toBe(code);
            }
        }

        const binary = structuredClone(valid);
        const bytes = Uint8Array.of(1, 2, 3);
        const stats = binaryPayloadStats(bytes);
        const original = binary.assets[0]!.version.files[0]!;
        binary.assets[0]!.allowIncomplete = true;
        binary.assets[0]!.version.status = "incomplete";
        binary.assets[0]!.version.files = [
            {
                contentKind: "binary",
                bytes,
                file: {
                    ...original.file,
                    contentKind: "binary",
                    mediaType: "application/octet-stream",
                    contentHash: stats.contentHash,
                    byteSize: stats.byteSize,
                },
            },
        ];
        binary.assets[0]!.version.versionCanonicalContentFingerprint = computeVersionCanonicalContentFingerprint(
            binary.assets[0]!.version.canonical,
            binary.assets[0]!.version.files.map((item) => item.file),
        );
        rehashDeployment(binary);
        expect(() => validateRenderDeploymentInput(binary, registry)).not.toThrow();
    });

    it("accepts an exact project scope and rejects project mismatch or noncanonical scope paths", () => {
        const registry = makeRenderRegistry();
        const projectAsset = makeGuidanceRenderAsset({
            scope: "project",
            projectId: RENDER_PROJECT_ID,
            scopePath: "nested",
        });
        const valid = makeRenderDeployment(registry, undefined, {
            projectId: RENDER_PROJECT_ID,
            assets: [projectAsset],
        });
        expect(() => validateRenderDeploymentInput(valid, registry)).not.toThrow();

        const mismatch = structuredClone(valid);
        mismatch.assets[0]!.projectId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
        rehashDeployment(mismatch);
        expect(() => validateRenderDeploymentInput(mismatch, registry)).toThrow(/scope\/project\/path/);

        const noncanonical = structuredClone(valid);
        noncanonical.assets[0]!.scopePath = "nested/../escape";
        rehashDeployment(noncanonical);
        expect(() => validateRenderDeploymentInput(noncanonical, registry)).toThrow(/scope\/project\/path/);
    });

    it("enforces that a complete Memory catalog has zero entry files", () => {
        const registry = makeRenderRegistry();
        const catalog = makeGuidanceRenderAsset();
        catalog.version.canonical = {
            kind: "Memory",
            typeData: { schemaVersion: 2, entityRole: "catalog", members: [] },
        };
        catalog.version.versionCanonicalContentFingerprint = computeVersionCanonicalContentFingerprint(
            catalog.version.canonical,
            catalog.version.files.map((item) => item.file),
        );
        const invalid = makeRenderDeployment(registry, undefined, { assets: [catalog] });
        expect(() => validateRenderDeploymentInput(invalid, registry)).toThrow(/file contract/);

        catalog.version.files = [];
        catalog.sectionHandles = {};
        catalog.version.versionCanonicalContentFingerprint = computeVersionCanonicalContentFingerprint(
            catalog.version.canonical,
            [],
        );
        const valid = makeRenderDeployment(registry, undefined, { assets: [catalog] });
        expect(() => validateRenderDeploymentInput(valid, registry)).not.toThrow();
    });
});
