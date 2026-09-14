import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REVIEWED_PROJECT_ASSET_CONTROLLERS = [
    "project-library-controller.ts",
    "asset-browser-controller.ts",
    "project-lifecycle-controller.ts",
    "asset-inspector-controller.ts",
] as const;

const REVIEWED_DEPLOYMENT_CONTROLLERS = ["catalog-deployment-controller.ts", "catalog-deployment-reverse-controller.ts"] as const;

describe("Desktop Project and Asset product-language source boundary", () => {
    it.each(REVIEWED_PROJECT_ASSET_CONTROLLERS)("keeps raw protocol diagnostics structured in %s", (fileName) => {
        const source = fs.readFileSync(path.resolve(__dirname, `../src/renderer/features/project-library/${fileName}`), "utf8");

        expect(source).not.toContain("technicalText");
        expect(source).not.toMatch(/diagnostics[^;\n]*\.map\([^;\n]*\.message/u);
    });

    it("keeps Asset lifecycle action diagnostics structured", () => {
        const source = fs.readFileSync(
            path.resolve(__dirname, "../src/renderer/features/project-library/AssetActions.tsx"),
            "utf8",
        );

        expect(source).toContain("<ProtocolDiagnostics");
        expect(source).not.toContain("diagnosticMessage(");
        expect(source).not.toMatch(/diagnostics\s*\[\s*0\s*\]\s*\?\.\s*message/u);
    });
});

describe("Desktop Catalog Search product-language source boundary", () => {
    it("keeps failed and partial search diagnostics structured", () => {
        const source = fs.readFileSync(
            path.resolve(__dirname, "../src/renderer/features/catalog-search/CatalogSearchOverlay.tsx"),
            "utf8",
        );

        expect(source).toContain("<ProtocolDiagnostics");
        expect(source).not.toContain("searchFailureMessage(");
        expect(source).not.toMatch(/diagnostics\s*\[\s*0\s*\]\s*\?\.\s*message/u);
    });
});

describe("Desktop Deployment and reverse product-language source boundary", () => {
    it.each(REVIEWED_DEPLOYMENT_CONTROLLERS)("keeps raw protocol diagnostics structured in %s", (fileName) => {
        const source = fs.readFileSync(
            path.resolve(__dirname, `../src/renderer/features/catalog-deployment/${fileName}`),
            "utf8",
        );

        expect(source).not.toContain("technicalText");
        expect(source).not.toMatch(/diagnostics[^;\n]*\.map\([^;\n]*\.message/u);
        expect(source).not.toContain("technicalText(update.progress.stage)");
    });
});

describe("Desktop State, diagnostics, and maintenance product-language source boundary", () => {
    it("keeps State protocol diagnostics structured instead of promoting a raw message", () => {
        const workspace = fs.readFileSync(
            path.resolve(__dirname, "../src/renderer/features/state-resilience/StateResilienceWorkspace.tsx"),
            "utf8",
        );
        const model = fs.readFileSync(
            path.resolve(__dirname, "../src/renderer/features/state-resilience/state-resilience-model.ts"),
            "utf8",
        );

        expect(workspace).toContain("<ProtocolFeedbackNotice {...feedback}");
        const feedbackOwner = fs.readFileSync(
            path.resolve(__dirname, "../src/renderer/presentation/ProtocolDiagnostics.tsx"),
            "utf8",
        );
        expect(feedbackOwner).toMatch(/<ProtocolDiagnostics\s+embedded\s+diagnostics=\{diagnostics\}/u);
        expect(workspace).not.toContain("firstDiagnosticMessage");
        expect(workspace).not.toMatch(/diagnostics\s*\[\s*0\s*\]\s*\?\.\s*message/u);
        expect(model).not.toContain("firstDiagnosticMessage");
    });

    it("keeps diagnostics structured and projects finite Host health states", () => {
        const workspace = fs.readFileSync(
            path.resolve(__dirname, "../src/renderer/features/diagnostics/DiagnosticsWorkspace.tsx"),
            "utf8",
        );
        const presentation = fs.readFileSync(
            path.resolve(__dirname, "../src/renderer/features/diagnostics/diagnostics-presentation.ts"),
            "utf8",
        );

        expect(workspace).toContain("<ProtocolFeedbackNotice {...feedback}");
        expect(workspace).not.toContain("diagnosticMessage(");
        expect(workspace).not.toMatch(/diagnostics\s*\[\s*0\s*\]\s*\?\.\s*message/u);
        expect(presentation).toContain("HOST_LIFECYCLE_MESSAGES");
        expect(presentation).toContain("HOST_STARTUP_MODE_MESSAGES");
        expect(presentation).toContain("ORDINARY_LOG_SUSPENSION_MESSAGES");
    });

    it("keeps finite maintenance bridge failures on localized message IDs", () => {
        const source = fs.readFileSync(
            path.resolve(__dirname, "../src/renderer/features/desktop-maintenance/DesktopMaintenanceWorkspace.tsx"),
            "utf8",
        );

        expect(source).not.toContain("error.message");
        expect(source).not.toMatch(/setOutcome\([^)]*\.code/u);
        expect(source).toContain("settings.maintenance.location.action_failed");
    });
});
