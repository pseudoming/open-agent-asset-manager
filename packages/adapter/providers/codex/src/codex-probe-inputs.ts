/** Independent observations for one already-authorized Codex probe. */

import type { CodexProbeConfigResult } from "./codex-probe-guidance-config";
import type { CodexInstallationSearch } from "./codex-probe-installation";

export async function observeCodexProbeInputs(observations: {
    config: () => Promise<CodexProbeConfigResult>;
    cli: () => Promise<CodexInstallationSearch>;
    app: () => CodexInstallationSearch;
}): Promise<{
    config: CodexProbeConfigResult;
    cliInstall: CodexInstallationSearch;
    appInstall: CodexInstallationSearch;
}> {
    // Join every started observation before returning or throwing. Each owner
    // retains its own I/O bounds and failure-to-diagnostic projection.
    const [config, cli, app] = await Promise.allSettled([
        Promise.resolve().then(observations.config),
        Promise.resolve().then(observations.cli),
        Promise.resolve().then(observations.app),
    ]);
    if (config.status === "rejected") throw config.reason;
    // Previously a synchronous App failure preceded settlement of the CLI.
    if (app.status === "rejected") throw app.reason;
    if (cli.status === "rejected") throw cli.reason;
    return { config: config.value, cliInstall: cli.value, appInstall: app.value };
}
