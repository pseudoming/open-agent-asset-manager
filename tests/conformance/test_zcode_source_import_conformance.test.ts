/** ZCode project-keyed Memory import conformance through the real Production Host. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createProtocolRequest } from "@oaam/app-server-protocol";
import type { HostOutboundMessage, ProductionHost } from "@oaam/app-server-host";
import type { PlatformContext } from "@oaam/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createZcodeProjectMemoryKey } from "../../packages/adapter/providers/zcode/src/zcode-probe-memory-paths";
import { launchProductionHost } from "../../packages/app-server/bootstrap/src/production-bootstrap";
import { clearRegistry } from "../../packages/core/src/orchestration/adapter-registry";
import { closeDb } from "../../packages/core/src/persistence/db";
import { hostOutcomeValue, waitForHostResponse, waitForHostTerminal } from "./production-host-operation-fixtures";

const TOPIC_NAME = "Build conventions";
const TOPIC_BODY = "Run the canonical verification before publishing a change.";
const TOPIC =
    "---\n" +
    `name: ${TOPIC_NAME}\n` +
    "description: Preserve the verified build boundary\n" +
    "type: project\n" +
    "sessionId: source-session\n" +
    "source: user\n" +
    "updatedAt: 2026-07-21T00:00:00.000Z\n" +
    "---\n" +
    `${TOPIC_BODY}\n`;

describe("ZCode source import conformance", () => {
    let sandbox = "";
    let home = "";
    let projectRoot = "";
    let platformContext: PlatformContext;
    let productionHost: ProductionHost | null = null;
    let savedEnvironment: Record<"HOME" | "PATH" | "ZCODE_DATA_BASE_DIR" | "ZCODE_STORAGE_DIR", string | undefined>;

    beforeEach(() => {
        savedEnvironment = {
            HOME: process.env.HOME,
            PATH: process.env.PATH,
            ZCODE_DATA_BASE_DIR: process.env.ZCODE_DATA_BASE_DIR,
            ZCODE_STORAGE_DIR: process.env.ZCODE_STORAGE_DIR,
        };
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-zcode-source-import-"));
        home = path.join(sandbox, "home");
        projectRoot = path.join(sandbox, "project");
        platformContext = { platform: "linux", platformInstanceId: "fixture", accessRootPath: sandbox };
        fs.mkdirSync(path.join(projectRoot, ".git"), { recursive: true });
        const projectKey = createZcodeProjectMemoryKey(projectRoot, "linux");
        if (projectKey === null) throw new Error("ZCode fixture project key was not created");
        const memoryRoot = path.join(home, ".zcode", "cli", "memories", "projects", projectKey);
        fs.mkdirSync(path.join(memoryRoot, "topics"), { recursive: true });
        fs.writeFileSync(
            path.join(memoryRoot, "MEMORY.md"),
            `# ZCode Project Memory\n\n## Topic Index\n\n- [${TOPIC_NAME}](topics/build.md) — Build rules (type: project)\n`,
        );
        fs.writeFileSync(path.join(memoryRoot, "topics", "build.md"), TOPIC);
        process.env.HOME = home;
        process.env.PATH = path.join(sandbox, "bin");
        delete process.env.ZCODE_DATA_BASE_DIR;
        delete process.env.ZCODE_STORAGE_DIR;
        clearRegistry();
        closeDb();
    });

    afterEach(async () => {
        await productionHost?.shutdown();
        productionHost = null;
        restoreEnvironment(savedEnvironment);
        closeDb();
        clearRegistry();
        fs.rmSync(sandbox, { recursive: true, force: true });
    });

    it("imports one exact project Memory topic while leaving its binding-required Catalog unaccepted", async () => {
        productionHost = launchProductionHost({
            oaamRoot: path.join(sandbox, "oaam"),
            databasePath: path.join(sandbox, "state.db"),
            platformContexts: [platformContext],
        });
        const messages: HostOutboundMessage[] = [];
        const connection = productionHost.openConnection({
            send: (message) => messages.push(message),
            close() {},
        });
        connection.receive({
            id: "initialize",
            method: "initialize",
            params: { protocolVersion: 1, clientKind: "headless", clientVersion: "0.1.0" },
        });
        await waitForHostResponse(messages, "initialize");

        connection.receive(createProtocolRequest("enablement", "adapter_enablement.get", {}));
        const enablement = hostOutcomeValue<{ revision: number; settingFingerprint: string }>(
            await waitForHostResponse(messages, "enablement"),
        );
        connection.receive(
            createProtocolRequest("enable-zcode", "adapter_enablement.replace", {
                expectedRevision: enablement.revision,
                expectedSettingFingerprint: enablement.settingFingerprint,
                enabledAdapterIds: ["ZCODE"],
                userActionId: "enable-zcode-production-conformance",
            }),
        );
        expect(hostOutcomeValue(await waitForHostResponse(messages, "enable-zcode"))).toMatchObject({
            enabledAdapterIds: ["ZCODE"],
        });

        const registerToken = connection.registerLocalPathSelection("project_root", projectRoot);
        connection.receive(
            createProtocolRequest("register-project", "project.register", {
                localPathSelectionToken: registerToken,
                displayName: "ZCode Memory source fixture",
            }),
        );
        expect(hostOutcomeValue(await waitForHostResponse(messages, "register-project"))).toMatchObject({
            rootPath: projectRoot,
        });

        const probeToken = connection.registerLocalPathSelection("project_root", projectRoot);
        connection.receive(
            createProtocolRequest("probe", "adapter.probe", {
                adapterIds: ["ZCODE"],
                environments: [{ platform: "linux", platformInstanceId: "fixture" }],
                authorization: { scope: "project", localPathSelectionToken: probeToken },
            }),
        );
        const probeOutcome = await waitForHostTerminal(messages, "adapter.probe");
        expect(probeOutcome).toMatchObject({
            status: "partial",
            diagnostics: expect.arrayContaining([expect.objectContaining({ code: "zcode_app_install_rules_unverified" })]),
        });
        const probe = hostOutcomeValue<{
            probeToken: string;
            results: Array<{
                rowId: string;
                adapterId: string;
                sources: Array<{ rowId: string; displayPath: string; locatorIdentities: unknown[] }>;
            }>;
        }>(probeOutcome, ["partial"]);
        const projectKey = createZcodeProjectMemoryKey(projectRoot, "linux");
        const expectedMemoryRoot = path.join(home, ".zcode", "cli", "memories", "projects", projectKey ?? "missing");
        const probeRow = probe.results.find((row) => row.adapterId === "ZCODE");
        const memorySource = probeRow?.sources.find((source) => source.displayPath === expectedMemoryRoot);
        expect(memorySource?.locatorIdentities).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ locatorKind: "runtime_known_rule" }),
                expect.objectContaining({ locatorKind: "user_provided_path" }),
            ]),
        );
        if (probeRow === undefined || memorySource === undefined) throw new Error("production ZCode Memory source missing");

        connection.receive(
            createProtocolRequest("read", "adapter.read", {
                probeToken: probe.probeToken,
                selections: [
                    {
                        probeResultRowId: probeRow.rowId,
                        sourceRootRowIds: [memorySource.rowId],
                        allowedKinds: ["Memory"],
                    },
                ],
            }),
        );
        const read = hostOutcomeValue<{ readToken: string; candidateCount: number }>(
            await waitForHostTerminal(messages, "adapter.read"),
        );
        expect(read.candidateCount).toBe(2);

        connection.receive(createProtocolRequest("preview", "import.preview", { readToken: read.readToken }));
        const preview = hostOutcomeValue<{
            previewToken: string;
            snapshotFingerprint: string;
            candidates: Array<{
                candidateId: string;
                displayName: string;
                status: string;
                callableBindingRequestCount: number;
            }>;
        }>(await waitForHostTerminal(messages, "import.preview"));
        expect(preview.candidates).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    displayName: "ZCode Memory catalog",
                    status: "importable",
                    callableBindingRequestCount: 1,
                }),
                expect.objectContaining({ displayName: TOPIC_NAME, status: "importable", callableBindingRequestCount: 0 }),
            ]),
        );
        const topicCandidate = preview.candidates.find((candidate) => candidate.displayName === TOPIC_NAME);
        if (topicCandidate === undefined) throw new Error("production ZCode preview has no importable Memory topic");

        connection.receive(
            createProtocolRequest("accept", "import.accept_batch", {
                previewToken: preview.previewToken,
                expectedSnapshotFingerprint: preview.snapshotFingerprint,
                decisions: [
                    {
                        candidateId: topicCandidate.candidateId,
                        action: "create_asset",
                        freshness: { freshnessAction: "require_current_source" },
                        promotion: { promotionAction: "import_only", userActionId: "accept-zcode-memory-source" },
                        callableBindings: [],
                    },
                ],
            }),
        );
        expect(hostOutcomeValue(await waitForHostTerminal(messages, "import.accept_batch"))).toMatchObject({
            items: [{ status: "complete", candidateId: topicCandidate.candidateId }],
        });

        connection.receive(createProtocolRequest("catalog", "asset.list", { kind: "Memory" }));
        expect(hostOutcomeValue(await waitForHostResponse(messages, "catalog"))).toMatchObject({
            assets: [expect.objectContaining({ displayName: TOPIC_NAME, kind: "Memory", scope: "project" })],
        });
    });
});

function restoreEnvironment(
    saved: Record<"HOME" | "PATH" | "ZCODE_DATA_BASE_DIR" | "ZCODE_STORAGE_DIR", string | undefined>,
): void {
    for (const key of ["HOME", "PATH", "ZCODE_DATA_BASE_DIR", "ZCODE_STORAGE_DIR"] as const) {
        const value = saved[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}
