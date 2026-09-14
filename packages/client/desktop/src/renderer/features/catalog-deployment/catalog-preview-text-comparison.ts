export interface PreviewDiffLine {
    readonly kind: "context" | "remove" | "add";
    readonly currentLine?: number;
    readonly desiredLine?: number;
    readonly text: string;
}

interface TextEdit {
    readonly kind: PreviewDiffLine["kind"];
    readonly text: string;
}

function reconstruct(
    before: readonly string[],
    after: readonly string[],
    trace: readonly ReadonlyMap<number, number>[],
): readonly TextEdit[] {
    const edits: TextEdit[] = [];
    let x = before.length;
    let y = after.length;
    for (let distance = trace.length - 1; distance >= 0; distance -= 1) {
        const frontier = trace[distance] as ReadonlyMap<number, number>;
        const diagonal = x - y;
        const previousDiagonal =
            diagonal === -distance ||
            (diagonal !== distance && (frontier.get(diagonal - 1) ?? -1) < (frontier.get(diagonal + 1) ?? -1))
                ? diagonal + 1
                : diagonal - 1;
        const previousX = frontier.get(previousDiagonal) ?? 0;
        const previousY = previousX - previousDiagonal;
        while (x > previousX && y > previousY) {
            edits.push({ kind: "context", text: before[x - 1] as string });
            x -= 1;
            y -= 1;
        }
        if (distance === 0) break;
        if (x === previousX) {
            edits.push({ kind: "add", text: after[y - 1] as string });
            y -= 1;
        } else {
            edits.push({ kind: "remove", text: before[x - 1] as string });
            x -= 1;
        }
    }
    return edits.reverse();
}

function boundedEdits(before: readonly string[], after: readonly string[]): readonly TextEdit[] | undefined {
    const frontier = new Map<number, number>([[1, 0]]);
    const trace: ReadonlyMap<number, number>[] = [];
    let remainingComparisons = 1_000_000;
    // Keep UI work bounded even when two large files have nothing in common.
    for (let distance = 0; distance <= Math.min(before.length + after.length, 128); distance += 1) {
        trace.push(new Map(frontier));
        for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
            let x =
                diagonal === -distance ||
                (diagonal !== distance && (frontier.get(diagonal - 1) ?? -1) < (frontier.get(diagonal + 1) ?? -1))
                    ? (frontier.get(diagonal + 1) ?? 0)
                    : (frontier.get(diagonal - 1) ?? 0) + 1;
            let y = x - diagonal;
            while (x < before.length && y < after.length) {
                remainingComparisons -= 1;
                if (remainingComparisons < 0) return undefined;
                if (before[x] !== after[y]) break;
                x += 1;
                y += 1;
            }
            frontier.set(diagonal, x);
            if (x >= before.length && y >= after.length) return reconstruct(before, after, trace);
        }
    }
    return undefined;
}

export function comparePreviewText(
    current: string,
    desired: string,
): {
    readonly lines: readonly PreviewDiffLine[];
    readonly bounded: boolean;
} {
    const before = current === "" ? [] : current.split(/(?<=\n)/u);
    const after = desired === "" ? [] : desired.split(/(?<=\n)/u);
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
    let suffix = 0;
    while (
        suffix < before.length - prefix &&
        suffix < after.length - prefix &&
        before[before.length - suffix - 1] === after[after.length - suffix - 1]
    )
        suffix += 1;
    const beforeMiddle = before.slice(prefix, before.length - suffix);
    const afterMiddle = after.slice(prefix, after.length - suffix);
    const comparison =
        beforeMiddle.length === 0
            ? afterMiddle.map((text) => ({ kind: "add" as const, text }))
            : afterMiddle.length === 0
              ? beforeMiddle.map((text) => ({ kind: "remove" as const, text }))
              : boundedEdits(beforeMiddle, afterMiddle);
    const edits: readonly TextEdit[] = [
        ...before.slice(0, prefix).map((text) => ({ kind: "context" as const, text })),
        ...(comparison ?? [
            ...beforeMiddle.map((text) => ({ kind: "remove" as const, text })),
            ...afterMiddle.map((text) => ({ kind: "add" as const, text })),
        ]),
        ...before.slice(before.length - suffix).map((text) => ({ kind: "context" as const, text })),
    ];
    let currentLine = 0;
    let desiredLine = 0;
    return {
        bounded: comparison === undefined,
        lines: edits.map((edit) => ({
            ...edit,
            ...(edit.kind === "add" ? {} : { currentLine: ++currentLine }),
            ...(edit.kind === "remove" ? {} : { desiredLine: ++desiredLine }),
        })),
    };
}
