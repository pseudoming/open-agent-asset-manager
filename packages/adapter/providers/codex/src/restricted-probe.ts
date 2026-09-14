/** Private Bootstrap composition entry; the Adapter/Core public SPI is unchanged. */
import type { AdapterProbeContext, AdapterProvider, PlatformContext } from "@oaam/core";
import { createCodexProvider } from "./codex-provider";
import { probeCodexForSelectedWslHost } from "./codex-probe";

export function createCodexProviderForRestrictedProbe(hostContext: PlatformContext): AdapterProvider {
    const host = structuredClone(hostContext);
    return createCodexProvider((context: AdapterProbeContext) => probeCodexForSelectedWslHost(context, host));
}
