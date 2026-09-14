import { describe, expect, it } from "vitest";
import {
    canMoveWorkbenchHistory,
    createWorkbenchNavigation,
    currentWorkbenchRoute,
    leaveWorkbenchSettings,
    moveWorkbenchHistory,
    pushWorkbenchRoute,
    replaceWorkbenchRoute,
} from "../src/renderer/app/workbench-navigation";

describe("Desktop workbench navigation", () => {
    it("keeps exact imported Versions distinct in history and on return from Settings", () => {
        const first = {
            surface: "library",
            subject: "global",
            collection: "global",
            assetId: "asset-1",
            versionId: "version-1",
        } as const;
        const initial = createWorkbenchNavigation(first);
        const second = pushWorkbenchRoute(initial, { ...first, versionId: "version-2" });
        expect(second.entries).toHaveLength(2);
        const settings = pushWorkbenchRoute(second, { surface: "settings", category: "general" });
        expect(currentWorkbenchRoute(leaveWorkbenchSettings(settings))).toEqual({ ...first, versionId: "version-2" });
        expect(currentWorkbenchRoute(moveWorkbenchHistory(second, "back"))).toEqual(first);
    });

    it("records typed user locations while keeping duplicate and presentation-only updates out of history", () => {
        const initial = createWorkbenchNavigation({ surface: "library", subject: "projects" });
        const resolved = replaceWorkbenchRoute(initial, {
            surface: "library",
            subject: "projects",
            projectId: "project-1",
        });
        const asset = pushWorkbenchRoute(resolved, {
            surface: "library",
            subject: "projects",
            projectId: "project-1",
            assetId: "asset-1",
        });
        const duplicate = pushWorkbenchRoute(asset, currentWorkbenchRoute(asset));
        const settings = pushWorkbenchRoute(duplicate, { surface: "settings", category: "general" });
        const settingsDiagnostics = pushWorkbenchRoute(settings, { surface: "settings", category: "diagnostics" });
        const guidedImport = pushWorkbenchRoute(settingsDiagnostics, { surface: "guided_import" });
        const duplicateGuidedImport = pushWorkbenchRoute(guidedImport, { surface: "guided_import" });
        const projectGuidedImport = pushWorkbenchRoute(guidedImport, {
            surface: "guided_import",
            targetProjectId: "project-1",
        });
        const otherProjectGuidedImport = pushWorkbenchRoute(projectGuidedImport, {
            surface: "guided_import",
            targetProjectId: "project-2",
        });

        expect(resolved.entries).toHaveLength(1);
        expect(duplicate).toBe(asset);
        expect(settings.entries).toHaveLength(3);
        expect(settingsDiagnostics.entries).toHaveLength(4);
        expect(duplicateGuidedImport).toBe(guidedImport);
        expect(currentWorkbenchRoute(guidedImport)).toEqual({ surface: "guided_import" });
        expect(projectGuidedImport.entries).toHaveLength(guidedImport.entries.length + 1);
        expect(otherProjectGuidedImport.entries).toHaveLength(projectGuidedImport.entries.length + 1);
        expect(canMoveWorkbenchHistory(guidedImport, "back")).toBe(true);
        expect(canMoveWorkbenchHistory(guidedImport, "forward")).toBe(false);
    });

    it("moves without creating entries and drops an abandoned forward branch after new navigation", () => {
        const project = createWorkbenchNavigation({
            surface: "library",
            subject: "projects",
            projectId: "project-1",
        });
        const deployment = pushWorkbenchRoute(project, {
            surface: "deployment",
            subject: { subjectKind: "project", projectId: "project-1" },
        });
        const settings = pushWorkbenchRoute(deployment, { surface: "settings", category: "general" });
        const backToDeployment = moveWorkbenchHistory(settings, "back");
        const backToProject = moveWorkbenchHistory(backToDeployment, "back");
        const global = pushWorkbenchRoute(backToProject, { surface: "library", subject: "global" });

        expect(currentWorkbenchRoute(backToDeployment)).toEqual({
            surface: "deployment",
            subject: { subjectKind: "project", projectId: "project-1" },
        });
        expect(currentWorkbenchRoute(backToProject)).toEqual({
            surface: "library",
            subject: "projects",
            projectId: "project-1",
        });
        expect(global.entries).toHaveLength(2);
        expect(currentWorkbenchRoute(global)).toEqual({ surface: "library", subject: "global" });
        expect(canMoveWorkbenchHistory(global, "forward")).toBe(false);
        expect(moveWorkbenchHistory(global, "forward")).toBe(global);
    });

    it("leaves every consecutive Settings route for the closest application route while preserving typed history", () => {
        const project = createWorkbenchNavigation({
            surface: "library",
            subject: "projects",
            projectId: "project-1",
        });
        const general = pushWorkbenchRoute(project, { surface: "settings", category: "general" });
        const environments = pushWorkbenchRoute(general, { surface: "settings", category: "environments" });
        const left = leaveWorkbenchSettings(environments, { surface: "library", subject: "global" });

        expect(currentWorkbenchRoute(left)).toEqual({
            surface: "library",
            subject: "projects",
            projectId: "project-1",
        });
        expect(left.entries).toBe(environments.entries);
        expect(currentWorkbenchRoute(moveWorkbenchHistory(left, "forward"))).toEqual({
            surface: "settings",
            category: "general",
        });
        expect(leaveWorkbenchSettings(project, { surface: "library", subject: "global" })).toBe(project);

        const orphanSettings = createWorkbenchNavigation({ surface: "settings", category: "maintenance" });
        expect(currentWorkbenchRoute(leaveWorkbenchSettings(orphanSettings, { surface: "library", subject: "global" }))).toEqual({
            surface: "library",
            subject: "global",
        });
    });

    it("compares complete deployment subjects and preserves a duplicate replacement", () => {
        const projectDeployment = createWorkbenchNavigation({
            surface: "deployment",
            subject: { subjectKind: "project", projectId: "project-1" },
        });
        const duplicateProject = pushWorkbenchRoute(projectDeployment, {
            surface: "deployment",
            subject: { subjectKind: "project", projectId: "project-1" },
        });
        const selectedAsset = pushWorkbenchRoute(projectDeployment, {
            surface: "deployment",
            subject: { subjectKind: "project", projectId: "project-1" },
            assetId: "asset-1",
        });
        const duplicateSelectedAsset = pushWorkbenchRoute(selectedAsset, {
            surface: "deployment",
            subject: { subjectKind: "project", projectId: "project-1" },
            assetId: "asset-1",
        });
        const otherSelectedAsset = pushWorkbenchRoute(selectedAsset, {
            surface: "deployment",
            subject: { subjectKind: "project", projectId: "project-1" },
            assetId: "asset-2",
        });
        const otherProject = pushWorkbenchRoute(otherSelectedAsset, {
            surface: "deployment",
            subject: { subjectKind: "project", projectId: "project-2" },
        });
        const globalDeployment = pushWorkbenchRoute(otherProject, {
            surface: "deployment",
            subject: { subjectKind: "global" },
        });
        const duplicateGlobal = pushWorkbenchRoute(globalDeployment, {
            surface: "deployment",
            subject: { subjectKind: "global" },
        });

        expect(duplicateProject).toBe(projectDeployment);
        expect(selectedAsset.entries).toHaveLength(2);
        expect(duplicateSelectedAsset).toBe(selectedAsset);
        expect(otherSelectedAsset.entries).toHaveLength(3);
        expect(otherProject.entries).toHaveLength(4);
        expect(duplicateGlobal).toBe(globalDeployment);
        expect(replaceWorkbenchRoute(globalDeployment, currentWorkbenchRoute(globalDeployment))).toBe(globalDeployment);
    });

    it("moves through retained forward history, stops at both boundaries, and rejects an invalid empty state", () => {
        const initial = createWorkbenchNavigation({ surface: "library", subject: "global" });
        const settings = pushWorkbenchRoute(initial, { surface: "settings", category: "maintenance" });
        const back = moveWorkbenchHistory(settings, "back");
        const forward = moveWorkbenchHistory(back, "forward");

        expect(moveWorkbenchHistory(initial, "back")).toBe(initial);
        expect(currentWorkbenchRoute(forward)).toEqual({ surface: "settings", category: "maintenance" });
        expect(canMoveWorkbenchHistory(back, "forward")).toBe(true);
        expect(() => currentWorkbenchRoute({ entries: [], index: 0 })).toThrow("workbench navigation has no current route");
    });

    it("keeps Asset collection routes and exact Import source routes as distinct history locations", () => {
        const environment = { platform: "win32" as const, platformInstanceId: "desktop-local" };
        const project = createWorkbenchNavigation({
            surface: "library",
            subject: "projects",
            projectId: "project-1",
            collection: "project",
            kind: "Skill",
        });
        const duplicateProject = pushWorkbenchRoute(project, currentWorkbenchRoute(project));
        const globalCollection = pushWorkbenchRoute(project, {
            surface: "library",
            subject: "projects",
            projectId: "project-1",
            collection: "global",
            kind: "Skill",
        });
        const sources = pushWorkbenchRoute(globalCollection, { surface: "sources", selection: "all" });
        const environmentSources = pushWorkbenchRoute(sources, {
            surface: "sources",
            selection: "environment",
            environment,
        });
        const source = pushWorkbenchRoute(environmentSources, {
            surface: "sources",
            selection: "source",
            environment,
            canonicalPath: "C:\\Users\\person\\.claude",
        });
        const duplicateSource = pushWorkbenchRoute(source, currentWorkbenchRoute(source));
        const otherSource = pushWorkbenchRoute(source, {
            surface: "sources",
            selection: "source",
            environment,
            canonicalPath: "C:\\Users\\person\\.config\\opencode",
        });

        expect(duplicateProject).toBe(project);
        expect(globalCollection.entries).toHaveLength(2);
        expect(sources.entries).toHaveLength(3);
        expect(environmentSources.entries).toHaveLength(4);
        expect(duplicateSource).toBe(source);
        expect(otherSource.entries).toHaveLength(6);
        expect(currentWorkbenchRoute(moveWorkbenchHistory(otherSource, "back"))).toEqual({
            surface: "sources",
            selection: "source",
            environment,
            canonicalPath: "C:\\Users\\person\\.claude",
        });
    });
});
