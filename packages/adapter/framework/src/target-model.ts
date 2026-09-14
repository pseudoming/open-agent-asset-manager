/** Runtime-neutral target-handler registry consumed by the final coordinator. */

import type { AdapterProvider, AgentRuntimeId, AssetKind, OutputContractId } from "@oaam/core";

export interface AdapterTargetConsumerHandler {
    agentRuntimeId: AgentRuntimeId;
    assetKind: AssetKind;
    analyze: AdapterProvider["analyzeRender"];
}

export interface AdapterTargetMaterializerHandler {
    outputContractId: OutputContractId;
    materialize: AdapterProvider["materializeRender"];
    inspect: AdapterProvider["inspectRenderedTarget"];
}

export interface AdapterFrameworkTargetDefinition {
    consumers: readonly AdapterTargetConsumerHandler[];
    materializers: readonly AdapterTargetMaterializerHandler[];
}
