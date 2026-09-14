/**
 * @oaam/adapter-claudecode — public entry point.
 *
 * Adapter-family provider for Claude Code CLI/App entries.
 */

export type { ClaudeCodePathRule } from "./claudecode-paths";
export { getPathRule } from "./claudecode-paths";
export { claudecodeProvider, sanitizePath } from "./claudecode-provider";
