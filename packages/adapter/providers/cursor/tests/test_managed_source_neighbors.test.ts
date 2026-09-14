/** An ordinary source read preserves independent complete Skills beside OAAM output. */
import { registerManagedSourceNeighborConformance } from "../../../test-support-managed-source";
import { cursorProvider } from "../src/cursor-provider";

registerManagedSourceNeighborConformance({
    provider: cursorProvider,
    agentRuntimeId: "CURSOR_AGENT_CLI",
    base: ".cursor/skills",
});
