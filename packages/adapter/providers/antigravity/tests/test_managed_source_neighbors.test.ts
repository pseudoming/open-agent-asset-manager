/** An ordinary source read preserves independent complete Skills beside OAAM output. */
import { registerManagedSourceNeighborConformance } from "../../../test-support-managed-source";
import { antigravityProvider } from "../src/antigravity-provider";

registerManagedSourceNeighborConformance({
    provider: antigravityProvider,
    agentRuntimeId: "ANTIGRAVITY_CLI",
    base: ".agents/skills",
});
