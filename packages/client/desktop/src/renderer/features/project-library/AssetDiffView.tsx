import type { ProtocolOperationTerminal } from "@oaam/app-server-protocol";
import { useMemo, useState } from "react";
import { useDesktopPresentation } from "../../presentation";
import { presentAssetFilePath } from "../asset-content-preview";
import type { AssetVersionSummaryView, AssetView } from "./project-library-model";

type Comparison = Extract<
    ProtocolOperationTerminal<"asset_version.compare">,
    { readonly status: "complete" | "partial" }
>["value"];

export interface AssetDiffViewProps {
    readonly comparison: Comparison;
    readonly mode: "unified" | "side_by_side";
    readonly asset?: Pick<AssetView, "kind" | "displayName">;
    readonly versions?: readonly AssetVersionSummaryView[];
}

const INITIAL_FILE_ROWS = 200;
const FILE_ROW_STEP = 200;
const INITIAL_DIFF_ROWS = 500;
const DIFF_ROW_STEP = 500;

type TextComparison = Extract<Comparison["selectedFile"], { readonly comparisonKind: "text" }>;
type DiffHunk = TextComparison["hunks"][number];
type DiffLine = DiffHunk["lines"][number];

interface VisibleHunk {
    readonly hunk: DiffHunk;
    readonly hunkIndex: number;
    readonly lines: readonly DiffLine[];
}

interface SideBySideRow {
    readonly left?: DiffLine;
    readonly right?: DiffLine;
    readonly rowKind: "context" | "remove" | "add" | "replace";
}

function foldedBefore(
    hunks: Extract<Comparison["selectedFile"], { readonly comparisonKind: "text" }>["hunks"],
    index: number,
): number {
    const current = hunks[index];
    if (current === undefined) return 0;
    const previous = hunks[index - 1];
    return previous === undefined
        ? Math.max(current.leftStart - 1, current.rightStart - 1)
        : Math.max(
              current.leftStart - (previous.leftStart + previous.leftLineCount),
              current.rightStart - (previous.rightStart + previous.rightLineCount),
          );
}

function foldedAfter(selectedFile: Extract<Comparison["selectedFile"], { readonly comparisonKind: "text" }>): number {
    const last = selectedFile.hunks.at(-1);
    if (last === undefined) return 0;
    return Math.max(
        selectedFile.leftLineCount - (last.leftStart + last.leftLineCount - 1),
        selectedFile.rightLineCount - (last.rightStart + last.rightLineCount - 1),
    );
}

function visibleHunks(hunks: TextComparison["hunks"], rowLimit: number): VisibleHunk[] {
    const visible: VisibleHunk[] = [];
    let remaining = rowLimit;
    for (const [hunkIndex, hunk] of hunks.entries()) {
        if (remaining <= 0) break;
        const lines = hunk.lines.slice(0, remaining);
        visible.push({ hunk, hunkIndex, lines });
        remaining -= lines.length;
        if (lines.length < hunk.lines.length) break;
    }
    return visible;
}

function sideBySideRows(lines: readonly DiffLine[]): SideBySideRow[] {
    const rows: SideBySideRow[] = [];
    let index = 0;
    while (index < lines.length) {
        const line = lines[index] as DiffLine;
        if (line.lineKind === "context") {
            rows.push({ left: line, right: line, rowKind: "context" });
            index += 1;
            continue;
        }
        if (line.lineKind === "add") {
            rows.push({ right: line, rowKind: "add" });
            index += 1;
            continue;
        }
        const removed: DiffLine[] = [];
        while (lines[index]?.lineKind === "remove") {
            removed.push(lines[index] as DiffLine);
            index += 1;
        }
        const added: DiffLine[] = [];
        while (lines[index]?.lineKind === "add") {
            added.push(lines[index] as DiffLine);
            index += 1;
        }
        const rowCount = Math.max(removed.length, added.length);
        for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
            const left = removed[rowIndex];
            const right = added[rowIndex];
            rows.push({
                ...(left === undefined ? {} : { left }),
                ...(right === undefined ? {} : { right }),
                rowKind: left !== undefined && right !== undefined ? "replace" : left !== undefined ? "remove" : "add",
            });
        }
    }
    return rows;
}

export function AssetDiffView({ comparison, mode, asset, versions }: AssetDiffViewProps): React.JSX.Element {
    const selectedFile = comparison.selectedFile;
    const comparisonIdentity = `${comparison.left.versionId}:${comparison.right.versionId}:${
        selectedFile.comparisonKind === "not_requested" ? "" : selectedFile.logicalPath
    }`;
    return <AssetDiffWindow comparison={comparison} mode={mode} asset={asset} versions={versions} key={comparisonIdentity} />;
}

function lineKey(line: DiffLine): string {
    return line.lineKind === "context"
        ? `context:${line.leftLine}:${line.rightLine}`
        : line.lineKind === "remove"
          ? `remove:${line.leftLine}`
          : `add:${line.rightLine}`;
}

function AssetDiffWindow({ comparison, mode, asset, versions }: AssetDiffViewProps): React.JSX.Element {
    const { text } = useDesktopPresentation();
    const selectedFile = comparison.selectedFile;
    const fileName = (logicalPath: string): string =>
        asset === undefined ? logicalPath : presentAssetFilePath(asset, logicalPath);
    const versionLabel = (ref: Comparison["left"]): string => {
        const version = versions?.find(
            (entry) => entry.versionId === ref.versionId && entry.fingerprint === ref.versionFingerprint,
        );
        return version === undefined
            ? text("library.inspector.version_select")
            : text("library.assets.revision", { revision: version.revision });
    };
    const [visibleFileRows, setVisibleFileRows] = useState(INITIAL_FILE_ROWS);
    const [visibleDiffRows, setVisibleDiffRows] = useState(INITIAL_DIFF_ROWS);
    const totalDiffRows =
        selectedFile.comparisonKind === "text" ? selectedFile.hunks.reduce((count, hunk) => count + hunk.lines.length, 0) : 0;
    const displayedHunks = useMemo(
        () => (selectedFile.comparisonKind === "text" ? visibleHunks(selectedFile.hunks, visibleDiffRows) : []),
        [selectedFile, visibleDiffRows],
    );
    const allDiffRowsVisible = visibleDiffRows >= totalDiffRows;
    return (
        <div className="asset-diff-result" data-mode={mode}>
            <p
                className="asset-diff-direction"
                data-oaam-compare-left-version={comparison.left.versionId}
                data-oaam-compare-right-version={comparison.right.versionId}
            >
                {text("library.compare.direction", {
                    left: versionLabel(comparison.left),
                    right: versionLabel(comparison.right),
                })}
            </p>
            <section>
                <h4>{text("library.compare.file_graph")}</h4>
                <ul className="asset-diff-file-graph">
                    {comparison.files.slice(0, visibleFileRows).map((file) => (
                        <li key={file.logicalPath} data-change-kind={file.changeKind}>
                            <span>{text(`library.compare.change.${file.changeKind}`)}</span>
                            <code>{fileName(file.logicalPath)}</code>
                        </li>
                    ))}
                </ul>
                {comparison.files.length > visibleFileRows ? (
                    <button
                        data-oaam-interaction-entry="features.project-library.asset_diff_view.001"
                        type="button"
                        className="library-secondary-button asset-diff-more"
                        onClick={() => setVisibleFileRows((count) => count + FILE_ROW_STEP)}
                    >
                        {text("library.compare.show_more_files", {
                            shown: Math.min(visibleFileRows, comparison.files.length),
                            total: comparison.files.length,
                        })}
                    </button>
                ) : null}
            </section>
            {selectedFile.comparisonKind === "not_requested" ? null : (
                <section>
                    <h4>{text("library.compare.selected_file")}</h4>
                    <code>{fileName(selectedFile.logicalPath)}</code>
                    {selectedFile.comparisonKind === "metadata" ? (
                        <p>{text("library.compare.metadata_only")}</p>
                    ) : selectedFile.hunks.length === 0 ? (
                        <p>{text("library.compare.no_text_changes")}</p>
                    ) : mode === "unified" ? (
                        <table className="asset-diff-unified" aria-label={text("library.compare.unified")}>
                            {displayedHunks.map(({ hunk, hunkIndex, lines }) => (
                                <tbody className="asset-diff-hunk" key={`${hunk.leftStart}:${hunk.rightStart}`}>
                                    {foldedBefore(selectedFile.hunks, hunkIndex) === 0 ? null : (
                                        <tr className="asset-diff-fold">
                                            <td colSpan={2}>
                                                {text("library.compare.folded", {
                                                    count: foldedBefore(selectedFile.hunks, hunkIndex),
                                                })}
                                            </td>
                                        </tr>
                                    )}
                                    <tr className="asset-diff-hunk-header">
                                        <td colSpan={2}>
                                            @@ -{hunk.leftStart},{hunk.leftLineCount} +{hunk.rightStart},{hunk.rightLineCount} @@
                                        </td>
                                    </tr>
                                    {lines.map((line) => (
                                        <tr className="asset-diff-line" data-line-kind={line.lineKind} key={lineKey(line)}>
                                            <td>{line.lineKind === "add" ? "+" : line.lineKind === "remove" ? "-" : " "}</td>
                                            <td>
                                                <code>{line.text}</code>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            ))}
                            {!allDiffRowsVisible || foldedAfter(selectedFile) === 0 ? null : (
                                <tbody>
                                    <tr className="asset-diff-fold">
                                        <td colSpan={2}>
                                            {text("library.compare.folded", { count: foldedAfter(selectedFile) })}
                                        </td>
                                    </tr>
                                </tbody>
                            )}
                        </table>
                    ) : (
                        <table className="asset-diff-side-by-side" aria-label={text("library.compare.side_by_side")}>
                            {displayedHunks.map(({ hunk, hunkIndex, lines }) => (
                                <tbody className="asset-diff-hunk" key={`${hunk.leftStart}:${hunk.rightStart}`}>
                                    {foldedBefore(selectedFile.hunks, hunkIndex) === 0 ? null : (
                                        <tr className="asset-diff-fold">
                                            <td colSpan={2}>
                                                {text("library.compare.folded", {
                                                    count: foldedBefore(selectedFile.hunks, hunkIndex),
                                                })}
                                            </td>
                                        </tr>
                                    )}
                                    {sideBySideRows(lines).map((row) => (
                                        <tr
                                            className="asset-diff-row"
                                            data-line-kind={row.rowKind}
                                            key={`${row.left === undefined ? "missing" : lineKey(row.left)}:${
                                                row.right === undefined ? "missing" : lineKey(row.right)
                                            }`}
                                        >
                                            <td>
                                                <code>{row.left?.text ?? ""}</code>
                                            </td>
                                            <td>
                                                <code>{row.right?.text ?? ""}</code>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            ))}
                            {!allDiffRowsVisible || foldedAfter(selectedFile) === 0 ? null : (
                                <tbody>
                                    <tr className="asset-diff-fold">
                                        <td colSpan={2}>
                                            {text("library.compare.folded", { count: foldedAfter(selectedFile) })}
                                        </td>
                                    </tr>
                                </tbody>
                            )}
                        </table>
                    )}
                    {selectedFile.comparisonKind === "text" && visibleDiffRows < totalDiffRows ? (
                        <button
                            data-oaam-interaction-entry="features.project-library.asset_diff_view.002"
                            type="button"
                            className="library-secondary-button asset-diff-more"
                            onClick={() => setVisibleDiffRows((count) => count + DIFF_ROW_STEP)}
                        >
                            {text("library.compare.show_more_lines", {
                                shown: Math.min(visibleDiffRows, totalDiffRows),
                                total: totalDiffRows,
                            })}
                        </button>
                    ) : null}
                </section>
            )}
        </div>
    );
}
