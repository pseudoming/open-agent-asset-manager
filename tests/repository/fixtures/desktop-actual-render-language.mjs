export const ORDINARY_SURFACE_LANGUAGE_LEXICON = Object.freeze({
    rawIdentity: String.raw`\b(?:CLAUDECODE|OPENCODE|CLAUDE_CODE_CLI|OPENCODE_CLI|agent_runtime_private|family_shared|rootRole|accessStatus)\b`,
    architecture:
        String.raw`\b(?:provider|adapter|runtime(?:\s+entr(?:y|ies))?|source roots?|probe|rendered target|host|durable state|payloads?)\b` +
        String.raw`|agent[-\s]?runtime|ホスト|プロバイダー|アダプター|ランタイム|ソースルート|プローブ` +
        `|Anbieter|Agent-Laufzeit|Laufzeit(?:eintr(?:ag|äge)|-Dateien)?|dauerhaft(?:e|en|er|es)? Zustand` +
        `|运行时|适配器|来源根|探测`,
});

export function assertOrdinarySurfaceLanguage(root, label, context, lexicon) {
    const copy = root.cloneNode(true);
    for (const hidden of copy.querySelectorAll("[hidden], [data-oaam-technical-detail]")) hidden.remove();
    const value = copy.textContent ?? "";
    const internalIdentity = value.match(new RegExp(lexicon.rawIdentity, "u"));
    if (internalIdentity !== null) {
        throw new Error(`${context}: ${label} exposes raw internal identity ${JSON.stringify(internalIdentity[0])}`);
    }
    const architectureLanguage = value.match(new RegExp(lexicon.architecture, "iu"));
    if (architectureLanguage !== null) {
        throw new Error(`${context}: ${label} exposes internal architecture language ${JSON.stringify(architectureLanguage[0])}`);
    }
}

export function ordinaryLanguageRendererArguments() {
    return `${assertOrdinarySurfaceLanguage.toString()}, ${JSON.stringify(ORDINARY_SURFACE_LANGUAGE_LEXICON)}`;
}
