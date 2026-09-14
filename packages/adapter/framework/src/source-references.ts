/** Runtime-neutral Markdown link scanning with provider-owned target policies. */

import type { FileReferenceV2 } from "@oaam/core";
import { portableParentPath } from "./source-text";

export interface MarkdownLinkReferencePolicy {
    normalizeRelativeTarget(rawTarget: string, sourceParent: string): string | null;
    isExternalTarget(rawTarget: string): boolean;
}

export interface MarkdownLinkReferenceInput extends MarkdownLinkReferencePolicy {
    text: string;
    logicalPaths: ReadonlySet<string>;
    sourceLogicalPath: string;
}

export function buildMarkdownLinkReferences(input: MarkdownLinkReferenceInput): FileReferenceV2[] {
    const references: FileReferenceV2[] = [];
    let cursor = 0;
    while (cursor < input.text.length) {
        const openLabel = input.text.indexOf("[", cursor);
        if (openLabel === -1) break;
        const closeLabel = input.text.indexOf("](", openLabel + 1);
        if (closeLabel === -1) break;
        const closeTarget = input.text.indexOf(")", closeLabel + 2);
        if (closeTarget === -1) break;
        const rawTarget = input.text
            .slice(closeLabel + 2, closeTarget)
            .trim()
            .split("#")[0]
            .trim();
        if (rawTarget !== "") {
            const normalized = input.normalizeRelativeTarget(rawTarget, portableParentPath(input.sourceLogicalPath));
            references.push(
                normalized !== null && input.logicalPaths.has(normalized)
                    ? {
                          kind: "link",
                          rawTarget,
                          required: false,
                          diagnostics: [],
                          resolution: "resolved_version_file",
                          targetLogicalPath: normalized,
                      }
                    : {
                          kind: "link",
                          rawTarget,
                          required: false,
                          diagnostics: [],
                          resolution: input.isExternalTarget(rawTarget) ? "external" : "unresolved",
                      },
            );
        }
        cursor = closeTarget + 1;
    }
    return references;
}
