import { createElement, Fragment, type ReactNode } from "react";

export type ImportPreviewTextFormat = "json" | "markdown" | "plain";
export type ImportPreviewTextMode = "source" | "alternate";

export interface ImportPreviewTextProps {
    readonly format: ImportPreviewTextFormat;
    readonly mode: ImportPreviewTextMode;
    readonly text: string;
    readonly sourceLabel: string;
    readonly renderedLabel: string;
    readonly softWrap?: boolean;
}

export function importPreviewTextFormat(logicalPath: string | undefined, mediaType: string): ImportPreviewTextFormat {
    const normalizedPath = logicalPath?.toLocaleLowerCase("en-US") ?? "";
    const normalizedMediaType = mediaType.toLocaleLowerCase("en-US");
    if (normalizedPath.endsWith(".json") || normalizedMediaType.includes("json")) return "json";
    if (normalizedPath.endsWith(".md") || normalizedPath.endsWith(".mdc") || normalizedMediaType.includes("markdown")) {
        return "markdown";
    }
    return "plain";
}

export function formatJsonPreview(text: string): string | undefined {
    try {
        return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
        return undefined;
    }
}

function jsonTokenClass(line: string, token: string, tokenEnd: number): string {
    if (token.startsWith('"')) {
        return line.slice(tokenEnd).trimStart().startsWith(":") ? "import-preview-token-property" : "import-preview-token-string";
    }
    if (/^(?:true|false|null)$/u.test(token)) return "import-preview-token-literal";
    if (/^-?\d/u.test(token)) return "import-preview-token-number";
    return "import-preview-token-punctuation";
}

function highlightedJson(line: string): readonly ReactNode[] {
    const pattern = /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b|(?:\[|\]|[{},:])/gu;
    const nodes: ReactNode[] = [];
    let cursor = 0;
    for (const match of line.matchAll(pattern)) {
        const index = match.index;
        const token = match[0];
        if (index > cursor) nodes.push(line.slice(cursor, index));
        nodes.push(
            <span className={jsonTokenClass(line, token, index + token.length)} key={`${String(index)}:${token}`}>
                {token}
            </span>,
        );
        cursor = index + token.length;
    }
    if (cursor < line.length) nodes.push(line.slice(cursor));
    return nodes;
}

function highlightedMarkdown(line: string): readonly ReactNode[] {
    const block = /^(\s*)(#{1,6}\s+|(?:[-*+]\s+)|(?:\d+\.\s+)|(?:>\s*)|(?:```.*))(?<rest>.*)$/u.exec(line);
    if (block !== null) {
        return [
            block[1],
            <span className="import-preview-token-markup" key="prefix">
                {block[2]}
            </span>,
            <span key="body">{block.groups?.rest}</span>,
        ];
    }
    const pattern = /`[^`]*`|\*\*[^*]+\*\*|__[^_]+__|\[[^\]]+\]\([^)]+\)/gu;
    const nodes: ReactNode[] = [];
    let cursor = 0;
    for (const match of line.matchAll(pattern)) {
        const index = match.index;
        if (index > cursor) nodes.push(line.slice(cursor, index));
        nodes.push(
            <span className="import-preview-token-markup" key={`${String(index)}:${match[0]}`}>
                {match[0]}
            </span>,
        );
        cursor = index + match[0].length;
    }
    if (cursor < line.length) nodes.push(line.slice(cursor));
    return nodes;
}

function SourcePreview({
    format,
    label,
    softWrap,
    text,
}: {
    format: ImportPreviewTextFormat;
    label: string;
    softWrap: boolean;
    text: string;
}): React.JSX.Element {
    const lines = text.split(/\r?\n/u);
    return (
        <section
            className="import-preview-source"
            aria-label={label}
            data-oaam-preview-language={format}
            data-soft-wrap={softWrap}
        >
            {lines.map((line, index) => (
                <div className="import-preview-source-line" key={`${String(index)}:${line}`}>
                    <span className="import-preview-line-number" aria-hidden="true">
                        {index + 1}
                    </span>
                    <code>
                        {format === "json" ? highlightedJson(line) : format === "markdown" ? highlightedMarkdown(line) : line}
                    </code>
                </div>
            ))}
        </section>
    );
}

function inlineMarkdown(text: string): readonly ReactNode[] {
    const pattern = /`([^`]*)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*/gu;
    const nodes: ReactNode[] = [];
    let cursor = 0;
    for (const match of text.matchAll(pattern)) {
        const index = match.index;
        if (index > cursor) nodes.push(text.slice(cursor, index));
        const key = `${String(index)}:${match[0]}`;
        if (match[1] !== undefined) nodes.push(<code key={key}>{match[1]}</code>);
        else if (match[2] !== undefined || match[3] !== undefined) nodes.push(<strong key={key}>{match[2] ?? match[3]}</strong>);
        else nodes.push(<em key={key}>{match[4]}</em>);
        cursor = index + match[0].length;
    }
    if (cursor < text.length) nodes.push(text.slice(cursor));
    return nodes;
}

function isMarkdownBlockStart(line: string): boolean {
    return /^(?:\s*$|#{1,6}\s+|```|\s*[-*+]\s+|\s*\d+\.\s+|\s*>)/u.test(line);
}

function renderedMarkdown(text: string): readonly ReactNode[] {
    const lines = text.split(/\r?\n/u);
    const blocks: ReactNode[] = [];
    let index = 0;
    while (index < lines.length) {
        const line = lines[index] ?? "";
        if (line.trim().length === 0) {
            index += 1;
            continue;
        }
        const fence = /^```(?<language>.*)$/u.exec(line);
        if (fence !== null) {
            const content: string[] = [];
            const start = index;
            index += 1;
            while (index < lines.length && !/^```\s*$/u.test(lines[index] ?? "")) {
                content.push(lines[index] ?? "");
                index += 1;
            }
            if (index < lines.length) index += 1;
            blocks.push(
                <pre data-language={fence.groups?.language.trim() || undefined} key={`code:${String(start)}`}>
                    <code>{content.join("\n")}</code>
                </pre>,
            );
            continue;
        }
        const heading = /^(#{1,6})\s+(.*)$/u.exec(line);
        if (heading !== null) {
            const level = heading[1]?.length ?? 1;
            blocks.push(
                createElement(`h${String(level)}`, { key: `heading:${String(index)}` }, inlineMarkdown(heading[2] ?? "")),
            );
            index += 1;
            continue;
        }
        const unordered = /^\s*[-*+]\s+(.*)$/u.exec(line);
        if (unordered !== null) {
            const items: ReactNode[] = [];
            const start = index;
            while (index < lines.length) {
                const item = /^\s*[-*+]\s+(.*)$/u.exec(lines[index] ?? "");
                if (item === null) break;
                items.push(<li key={String(index)}>{inlineMarkdown(item[1] ?? "")}</li>);
                index += 1;
            }
            blocks.push(<ul key={`list:${String(start)}`}>{items}</ul>);
            continue;
        }
        const ordered = /^\s*\d+\.\s+(.*)$/u.exec(line);
        if (ordered !== null) {
            const items: ReactNode[] = [];
            const start = index;
            while (index < lines.length) {
                const item = /^\s*\d+\.\s+(.*)$/u.exec(lines[index] ?? "");
                if (item === null) break;
                items.push(<li key={String(index)}>{inlineMarkdown(item[1] ?? "")}</li>);
                index += 1;
            }
            blocks.push(<ol key={`ordered:${String(start)}`}>{items}</ol>);
            continue;
        }
        if (/^\s*>/u.test(line)) {
            const quoted: string[] = [];
            const start = index;
            while (index < lines.length && /^\s*>/u.test(lines[index] ?? "")) {
                quoted.push((lines[index] ?? "").replace(/^\s*>\s?/u, ""));
                index += 1;
            }
            blocks.push(<blockquote key={`quote:${String(start)}`}>{inlineMarkdown(quoted.join(" "))}</blockquote>);
            continue;
        }
        const paragraph: string[] = [line];
        const start = index;
        index += 1;
        while (index < lines.length && !isMarkdownBlockStart(lines[index] ?? "")) {
            paragraph.push(lines[index] ?? "");
            index += 1;
        }
        blocks.push(<p key={`paragraph:${String(start)}`}>{inlineMarkdown(paragraph.join(" "))}</p>);
    }
    return blocks;
}

export function ImportPreviewText({
    format,
    mode,
    text,
    sourceLabel,
    renderedLabel,
    softWrap = false,
}: ImportPreviewTextProps): React.JSX.Element {
    const formattedJson = format === "json" && mode === "alternate" ? formatJsonPreview(text) : undefined;
    if (format === "markdown" && mode === "alternate") {
        return (
            <section className="import-preview-markdown" aria-label={renderedLabel} data-oaam-markdown-rendered>
                {renderedMarkdown(text).map((block, index) => (
                    <Fragment key={String(index)}>{block}</Fragment>
                ))}
            </section>
        );
    }
    return <SourcePreview format={format} label={sourceLabel} softWrap={softWrap} text={formattedJson ?? text} />;
}
