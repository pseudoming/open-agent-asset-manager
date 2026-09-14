export const PACKAGED_ZCODE_SOURCE_ROWS = Object.freeze([
    Object.freeze({
        rowId: "source-project-row",
        rootRole: "project_actual",
        sourceDomain: "project_root",
        accessStatus: "available",
        locatorIdentities: Object.freeze([Object.freeze({ locatorKind: "user_provided_path", locatorKey: "user_selection" })]),
    }),
    Object.freeze({
        rowId: "source-skill-row",
        rootRole: "source",
        sourceDomain: "project_root",
        accessStatus: "available",
        locatorIdentities: Object.freeze([
            Object.freeze({ locatorKind: "runtime_known_rule", locatorKey: "zcode_project_skill_root" }),
            Object.freeze({ locatorKind: "user_provided_path", locatorKey: "user_selection" }),
        ]),
    }),
    Object.freeze({
        rowId: "source-memory-row",
        rootRole: "source",
        sourceDomain: "project_keyed",
        accessStatus: "available",
        locatorIdentities: Object.freeze([
            Object.freeze({ locatorKind: "runtime_known_rule", locatorKey: "zcode_default_storage_root" }),
            Object.freeze({ locatorKind: "user_provided_path", locatorKey: "user_selection" }),
        ]),
    }),
]);

export function packagedZcodeSkillPreviewFixture() {
    return Object.freeze({
        schemaVersion: 2,
        previewToken: "render-preview-token",
        actionState: "requires_unmanaged_replacement",
        files: Object.freeze([
            Object.freeze({ baselineState: "unmanaged", changeKind: "replace_unmanaged" }),
            Object.freeze({ baselineState: "unmanaged", changeKind: "create" }),
            Object.freeze({ baselineState: "unmanaged", changeKind: "remove_unmanaged" }),
            Object.freeze({ baselineState: "unmanaged", changeKind: "remove_unmanaged" }),
        ]),
        directories: Object.freeze(
            ["", "empty", "resources", "old", "scratch"].map((relativePath) =>
                Object.freeze({
                    managedBoundaryRelativePath: ".zcode/skills/oaam-phase56-skill",
                    relativePath,
                }),
            ),
        ),
    });
}

export function packagedZcodeBrowserPort(): BrowserProtocolPort {
    return {
        postMessage: vi.fn(),
        start: vi.fn(),
        close: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    } as unknown as BrowserProtocolPort;
}

export function packagedZcodeTargetProtocolFixtures(input: {
    readonly sourceProjectId: string;
    readonly sourceAssetId: string;
    readonly sourceVersionId: string;
    readonly targetProjectId: string;
    readonly targetAssetId: string;
    readonly targetVersionId: string;
    readonly deploymentId: string;
    readonly reversedVersionId: string;
}) {
    const deployRequest = Object.freeze({
        mode: "deploy" as const,
        assetKind: "Guidance" as const,
        sourceProjectRegistrationToken: "source-project-registration-token",
        sourceProjectToken: "source-token",
        targetProjectRegistrationToken: "target-project-registration-token",
        targetProjectToken: "target-token",
    });
    const deploySubjects = Object.freeze({
        assetKind: "Guidance" as const,
        source: Object.freeze({
            projectId: input.sourceProjectId,
            assetId: input.sourceAssetId,
            versionId: input.sourceVersionId,
        }),
        target: Object.freeze({
            projectId: input.targetProjectId,
            assetId: input.targetAssetId,
            versionId: input.targetVersionId,
            deploymentId: input.deploymentId,
        }),
    });
    const forKind = <Kind extends "Workflow" | "Skill" | "Subagent" | "Memory">(assetKind: Kind) =>
        Object.freeze({
            request: Object.freeze({ ...deployRequest, assetKind }),
            subjects: Object.freeze({ ...deploySubjects, assetKind }),
        });
    return Object.freeze({
        deployRequest,
        deploySubjects,
        workflow: forKind("Workflow"),
        skill: forKind("Skill"),
        subagent: forKind("Subagent"),
        memory: forKind("Memory"),
        reverseRequest: Object.freeze({
            mode: "reverse" as const,
            assetKind: "Guidance" as const,
            subject: deploySubjects.target,
        }),
        reversedSubject: Object.freeze({ ...deploySubjects.target, versionId: input.reversedVersionId }),
    });
}

export function packagedZcodeDeployConnections(connection: ClientConnectionApi) {
    return {
        sourceProjectRegistration: connection,
        source: connection,
        targetProjectRegistration: connection,
        target: connection,
    };
}
import type { ClientConnectionApi } from "@oaam/client-framework";
import { vi } from "vitest";
import type { BrowserProtocolPort } from "../src/renderer/client";
