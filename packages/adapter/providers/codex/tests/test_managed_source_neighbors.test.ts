/** An ordinary source read preserves independent complete Skills beside OAAM output. */
import { registerManagedSourceNeighborConformance } from "../../../test-support-managed-source";
import { codexProvider } from "../src/codex-provider";

registerManagedSourceNeighborConformance({ provider: codexProvider, agentRuntimeId: "CODEX_CLI", base: ".agents/skills" });
