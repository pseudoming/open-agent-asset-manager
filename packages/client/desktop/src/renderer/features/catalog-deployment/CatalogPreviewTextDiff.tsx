import { useMemo, useState } from "react";
import { useDesktopPresentation } from "../../presentation";
import { comparePreviewText, type PreviewDiffLine } from "./catalog-preview-text-comparison";

type ReviewItem = PreviewDiffLine | { readonly kind: "fold"; readonly start: number; readonly count: number };

function reviewItems(lines: readonly PreviewDiffLine[], expanded: ReadonlySet<number>): readonly ReviewItem[] {
    const items: ReviewItem[] = [];
    let index = 0;
    while (index < lines.length) {
        const start = index;
        if (lines[index]?.kind !== "context") {
            items.push(lines[index] as PreviewDiffLine);
            index += 1;
            continue;
        }
        while (lines[index]?.kind === "context") index += 1;
        if (expanded.has(start) || index - start <= 6) {
            for (let contextIndex = start; contextIndex < index; contextIndex += 1)
                items.push(lines[contextIndex] as PreviewDiffLine);
            continue;
        }
        const leading = start === 0 ? 0 : 3;
        const trailing = index === lines.length ? 0 : 3;
        items.push(...lines.slice(start, start + leading));
        items.push({ kind: "fold", start, count: index - start - leading - trailing });
        items.push(...lines.slice(index - trailing, index));
    }
    return items;
}

export function CatalogPreviewTextDiff({
    current,
    desired,
}: {
    readonly current: string;
    readonly desired: string;
}): React.JSX.Element {
    const { text } = useDesktopPresentation();
    const comparison = useMemo(() => comparePreviewText(current, desired), [current, desired]);
    const [limit, setLimit] = useState(500);
    const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
    const items = useMemo(() => reviewItems(comparison.lines, expanded), [comparison, expanded]);
    return (
        <div className="catalog-file-diff">
            {current === desired ? <p>{text("library.compare.no_text_changes")}</p> : null}
            {comparison.bounded ? <p>{text("catalog.ui.preview.bounded_diff")}</p> : null}
            <table className="asset-diff-unified" aria-label={text("library.compare.unified")}>
                <thead>
                    <tr>
                        <th aria-label={text("catalog.ui.preview.current_text")}>−</th>
                        <th aria-label={text("catalog.ui.preview.desired_text")}>+</th>
                        <th aria-label={text("catalog.ui.preview.review_tab")} />
                        <th aria-label={text("import.ui.inspector.source_with_lines")} />
                    </tr>
                </thead>
                <tbody>
                    {items.slice(0, limit).map((line) =>
                        line.kind === "fold" ? (
                            <tr className="asset-diff-fold" key={`fold:${line.start}`}>
                                <td colSpan={4}>
                                    <button
                                        type="button"
                                        className="library-secondary-button"
                                        data-oaam-preview-expand-context={line.start}
                                        data-oaam-interaction-entry="features.catalog-deployment.catalog_preview_text_diff.002"
                                        onClick={() =>
                                            setExpanded((currentExpanded) => new Set([...currentExpanded, line.start]))
                                        }
                                    >
                                        {text("library.compare.folded", { count: line.count })}
                                    </button>
                                </td>
                            </tr>
                        ) : (
                            <tr
                                className="asset-diff-line"
                                data-line-kind={line.kind}
                                key={`${line.kind}:${line.currentLine ?? ""}:${line.desiredLine ?? ""}`}
                            >
                                <td>{line.currentLine ?? ""}</td>
                                <td>{line.desiredLine ?? ""}</td>
                                <td>{line.kind === "remove" ? "−" : line.kind === "add" ? "+" : " "}</td>
                                <td>
                                    <code>{line.text}</code>
                                </td>
                            </tr>
                        ),
                    )}
                </tbody>
            </table>
            {items.length <= limit ? null : (
                <button
                    type="button"
                    className="library-secondary-button"
                    data-oaam-interaction-entry="features.catalog-deployment.catalog_preview_text_diff.001"
                    onClick={() => setLimit((currentLimit) => currentLimit + 500)}
                >
                    {text("library.compare.show_more_lines", { shown: limit, total: items.length })}
                </button>
            )}
        </div>
    );
}
