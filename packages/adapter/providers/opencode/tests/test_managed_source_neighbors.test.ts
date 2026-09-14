/** An ordinary source read preserves independent complete Skills beside OAAM output. */
import { registerManagedSourceNeighborConformance } from "../../../test-support-managed-source";
import { opencodeProvider } from "../src/opencode-provider";

registerManagedSourceNeighborConformance({
    provider: opencodeProvider,
    agentRuntimeId: "OPENCODE_CLI",
    base: ".opencode/skills",
});
