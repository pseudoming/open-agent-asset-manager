/** The Bootstrap inventory shared by ordinary and restricted App Server composition. */
import { antigravityProvider } from "@oaam/adapter-antigravity";
import { claudecodeProvider } from "@oaam/adapter-claudecode";
import { codexProvider } from "@oaam/adapter-codex";
import { createCodexProviderForRestrictedProbe } from "@oaam/adapter-codex/restricted-probe";
import type { PlatformContext } from "@oaam/core";
import { cursorProvider } from "@oaam/adapter-cursor";
import { opencodeProvider } from "@oaam/adapter-opencode";
import { zcodeProvider } from "@oaam/adapter-zcode";

export const BUILTIN_PROVIDERS = Object.freeze([
    claudecodeProvider,
    antigravityProvider,
    opencodeProvider,
    codexProvider,
    zcodeProvider,
    cursorProvider,
]);

/** Keep Provider-owned persistent locator semantics in the original Host coordinates. */
export function createBuiltinProvidersForRestrictedProbe(hostContext: PlatformContext) {
    return Object.freeze(
        BUILTIN_PROVIDERS.map((provider) =>
            provider === codexProvider ? createCodexProviderForRestrictedProbe(hostContext) : provider,
        ),
    );
}
