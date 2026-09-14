const CANONICAL_ROOT_ENTRY_BY_KIND: Readonly<Record<string, string>> = Object.freeze({
    Guidance: "GUIDANCE.md",
    Rule: "RULE.md",
    Workflow: "WORKFLOW.md",
    Subagent: "SUBAGENT.md",
    Memory: "MEMORY.md",
});

export interface AssetFilePresentationIdentity {
    readonly kind: string;
    readonly displayName: string;
}

export function presentAssetFilePath(asset: AssetFilePresentationIdentity, logicalPath: string): string {
    const canonicalRoot = CANONICAL_ROOT_ENTRY_BY_KIND[asset.kind];
    const displayName = asset.displayName.trim();
    return canonicalRoot === logicalPath && displayName !== "" ? displayName : logicalPath;
}
