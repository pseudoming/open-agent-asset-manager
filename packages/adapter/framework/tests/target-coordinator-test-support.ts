import type { AdapterAssetTargetCapability, AdapterMaterializerCapability, AssetKind, OperationDiagnostic } from "@oaam/core";

const HASH = `sha256:${"0".repeat(64)}`;

export function diagnostic(code: string, operation: "render" | "scan" = "render"): OperationDiagnostic {
    return {
        severity: "error",
        code,
        message: code,
        path: "",
        traceId: "",
        operation,
        causeKind: "unsupported",
        retryable: false,
        suggestedActions: [],
        rawSummary: "",
    };
}

export function targetCapability(
    agentRuntimeId: string,
    assetKind: AssetKind,
    outputContractId: string,
): AdapterAssetTargetCapability {
    return {
        agentRuntimeId,
        assetKind,
        entrySupportStatus: "supported",
        renderStrategy: "native_file",
        outputContractId,
        outputContractFingerprint: HASH,
        targetContextSchemaId: "test-context",
        targetContextSchemaFingerprint: HASH,
        reverseExtractPolicy: "can_reconcile",
        diagnostics: [],
    } as AdapterAssetTargetCapability;
}

export function unavailableCapability(agentRuntimeId: string, assetKind: AssetKind): AdapterAssetTargetCapability {
    return {
        agentRuntimeId,
        assetKind,
        entrySupportStatus: "deferred",
        diagnostics: [diagnostic(`test.${assetKind}.deferred`)],
    } as AdapterAssetTargetCapability;
}

export function materializer(outputContractId: string): AdapterMaterializerCapability {
    return {
        materializerCapabilityKey: `materializer:${outputContractId}`,
        outputContractId,
        outputContractFingerprint: HASH,
        materializationProfileIds: [`profile:${outputContractId}`],
        diagnostics: [],
    };
}
