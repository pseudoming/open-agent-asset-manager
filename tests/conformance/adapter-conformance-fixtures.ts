/** Single test authority for built-in adapter/provider conformance. */

import type { AdapterProvider, AssetKind } from "../../packages/core/src/types";
import { BUILTIN_ASSET_KINDS } from "../../packages/core/src/specs/registry";
import { antigravityProvider } from "../../packages/adapter/providers/antigravity/src/antigravity-provider";
import { ANTIGRAVITY_ASSET_READER_REGISTRY } from "../../packages/adapter/providers/antigravity/src/antigravity-source-read-registry";
import { claudecodeProvider } from "../../packages/adapter/providers/claudecode/src/claudecode-provider";
import { CLAUDECODE_ASSET_READER_REGISTRY } from "../../packages/adapter/providers/claudecode/src/claudecode-source-read-registry";
import { codexProvider } from "../../packages/adapter/providers/codex/src/codex-provider";
import { CODEX_ASSET_READER_REGISTRY } from "../../packages/adapter/providers/codex/src/codex-source-read-registry";
import { cursorProvider } from "../../packages/adapter/providers/cursor/src/cursor-provider";
import { CURSOR_ASSET_READER_REGISTRY } from "../../packages/adapter/providers/cursor/src/cursor-source-read-registry";
import { opencodeProvider } from "../../packages/adapter/providers/opencode/src/opencode-provider";
import { OPENCODE_ASSET_READER_REGISTRY } from "../../packages/adapter/providers/opencode/src/opencode-source-read-registry";
import { zcodeProvider } from "../../packages/adapter/providers/zcode/src/zcode-provider";
import { ZCODE_ASSET_READER_REGISTRY } from "../../packages/adapter/providers/zcode/src/zcode-source-read-registry";

export const ASSET_KINDS = BUILTIN_ASSET_KINDS;

function exposeRegistry(registry: Readonly<Record<AssetKind, unknown>>): Readonly<Record<AssetKind, unknown>> {
    return registry;
}

export const BUILTIN_ADAPTER_CONFORMANCE_CASES = Object.freeze([
    Object.freeze({
        packageDirectory: "antigravity",
        provider: antigravityProvider,
        sourceReaderRegistry: exposeRegistry(ANTIGRAVITY_ASSET_READER_REGISTRY),
    }),
    Object.freeze({
        packageDirectory: "claudecode",
        provider: claudecodeProvider,
        sourceReaderRegistry: exposeRegistry(CLAUDECODE_ASSET_READER_REGISTRY),
    }),
    Object.freeze({
        packageDirectory: "opencode",
        provider: opencodeProvider,
        sourceReaderRegistry: exposeRegistry(OPENCODE_ASSET_READER_REGISTRY),
    }),
    Object.freeze({
        packageDirectory: "codex",
        provider: codexProvider,
        sourceReaderRegistry: exposeRegistry(CODEX_ASSET_READER_REGISTRY),
    }),
    Object.freeze({
        packageDirectory: "zcode",
        provider: zcodeProvider,
        sourceReaderRegistry: exposeRegistry(ZCODE_ASSET_READER_REGISTRY),
    }),
    Object.freeze({
        packageDirectory: "cursor",
        provider: cursorProvider,
        sourceReaderRegistry: exposeRegistry(CURSOR_ASSET_READER_REGISTRY),
    }),
]);

export const BUILTIN_ADAPTER_PROVIDERS: readonly AdapterProvider[] = Object.freeze(
    BUILTIN_ADAPTER_CONFORMANCE_CASES.map(({ provider }) => provider),
);
