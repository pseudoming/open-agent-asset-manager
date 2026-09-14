import { describe, expect, it } from "vitest";
import { type InstallationSearch, observeAntigravityInstallationsConcurrently } from "../src/antigravity-probe-installation";

function installation(versionText: string): InstallationSearch {
    return { status: "available", evidence: [], diagnostics: [], versionText };
}

describe("Antigravity installation entry isolation", () => {
    it("starts all entry owners before awaiting any result", async () => {
        const started: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const observe = async (entry: string) => {
            started.push(entry);
            await gate;
            return installation(entry);
        };
        const result = observeAntigravityInstallationsConcurrently({
            observeCli: () => observe("cli"),
            observeApp: () => observe("app"),
            observeIde: () => observe("ide"),
        });
        expect(started).toEqual(["cli", "app", "ide"]);
        release();
        expect(await result).toEqual({ cli: installation("cli"), app: installation("app"), ide: installation("ide") });
    });

    it.each([
        ["cli", "Antigravity CLI", "1.1.11", "2.2.1", "2.1.1"],
        ["app", "Antigravity App", "1.1.11", "2.2.1", "2.1.1"],
        ["ide", "Antigravity IDE", "1.1.11", "2.2.1", "2.1.1"],
    ] as const)("keeps sibling entry observations when the %s owner rejects", async (failedEntry, label, cli, app, ide) => {
        const privateFailure = new Error("private entry path and native failure");
        const result = await observeAntigravityInstallationsConcurrently({
            observeCli: async () => {
                if (failedEntry === "cli") throw privateFailure;
                return installation(cli);
            },
            observeApp: async () => {
                if (failedEntry === "app") throw privateFailure;
                return installation(app);
            },
            observeIde: async () => {
                if (failedEntry === "ide") throw privateFailure;
                return installation(ide);
            },
        });

        const failed = result[failedEntry];
        expect(failed).toMatchObject({
            status: "unknown",
            versionText: "",
            diagnostics: [
                {
                    code: `antigravity_${failedEntry}_installation_observation_failed`,
                    causeKind: "partial",
                    severity: "warning",
                    retryable: true,
                    suggestedActions: ["retry"],
                },
            ],
        });
        expect(failed.diagnostics[0]?.message).toContain(label);
        expect(JSON.stringify(failed.diagnostics)).not.toMatch(/private entry path|native failure/iu);
        if (failedEntry !== "cli") expect(result.cli).toEqual(installation(cli));
        if (failedEntry !== "app") expect(result.app).toEqual(installation(app));
        if (failedEntry !== "ide") expect(result.ide).toEqual(installation(ide));
    });

    it("projects an entry permission rejection without discarding sibling evidence", async () => {
        const permissionError = Object.assign(new Error("private denied path"), { code: "EACCES" });
        const result = await observeAntigravityInstallationsConcurrently({
            observeCli: async () => installation("1.1.11"),
            observeApp: async () => {
                throw permissionError;
            },
            observeIde: async () => installation("2.1.1"),
        });

        expect(result.app).toMatchObject({
            status: "needs_permission",
            diagnostics: [
                expect.objectContaining({
                    code: "antigravity_app_installation_observation_failed",
                    causeKind: "permission_denied",
                    suggestedActions: ["grant_permission"],
                }),
            ],
        });
        expect(result.cli).toEqual(installation("1.1.11"));
        expect(result.ide).toEqual(installation("2.1.1"));
    });
});
