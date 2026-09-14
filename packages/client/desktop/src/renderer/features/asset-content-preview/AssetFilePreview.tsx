import type { ProtocolDiagnosticV1, ProtocolOperationResult } from "@oaam/app-server-protocol";
import { useState } from "react";
import { type DesktopDisplayText, ProtocolDiagnostics, useDesktopPresentation } from "../../presentation";
import { WorkbenchIconButton, WorkbenchNotice } from "../../ui";
import { formatJsonPreview, ImportPreviewText, type ImportPreviewTextMode, importPreviewTextFormat } from "../import-review";

type OutcomeValue<TName extends "asset_version.file_preview" | "asset_version.text_page"> = Extract<
    ProtocolOperationResult<TName>,
    { readonly value: unknown }
>["value"];

export type AssetVersionFilePreviewView = Extract<OutcomeValue<"asset_version.file_preview">, { readonly found: true }>["value"];
export type AssetVersionTextPageView = Extract<OutcomeValue<"asset_version.text_page">, { readonly found: true }>["value"];

export type AssetFilePreviewState =
    | { readonly status: "none" }
    | { readonly status: "loading"; readonly logicalPath: string }
    | {
          readonly status: "ready";
          readonly logicalPath: string;
          readonly preview: AssetVersionFilePreviewView;
          readonly textPages: readonly AssetVersionTextPageView[];
          readonly hasMoreText: boolean;
          readonly nextTextCursor?: string;
      }
    | {
          readonly status: "failed";
          readonly logicalPath: string;
          readonly message: DesktopDisplayText;
          readonly diagnostics: readonly ProtocolDiagnosticV1[];
      };

export interface AssetFilePreviewProps {
    readonly preview: AssetFilePreviewState;
    readonly displayPath?: string;
    readonly versionLabel?: string;
    readonly onLoadMoreText: () => void;
}

export function AssetFilePreview({
    preview,
    displayPath,
    versionLabel,
    onLoadMoreText,
}: AssetFilePreviewProps): React.JSX.Element | null {
    const { text, displayText } = useDesktopPresentation();
    const [textMode, setTextMode] = useState<ImportPreviewTextMode>("source");
    const [softWrap, setSoftWrap] = useState(false);
    if (preview.status === "none") return null;
    const previewText =
        preview.status === "ready" && preview.preview.previewKind !== "binary"
            ? preview.preview.previewKind === "text"
                ? preview.preview.text
                : preview.textPages.map((page) => page.text).join("")
            : undefined;
    const textFormat =
        preview.status === "ready" && preview.preview.previewKind !== "binary"
            ? importPreviewTextFormat(preview.logicalPath, preview.preview.file.mediaType)
            : "plain";
    const jsonCanFormat = textFormat === "json" && previewText !== undefined && formatJsonPreview(previewText) !== undefined;
    const alternateViewAvailable = textFormat === "markdown" || jsonCanFormat;
    return (
        <section className="inspector-section asset-file-preview">
            <header className="asset-file-preview-header">
                <div className="asset-file-preview-identity">
                    {versionLabel === undefined ? null : <small>{versionLabel}</small>}
                    <code title={displayPath ?? preview.logicalPath}>{displayPath ?? preview.logicalPath}</code>
                </div>
                <div className="asset-file-preview-actions">
                    {preview.status === "ready" && textFormat !== "plain" ? (
                        <WorkbenchIconButton
                            data-oaam-interaction-entry="features.asset-content-preview.asset_file_preview.001"
                            className="import-preview-view-button"
                            icon={textMode === "alternate" ? "source" : textFormat === "json" ? "format" : "render"}
                            label={text(
                                textFormat === "json"
                                    ? !jsonCanFormat
                                        ? "import.ui.inspector.json_invalid"
                                        : textMode === "source"
                                          ? "import.ui.inspector.format_json"
                                          : "import.ui.inspector.show_json_source"
                                    : textMode === "source"
                                      ? "import.ui.inspector.render_markdown"
                                      : "import.ui.inspector.show_markdown_source",
                            )}
                            aria-pressed={textMode === "alternate"}
                            disabled={!alternateViewAvailable}
                            onClick={() => setTextMode((current) => (current === "source" ? "alternate" : "source"))}
                        />
                    ) : null}
                    {preview.status === "ready" && textMode === "source" && previewText !== undefined ? (
                        <WorkbenchIconButton
                            data-oaam-interaction-entry="features.asset-content-preview.asset_file_preview.002"
                            className="import-preview-view-button"
                            icon="wrap"
                            label={text(softWrap ? "import.ui.inspector.disable_wrap" : "import.ui.inspector.enable_wrap")}
                            aria-pressed={softWrap}
                            onClick={() => setSoftWrap((current) => !current)}
                        />
                    ) : null}
                </div>
            </header>
            {preview.status === "loading" ? (
                <WorkbenchNotice role="status" aria-busy="true">
                    {text("library.preview.loading")}
                </WorkbenchNotice>
            ) : preview.status === "failed" ? (
                <>
                    <WorkbenchNotice tone="danger">{displayText(preview.message)}</WorkbenchNotice>
                    <ProtocolDiagnostics
                        diagnostics={preview.diagnostics}
                        technicalSummary={text("import.ui.technical_details")}
                    />
                </>
            ) : preview.preview.previewKind === "binary" ? (
                <WorkbenchNotice>{text("library.preview.binary")}</WorkbenchNotice>
            ) : (
                <>
                    <div className="asset-file-preview-document">
                        <ImportPreviewText
                            format={textFormat}
                            mode={textMode}
                            text={previewText ?? ""}
                            sourceLabel={text("import.ui.inspector.source_with_lines")}
                            renderedLabel={text("import.ui.inspector.rendered_markdown")}
                            softWrap={softWrap}
                        />
                    </div>
                    {preview.preview.previewKind === "large_text" && preview.textPages.length > 0 ? (
                        <p>
                            {text("library.preview.range", {
                                start: preview.textPages[0]?.loadedByteStart ?? 0,
                                end: preview.textPages.at(-1)?.loadedByteEnd ?? 0,
                                total: preview.textPages.at(-1)?.totalBytes ?? 0,
                            })}
                        </p>
                    ) : null}
                    {preview.hasMoreText ? (
                        <button
                            data-oaam-interaction-entry="features.asset-content-preview.asset_file_preview.003"
                            type="button"
                            className="library-secondary-button"
                            onClick={onLoadMoreText}
                        >
                            {text("library.preview.more")}
                        </button>
                    ) : null}
                </>
            )}
        </section>
    );
}
