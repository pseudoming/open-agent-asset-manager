/** An ordinary source read preserves independent complete Skills beside OAAM output. */
import { registerManagedSourceNeighborConformance } from "../../../test-support-managed-source";
import { claudecodeProvider } from "../src/claudecode-provider";

registerManagedSourceNeighborConformance({
    provider: claudecodeProvider,
    agentRuntimeId: "CLAUDE_CODE_CLI",
    base: ".claude/skills",
});
