/** An ordinary source read preserves independent complete Skills beside OAAM output. */
import { registerManagedSourceNeighborConformance } from "../../../test-support-managed-source";
import { zcodeProvider } from "../src/zcode-provider";

registerManagedSourceNeighborConformance({
    provider: zcodeProvider,
    agentRuntimeId: "ZCODE_APP",
    base: ".zcode/skills",
    sourceSelection: "user_selected",
});
