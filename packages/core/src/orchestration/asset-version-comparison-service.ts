import type {
    AssetVersionComparisonObserver,
    AssetVersionComparisonV1,
    AssetVersionDiffHunkV1,
    AssetVersionDiffLineV1,
    AssetVersionFileChangeV1,
    AssetVersionFileSideV1,
    AssetVersionFileV2,
    CompareAssetVersionsInputV1,
    CoreResult,
    OperationDiagnostic,
    PosixRelativePath,
    SelectedAssetVersionFileComparisonV1,
} from "../types";
import { readAssetVersionManifest, resolveAssetVersionRoot } from "../catalog/asset-library-authority";
import { bytesForPayload, readPayload } from "../catalog/payload-store";
import { completeResult } from "../foundation/core-result";
import { compareUtf8Bytes } from "../foundation/text-order";
import { stableStringify } from "../foundation/fingerprint";
import { isPosixRelativePath, isSha256Digest, isUuidV4 } from "../foundation/validators";

const MAXIMUM_TEXT_DIFF_BYTES = 32 * 1024 * 1024;
const MAXIMUM_TEXT_DIFF_LINES = 100_000;
const MAXIMUM_MYERS_EDIT_DISTANCE = 2_000;
const DIFF_CONTEXT_LINES = 10;

interface EditLine {
    kind: "equal" | "remove" | "add";
    text: string;
}

class ComparisonCancelledError extends Error {
    public constructor() {
        super("Asset Version comparison was cancelled");
        this.name = "ComparisonCancelledError";
    }
}

export async function compareAssetVersions(
    assetsRoot: string,
    input: CompareAssetVersionsInputV1,
    observer?: AssetVersionComparisonObserver,
): Promise<CoreResult<AssetVersionComparisonV1>> {
    try {
        requireInput(input);
        throwIfCancelled(observer);
        const left = readAssetVersionManifest(assetsRoot, input.assetId, input.left.versionId);
        const right = readAssetVersionManifest(assetsRoot, input.assetId, input.right.versionId);
        if (left === null || right === null) throw new Error("selected Version is not a member of the Asset");
        if (left.fingerprint !== input.left.versionFingerprint || right.fingerprint !== input.right.versionFingerprint) {
            throw new Error("selected Version fingerprint changed before comparison");
        }

        const files = compareFileGraph(left.files, right.files);
        observer?.report({ stage: "inventory", completedUnits: 1, totalUnits: 1 });
        throwIfCancelled(observer);
        const selectedFile =
            input.logicalPath === undefined
                ? ({ comparisonKind: "not_requested" } as const)
                : await compareSelectedFile(
                      assetsRoot,
                      input.assetId,
                      input.logicalPath,
                      left.versionId,
                      right.versionId,
                      files,
                      observer,
                  );
        return completeResult({
            schemaVersion: 1,
            assetId: input.assetId,
            left: { versionId: left.versionId, versionFingerprint: left.fingerprint },
            right: { versionId: right.versionId, versionFingerprint: right.fingerprint },
            files,
            selectedFile,
        });
    } catch (error) {
        return failedComparison(error);
    }
}

function requireInput(input: CompareAssetVersionsInputV1): void {
    if (!isUuidV4(input.assetId) || !isUuidV4(input.left.versionId) || !isUuidV4(input.right.versionId)) {
        throw new Error("Asset and Version identities must be UUID v4");
    }
    if (
        !isSha256Digest(input.left.versionFingerprint) ||
        !isSha256Digest(input.right.versionFingerprint) ||
        (input.logicalPath !== undefined && !isPosixRelativePath(input.logicalPath))
    ) {
        throw new Error("comparison fingerprints and optional logicalPath must use canonical forms");
    }
}

function compareFileGraph(leftFiles: AssetVersionFileV2[], rightFiles: AssetVersionFileV2[]): AssetVersionFileChangeV1[] {
    const leftByPath = new Map(leftFiles.map((file) => [file.logicalPath, file] as const));
    const rightByPath = new Map(rightFiles.map((file) => [file.logicalPath, file] as const));
    return [...new Set([...leftByPath.keys(), ...rightByPath.keys()])].sort(compareUtf8Bytes).map((logicalPath) => {
        const left = side(leftByPath.get(logicalPath));
        const right = side(rightByPath.get(logicalPath));
        return {
            logicalPath,
            changeKind:
                left.state === "missing"
                    ? "added"
                    : right.state === "missing"
                      ? "removed"
                      : sameFileSemantics(left.file, right.file)
                        ? "unchanged"
                        : "modified",
            left,
            right,
        };
    });
}

function side(file: AssetVersionFileV2 | undefined): AssetVersionFileSideV1 {
    return file === undefined ? { state: "missing" } : { state: "present", file };
}

function sameFileSemantics(left: AssetVersionFileV2, right: AssetVersionFileV2): boolean {
    return (
        stableStringify({
            logicalPath: left.logicalPath,
            role: left.role,
            contentHash: left.contentHash,
            contentKind: left.contentKind,
            mediaType: left.mediaType,
            byteSize: left.byteSize,
            executable: left.executable,
            references: left.references,
        }) ===
        stableStringify({
            logicalPath: right.logicalPath,
            role: right.role,
            contentHash: right.contentHash,
            contentKind: right.contentKind,
            mediaType: right.mediaType,
            byteSize: right.byteSize,
            executable: right.executable,
            references: right.references,
        })
    );
}

async function compareSelectedFile(
    assetsRoot: string,
    assetId: CompareAssetVersionsInputV1["assetId"],
    logicalPath: PosixRelativePath,
    leftVersionId: CompareAssetVersionsInputV1["left"]["versionId"],
    rightVersionId: CompareAssetVersionsInputV1["right"]["versionId"],
    files: AssetVersionFileChangeV1[],
    observer?: AssetVersionComparisonObserver,
): Promise<SelectedAssetVersionFileComparisonV1> {
    const selected = files.find((file) => file.logicalPath === logicalPath);
    if (selected === undefined) throw new Error("selected logicalPath is absent from both Versions");
    if (
        (selected.left.state === "present" && selected.left.file.contentKind === "binary") ||
        (selected.right.state === "present" && selected.right.file.contentKind === "binary")
    ) {
        return { comparisonKind: "metadata", logicalPath, left: selected.left, right: selected.right };
    }

    const leftText =
        selected.left.state === "missing" ? "" : readText(assetsRoot, assetId, leftVersionId, selected.left.file, "left");
    observer?.report({ stage: "loading", completedUnits: 1, totalUnits: 2 });
    await yieldToHost();
    throwIfCancelled(observer);
    const rightText =
        selected.right.state === "missing" ? "" : readText(assetsRoot, assetId, rightVersionId, selected.right.file, "right");
    observer?.report({ stage: "loading", completedUnits: 2, totalUnits: 2 });
    await yieldToHost();
    throwIfCancelled(observer);

    const leftLines = splitLines(leftText);
    const rightLines = splitLines(rightText);
    if (leftLines.length > MAXIMUM_TEXT_DIFF_LINES || rightLines.length > MAXIMUM_TEXT_DIFF_LINES) {
        throw new Error(`complete text comparison supports at most ${MAXIMUM_TEXT_DIFF_LINES} lines per side`);
    }
    const diff = await buildCompleteDiff(leftLines, rightLines, observer);
    return {
        comparisonKind: "text",
        logicalPath,
        left: selected.left,
        right: selected.right,
        algorithm: diff.algorithm,
        leftLineCount: leftLines.length,
        rightLineCount: rightLines.length,
        hunks: buildHunks(diff.edits),
    };
}

function readText(
    assetsRoot: string,
    assetId: CompareAssetVersionsInputV1["assetId"],
    versionId: CompareAssetVersionsInputV1["left"]["versionId"],
    file: AssetVersionFileV2,
    label: string,
): string {
    if (file.byteSize > MAXIMUM_TEXT_DIFF_BYTES) {
        throw new Error(`${label} text exceeds the ${MAXIMUM_TEXT_DIFF_BYTES}-byte complete-comparison bound`);
    }
    const bytes = readPayload(resolveAssetVersionRoot(assetsRoot, assetId, versionId), file.contentHash, file.byteSize).bytes;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!Buffer.from(bytesForPayload(text, "text")).equals(Buffer.from(bytes))) {
        throw new Error(`${label} text payload is not normalized`);
    }
    return text;
}

function splitLines(text: string): string[] {
    return text.length === 0 ? [] : text.split("\n");
}

async function buildCompleteDiff(
    left: string[],
    right: string[],
    observer?: AssetVersionComparisonObserver,
): Promise<{ algorithm: "myers" | "coarse_complete"; edits: EditLine[] }> {
    const maximumDistance = Math.min(left.length + right.length, MAXIMUM_MYERS_EDIT_DISTANCE);
    let frontier = new Map<number, number>([[1, 0]]);
    const trace: Map<number, number>[] = [];
    observer?.report({ stage: "diffing", completedUnits: 0, totalUnits: maximumDistance + 1 });
    for (let distance = 0; distance <= maximumDistance; distance += 1) {
        if (distance % 32 === 0) {
            await yieldToHost();
            throwIfCancelled(observer);
            observer?.report({
                stage: "diffing",
                completedUnits: Math.min(distance, maximumDistance),
                totalUnits: maximumDistance + 1,
            });
        }
        trace.push(new Map(frontier));
        const next = new Map<number, number>();
        for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
            const fromDown = frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
            const fromRight = frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
            let x =
                diagonal === -distance || (diagonal !== distance && fromRight < fromDown)
                    ? Math.max(0, fromDown)
                    : Math.max(0, fromRight + 1);
            let y = x - diagonal;
            while (x < left.length && y < right.length && left[x] === right[y]) {
                x += 1;
                y += 1;
            }
            next.set(diagonal, x);
            if (x >= left.length && y >= right.length) {
                observer?.report({
                    stage: "diffing",
                    completedUnits: maximumDistance + 1,
                    totalUnits: maximumDistance + 1,
                });
                return { algorithm: "myers", edits: backtrackMyers(trace, left, right, distance) };
            }
        }
        frontier = next;
    }
    throwIfCancelled(observer);
    observer?.report({
        stage: "diffing",
        completedUnits: maximumDistance + 1,
        totalUnits: maximumDistance + 1,
    });
    return { algorithm: "coarse_complete", edits: coarseCompleteDiff(left, right) };
}

function backtrackMyers(trace: Map<number, number>[], left: string[], right: string[], distance: number): EditLine[] {
    let x = left.length;
    let y = right.length;
    const reversed: EditLine[] = [];
    for (let step = distance; step >= 0; step -= 1) {
        const frontier = trace[step] as Map<number, number>;
        const diagonal = x - y;
        const fromDown = frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
        const fromRight = frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
        const previousDiagonal = diagonal === -step || (diagonal !== step && fromRight < fromDown) ? diagonal + 1 : diagonal - 1;
        // Myers' preceding frontier always contains the chosen diagonal.
        const previousX = Math.max(0, frontier.get(previousDiagonal) as number);
        const previousY = previousX - previousDiagonal;
        while (x > previousX && y > previousY) {
            reversed.push({ kind: "equal", text: left[x - 1] as string });
            x -= 1;
            y -= 1;
        }
        if (step === 0) break;
        if (x === previousX) {
            reversed.push({ kind: "add", text: right[y - 1] as string });
            y -= 1;
        } else {
            reversed.push({ kind: "remove", text: left[x - 1] as string });
            x -= 1;
        }
    }
    return reversed.reverse();
}

function coarseCompleteDiff(left: string[], right: string[]): EditLine[] {
    let prefix = 0;
    while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
    let suffix = 0;
    while (
        suffix < left.length - prefix &&
        suffix < right.length - prefix &&
        left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
    ) {
        suffix += 1;
    }
    return [
        ...left.slice(0, prefix).map((text) => ({ kind: "equal" as const, text })),
        ...left.slice(prefix, left.length - suffix).map((text) => ({ kind: "remove" as const, text })),
        ...right.slice(prefix, right.length - suffix).map((text) => ({ kind: "add" as const, text })),
        ...left.slice(left.length - suffix).map((text) => ({ kind: "equal" as const, text })),
    ];
}

function buildHunks(edits: EditLine[]): AssetVersionDiffHunkV1[] {
    const changed = edits.flatMap((edit, index) => (edit.kind === "equal" ? [] : [index]));
    if (changed.length === 0) return [];
    const ranges: Array<{ start: number; end: number }> = [];
    for (const index of changed) {
        const start = Math.max(0, index - DIFF_CONTEXT_LINES);
        const end = Math.min(edits.length, index + DIFF_CONTEXT_LINES + 1);
        const previous = ranges.at(-1);
        if (previous !== undefined && start <= previous.end) previous.end = Math.max(previous.end, end);
        else ranges.push({ start, end });
    }
    const leftLineAt = new Array<number>(edits.length + 1);
    const rightLineAt = new Array<number>(edits.length + 1);
    let leftLine = 1;
    let rightLine = 1;
    for (const [index, edit] of edits.entries()) {
        leftLineAt[index] = leftLine;
        rightLineAt[index] = rightLine;
        if (edit.kind !== "add") leftLine += 1;
        if (edit.kind !== "remove") rightLine += 1;
    }
    leftLineAt[edits.length] = leftLine;
    rightLineAt[edits.length] = rightLine;
    return ranges.map((range) =>
        projectHunk(edits, range.start, range.end, leftLineAt[range.start] as number, rightLineAt[range.start] as number),
    );
}

function projectHunk(
    edits: EditLine[],
    start: number,
    end: number,
    initialLeftLine: number,
    initialRightLine: number,
): AssetVersionDiffHunkV1 {
    let leftLine = initialLeftLine;
    let rightLine = initialRightLine;
    const leftStart = leftLine;
    const rightStart = rightLine;
    const lines: AssetVersionDiffLineV1[] = [];
    let leftLineCount = 0;
    let rightLineCount = 0;
    for (const edit of edits.slice(start, end)) {
        if (edit.kind === "equal") {
            lines.push({ lineKind: "context", text: edit.text, leftLine, rightLine });
            leftLine += 1;
            rightLine += 1;
            leftLineCount += 1;
            rightLineCount += 1;
        } else if (edit.kind === "remove") {
            lines.push({ lineKind: "remove", text: edit.text, leftLine });
            leftLine += 1;
            leftLineCount += 1;
        } else {
            lines.push({ lineKind: "add", text: edit.text, rightLine });
            rightLine += 1;
            rightLineCount += 1;
        }
    }
    return { leftStart, leftLineCount, rightStart, rightLineCount, lines };
}

function throwIfCancelled(observer: AssetVersionComparisonObserver | undefined): void {
    if (observer?.isCancellationRequested() === true) throw new ComparisonCancelledError();
}

async function yieldToHost(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
}

function failedComparison(error: unknown): CoreResult<AssetVersionComparisonV1> {
    const cancelled = error instanceof ComparisonCancelledError;
    const message = error instanceof Error ? error.message : String(error);
    const diagnostic: OperationDiagnostic = {
        severity: "error",
        code: cancelled ? "asset_compare.cancelled" : "asset_compare.failed",
        message,
        path: "",
        traceId: "",
        operation: "version",
        causeKind: cancelled ? "conflict" : "verification_failed",
        retryable: !cancelled,
        suggestedActions: cancelled ? [] : ["retry"],
        rawSummary: message,
    };
    return { status: "failed", value: undefined as unknown as AssetVersionComparisonV1, diagnostics: [diagnostic] };
}
