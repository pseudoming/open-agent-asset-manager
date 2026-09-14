import type { AttributedSemanticChange, RenderedFileAttributionResult } from "@oaam/core";

/** A unique Core attribution names the existing detail without changing its selector or authority. */
export function inspectionChangeDisplayName(
    change: AttributedSemanticChange,
    files: readonly RenderedFileAttributionResult[],
): string {
    const paths = new Set(
        files
            .filter(
                (file) =>
                    file.attributionState === "uniquely_attributable" &&
                    file.changeFingerprints.includes(change.changeFingerprint),
            )
            .map((file) => file.relativePath),
    );
    const [only, ...others] = paths;
    return only !== undefined && others.length === 0 ? only : change.changeKind;
}
