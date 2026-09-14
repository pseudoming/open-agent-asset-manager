export const PACKAGED_OPENCODE_PROJECT_PROOF_PORT_CHANNEL = "oaam:desktop-packaged-opencode-project-proof-port";
export const PACKAGED_OPENCODE_PROJECT_PROOF_PORT_SIGNAL = "oaam:desktop-packaged-opencode-project-proof-port-ready";

export type PackagedOpenCodeProjectProofMode = "native" | "selected_wsl";

export interface PackagedOpenCodeProjectProofRequest {
    readonly mode: PackagedOpenCodeProjectProofMode;
    readonly environment: {
        readonly platform: "win32" | "wsl";
        readonly platformInstanceId: string;
    };
    readonly expectedTargetPath: string;
}

export interface PackagedOpenCodeProjectProofResult {
    readonly mode: PackagedOpenCodeProjectProofMode;
    readonly platform: "win32" | "wsl";
    readonly platformInstanceId: string;
    readonly operationStatus: "complete" | "partial";
    readonly resultStatus: "complete" | "partial";
    readonly projectDiscoveryStatus: "complete";
    readonly projectCount: number;
    readonly targetPath: string;
    readonly diagnosticCodes: readonly string[];
}

export type PackagedOpenCodeProjectProofStep =
    | "initialize"
    | "enablement"
    | "probe"
    | "runtime_identity"
    | "exact_target"
    | "client_listener"
    | "unexpected";

export type PackagedOpenCodeProjectProofReply =
    | {
          readonly status: "complete";
          readonly proof: PackagedOpenCodeProjectProofResult;
      }
    | {
          readonly status: "failed";
          readonly step: PackagedOpenCodeProjectProofStep;
          readonly detail: string;
      };

const STEPS = new Set<PackagedOpenCodeProjectProofStep>([
    "initialize",
    "enablement",
    "probe",
    "runtime_identity",
    "exact_target",
    "client_listener",
    "unexpected",
]);

export function parsePackagedOpenCodeProjectProofRequest(value: unknown): PackagedOpenCodeProjectProofRequest {
    if (!isRecord(value) || !hasExactKeys(value, ["environment", "expectedTargetPath", "mode"])) {
        throw new TypeError("invalid packaged OpenCode project proof request");
    }
    const mode: PackagedOpenCodeProjectProofMode | null =
        value.mode === "native" ? "native" : value.mode === "selected_wsl" ? "selected_wsl" : null;
    if (mode === null) throw new TypeError("invalid packaged OpenCode project proof request");
    const expectedPlatform = mode === "native" ? "win32" : "wsl";
    if (
        !isRecord(value.environment) ||
        !hasExactKeys(value.environment, ["platform", "platformInstanceId"]) ||
        value.environment.platform !== expectedPlatform ||
        !isBoundedText(value.environment.platformInstanceId, 256) ||
        !isBoundedText(value.expectedTargetPath, 32_768)
    ) {
        throw new TypeError("invalid packaged OpenCode project proof request");
    }
    return Object.freeze({
        mode,
        environment: Object.freeze({
            platform: expectedPlatform,
            platformInstanceId: value.environment.platformInstanceId,
        }),
        expectedTargetPath: value.expectedTargetPath,
    });
}

export function parsePackagedOpenCodeProjectProofReply(value: unknown): PackagedOpenCodeProjectProofReply {
    if (isRecord(value) && hasExactKeys(value, ["proof", "status"]) && value.status === "complete") {
        return Object.freeze({ status: "complete", proof: parseProofResult(value.proof) });
    }
    if (
        isRecord(value) &&
        hasExactKeys(value, ["detail", "status", "step"]) &&
        value.status === "failed" &&
        typeof value.step === "string" &&
        STEPS.has(value.step as PackagedOpenCodeProjectProofStep) &&
        typeof value.detail === "string" &&
        value.detail.length <= 8_192 &&
        !value.detail.includes("\0")
    ) {
        return Object.freeze({
            status: "failed",
            step: value.step as PackagedOpenCodeProjectProofStep,
            detail: value.detail,
        });
    }
    throw new TypeError("invalid packaged OpenCode project proof reply");
}

function parseProofResult(value: unknown): PackagedOpenCodeProjectProofResult {
    if (
        !isRecord(value) ||
        !hasExactKeys(value, [
            "diagnosticCodes",
            "mode",
            "operationStatus",
            "platform",
            "platformInstanceId",
            "projectCount",
            "projectDiscoveryStatus",
            "resultStatus",
            "targetPath",
        ])
    ) {
        throw new TypeError("invalid packaged OpenCode project proof result");
    }
    const mode: PackagedOpenCodeProjectProofMode | null =
        value.mode === "native" ? "native" : value.mode === "selected_wsl" ? "selected_wsl" : null;
    if (mode === null) throw new TypeError("invalid packaged OpenCode project proof result");
    const expectedPlatform = mode === "native" ? "win32" : "wsl";
    if (
        value.platform !== expectedPlatform ||
        !isBoundedText(value.platformInstanceId, 256) ||
        !["complete", "partial"].includes(String(value.operationStatus)) ||
        !["complete", "partial"].includes(String(value.resultStatus)) ||
        value.projectDiscoveryStatus !== "complete" ||
        value.projectCount !== 1 ||
        !isBoundedText(value.targetPath, 32_768) ||
        !isDiagnosticCodes(value.diagnosticCodes)
    ) {
        throw new TypeError("invalid packaged OpenCode project proof result");
    }
    return Object.freeze({
        mode,
        platform: expectedPlatform,
        platformInstanceId: value.platformInstanceId,
        operationStatus: value.operationStatus as "complete" | "partial",
        resultStatus: value.resultStatus as "complete" | "partial",
        projectDiscoveryStatus: "complete",
        projectCount: 1,
        targetPath: value.targetPath,
        diagnosticCodes: Object.freeze([...value.diagnosticCodes]),
    });
}

function isDiagnosticCodes(value: unknown): value is string[] {
    return (
        Array.isArray(value) &&
        value.length <= 64 &&
        value.every((item) => typeof item === "string" && /^[a-z0-9_.-]{1,128}$/u.test(item))
    );
}

function isBoundedText(value: unknown, maximumLength: number): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= maximumLength && !value.includes("\0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    const actual = Object.keys(value).sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
