import * as crypto from "node:crypto";
import type { CoreService } from "@oaam/core";
import { ProductionHostRuntime } from "./host-runtime";
import { createEphemeralOperationalDiagnosticsForTest, type OperationalDiagnostics } from "./operational-diagnostics";
import type { HostStateRecoveryReason, HostStateResilienceIntegration, ProductionHost } from "./types";
import type { HostRenderApprovalAuthority } from "./render-approval-authority";

export function createProductionHost(
    core: CoreService,
    stateResilience: HostStateResilienceIntegration,
    releaseOwnedCore: () => void | Promise<void>,
    operationalDiagnostics: OperationalDiagnostics,
    renderApprovalAuthority?: HostRenderApprovalAuthority,
): ProductionHost {
    return new ProductionHostRuntime(
        crypto.randomUUID(),
        core,
        stateResilience,
        { operationalDiagnostics, ...(renderApprovalAuthority === undefined ? {} : { renderApprovalAuthority }) },
        undefined,
        { mode: "normal" },
        releaseOwnedCore,
    );
}

export function createStateRecoveryHost(
    stateResilience: HostStateResilienceIntegration,
    reason: HostStateRecoveryReason,
    operationalDiagnostics: OperationalDiagnostics,
): ProductionHost {
    return new ProductionHostRuntime(
        crypto.randomUUID(),
        undefined,
        stateResilience,
        { operationalDiagnostics },
        [
            "initialize",
            "operation.observe",
            "operation.cancel",
            "diagnostics.health.get",
            "diagnostics.ordinary_log.settings.get",
            "diagnostics.ordinary_log.settings.replace",
            "diagnostics.ordinary_log.clear",
            "diagnostics.support_bundle.inspect",
            "diagnostics.support_bundle.export",
            "state_restore.inspect",
            "state_restore.activate",
        ],
        { mode: "state_recovery", reason },
    );
}

/** @internal Host-operation seam; production bootstrap supplies Core through createProductionHost. */
export function createHostForCoreForTest(
    hostInstanceId: string,
    core: CoreService,
    stateResilience: HostStateResilienceIntegration,
    createConnectionId: () => string,
    createOperationId: () => string = () => crypto.randomUUID(),
): ProductionHost {
    return new ProductionHostRuntime(
        hostInstanceId,
        core,
        stateResilience,
        {
            createConnectionId,
            createOperationId,
            operationalDiagnostics: createEphemeralOperationalDiagnosticsForTest(),
        },
        undefined,
        { mode: "normal" },
        undefined,
    );
}
