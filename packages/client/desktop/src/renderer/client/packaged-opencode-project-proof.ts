import type { ClientConnectionApi, createClientConnection } from "@oaam/client-framework";
import {
    PACKAGED_OPENCODE_PROJECT_PROOF_PORT_SIGNAL,
    type PackagedOpenCodeProjectProofReply,
    type PackagedOpenCodeProjectProofRequest,
    type PackagedOpenCodeProjectProofResult,
    type PackagedOpenCodeProjectProofStep,
    parsePackagedOpenCodeProjectProofRequest,
} from "../../bridge/desktop-bridge";
import { type BrowserProtocolPort, MessagePortClientTransport } from "./message-port-transport";

class PackagedOpenCodeProjectProofFailure extends Error {
    public readonly step: PackagedOpenCodeProjectProofStep;

    public constructor(step: PackagedOpenCodeProjectProofStep, message: string) {
        super(message);
        this.name = "PackagedOpenCodeProjectProofFailure";
        this.step = step;
    }
}

function fail(step: PackagedOpenCodeProjectProofStep, message: string): never {
    throw new PackagedOpenCodeProjectProofFailure(step, message);
}

export async function provePackagedOpenCodeProjectWithConnection(
    connection: ClientConnectionApi,
    request: PackagedOpenCodeProjectProofRequest,
): Promise<PackagedOpenCodeProjectProofResult> {
    const initialized = await connection.initialize({
        protocolVersion: 1,
        clientKind: "desktop",
        clientVersion: "0.1.0",
    });
    if (initialized.protocolVersion !== 1) {
        fail("initialize", "packaged OpenCode project proof negotiated the wrong Protocol");
    }

    const enablement = await connection.request("adapter_enablement.get", {});
    if (enablement.status !== "complete") {
        fail("enablement", "packaged OpenCode project proof could not read Adapter enablement");
    }
    const enabledAdapterIds: readonly string[] = enablement.value.enabledAdapterIds;
    if (!enabledAdapterIds.includes("OPENCODE")) {
        const replaced = await connection.request("adapter_enablement.replace", {
            expectedRevision: enablement.value.revision,
            expectedSettingFingerprint: enablement.value.settingFingerprint,
            enabledAdapterIds: [...new Set([...enabledAdapterIds, "OPENCODE"])].sort(),
            userActionId: "packaged-opencode-project-proof-enable",
        });
        const replacedAdapterIds: readonly string[] = replaced.status === "complete" ? replaced.value.enabledAdapterIds : [];
        if (replaced.status !== "complete" || !replacedAdapterIds.includes("OPENCODE")) {
            fail("enablement", "packaged OpenCode project proof could not enable the OpenCode Adapter");
        }
    }

    const operation = await connection.start("adapter.probe", {
        adapterIds: ["OPENCODE"],
        environments: [request.environment],
        authorization: { scope: "global" },
    });
    const terminal = await operation.terminal;
    if (terminal.status === "failed" || terminal.value.results.length !== 1) {
        fail("probe", "packaged OpenCode project probe did not return one non-failed result");
    }
    const result = terminal.value.results[0];
    const runtime = result.runtimes.find((candidate) => candidate.agentRuntimeId === "OPENCODE_CLI");
    if (
        result.status === "failed" ||
        result.adapterId !== "OPENCODE" ||
        result.environment.platform !== request.environment.platform ||
        result.environment.platformInstanceId !== request.environment.platformInstanceId ||
        runtime?.installationStatus !== "available" ||
        runtime.projectDiscoveryStatus !== "complete"
    ) {
        fail(
            "runtime_identity",
            `packaged OpenCode project probe did not preserve the selected runtime identity: ${JSON.stringify({
                adapterId: result.adapterId,
                environment: result.environment,
                resultStatus: result.status,
                runtimes: result.runtimes.map((candidate) => ({
                    agentRuntimeId: candidate.agentRuntimeId,
                    installationStatus: candidate.installationStatus,
                    projectDiscoveryStatus: candidate.projectDiscoveryStatus,
                })),
                diagnosticCodes: result.diagnostics.map((diagnostic) => diagnostic.code),
            })}`,
        );
    }
    const targetPaths = result.targets
        .filter((candidate) =>
            candidate.entryApplicabilities.some(
                (entry) => entry.agentRuntimeId === "OPENCODE_CLI" && entry.status === "ready_for_plan",
            ),
        )
        .map((candidate) => candidate.displayPath);
    if (
        result.projects.length !== 1 ||
        targetPaths.length !== 1 ||
        targetPaths[0] !== request.expectedTargetPath ||
        JSON.stringify(result).includes("unsupported_platform")
    ) {
        fail(
            "exact_target",
            `packaged OpenCode project probe did not return one exact ready physical target: ${JSON.stringify({
                projectCount: result.projects.length,
                targetPaths,
                expectedTargetPath: request.expectedTargetPath,
                diagnosticCodes: result.diagnostics.map((diagnostic) => diagnostic.code),
            })}`,
        );
    }
    return Object.freeze({
        mode: request.mode,
        platform: request.environment.platform,
        platformInstanceId: request.environment.platformInstanceId,
        operationStatus: terminal.status,
        resultStatus: result.status,
        projectDiscoveryStatus: "complete",
        projectCount: 1,
        targetPath: targetPaths[0],
        diagnosticCodes: Object.freeze(
            [
                ...new Set([
                    ...terminal.diagnostics.map((diagnostic) => diagnostic.code),
                    ...result.diagnostics.map((diagnostic) => diagnostic.code),
                ]),
            ].sort(),
        ),
    });
}

export async function runPackagedOpenCodeProjectProof(
    port: BrowserProtocolPort,
    request: PackagedOpenCodeProjectProofRequest,
    createConnection: typeof createClientConnection,
    createRequestId: () => string,
): Promise<PackagedOpenCodeProjectProofResult> {
    let listenerError: unknown;
    const transport = new MessagePortClientTransport(port);
    const connection = createConnection(transport, {
        createRequestId,
        reportListenerError(error) {
            listenerError ??= error;
        },
    });
    try {
        const proof = await provePackagedOpenCodeProjectWithConnection(connection, request);
        if (listenerError !== undefined) {
            fail("client_listener", "packaged OpenCode project proof observed a Client listener failure");
        }
        return proof;
    } finally {
        connection.close();
        transport.close();
    }
}

export function installPackagedOpenCodeProjectProofListener(
    browserWindow: Window,
    createConnection: typeof createClientConnection,
    createRequestId: () => string,
): () => void {
    const receive = (event: MessageEvent<unknown>): void => {
        if (event.source !== browserWindow || !isRecord(event.data)) return;
        const data = event.data;
        if (data.signal !== PACKAGED_OPENCODE_PROJECT_PROOF_PORT_SIGNAL) return;
        if (event.ports.length !== 2) {
            for (const port of event.ports) port.close();
            return;
        }
        const [protocolPort, resultPort] = event.ports;
        if (protocolPort === undefined || resultPort === undefined) return;
        void (async () => {
            let reply: PackagedOpenCodeProjectProofReply;
            try {
                const request = parsePackagedOpenCodeProjectProofRequest(data.request);
                const proof = await runPackagedOpenCodeProjectProof(
                    protocolPort as BrowserProtocolPort,
                    request,
                    createConnection,
                    createRequestId,
                );
                reply = Object.freeze({ status: "complete", proof });
            } catch (error) {
                reply = Object.freeze({
                    status: "failed",
                    step: error instanceof PackagedOpenCodeProjectProofFailure ? error.step : "unexpected",
                    detail: boundedErrorDetail(error),
                });
            }
            try {
                resultPort.postMessage(reply);
            } finally {
                resultPort.close();
            }
        })();
    };
    browserWindow.addEventListener("message", receive);
    return () => browserWindow.removeEventListener("message", receive);
}

function boundedErrorDetail(error: unknown): string {
    const detail = error instanceof Error ? error.message : String(error);
    return detail.replaceAll("\0", "").slice(0, 8_192);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
