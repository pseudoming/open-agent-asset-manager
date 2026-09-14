import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
    formatJsonPreview,
    ImportPreviewText,
    importPreviewTextFormat,
} from "../src/renderer/features/import-review/ImportPreviewText";

afterEach(() => cleanup());

describe("Desktop import preview text", () => {
    it("classifies bounded JSON, Markdown, and plain-text previews from path or media type", () => {
        expect(importPreviewTextFormat("settings.JSON", "text/plain")).toBe("json");
        expect(importPreviewTextFormat("settings.txt", "application/problem+json")).toBe("json");
        expect(importPreviewTextFormat("AGENTS.md", "text/plain")).toBe("markdown");
        expect(importPreviewTextFormat("rule.mdc", "text/plain")).toBe("markdown");
        expect(importPreviewTextFormat(undefined, "text/markdown; charset=utf-8")).toBe("markdown");
        expect(importPreviewTextFormat("notes.txt", "text/plain")).toBe("plain");
        expect(formatJsonPreview('{"enabled":true}')).toBe('{\n  "enabled": true\n}');
        expect(formatJsonPreview("not-json")).toBeUndefined();
    });

    it("renders line-numbered source with format-specific tokens without interpreting source HTML", () => {
        const json = render(
            createElement(ImportPreviewText, {
                format: "json",
                mode: "source",
                text: '{"name":"OAAM","count":2,"enabled":true,"missing":null,"items":[]}',
                sourceLabel: "JSON source",
                renderedLabel: "Rendered",
            }),
        );
        expect(json.getByRole("region", { name: "JSON source" })).not.toBeNull();
        expect(json.container.querySelectorAll(".import-preview-token-property")).toHaveLength(5);
        expect(json.container.querySelector(".import-preview-token-string")?.textContent).toBe('"OAAM"');
        expect(json.container.querySelector(".import-preview-token-number")?.textContent).toBe("2");
        expect(json.container.querySelectorAll(".import-preview-token-literal")).toHaveLength(2);
        expect(json.container.querySelectorAll(".import-preview-token-punctuation").length).toBeGreaterThan(4);
        json.unmount();

        const markdown = render(
            createElement(ImportPreviewText, {
                format: "markdown",
                mode: "source",
                text: [
                    "# Heading",
                    "- item",
                    "1. item",
                    "> quote",
                    "```ts",
                    "Text with `code`, **bold**, and [label](https://example.invalid).",
                    "<script>never execute</script>",
                ].join("\n"),
                sourceLabel: "Markdown source",
                renderedLabel: "Rendered",
            }),
        );
        expect(markdown.container.querySelectorAll(".import-preview-line-number")).toHaveLength(7);
        expect(markdown.container.querySelectorAll(".import-preview-token-markup").length).toBeGreaterThan(5);
        expect(markdown.container.querySelector("script")).toBeNull();
        markdown.unmount();

        const plain = render(
            createElement(ImportPreviewText, {
                format: "plain",
                mode: "source",
                text: "first\nsecond",
                sourceLabel: "Plain source",
                renderedLabel: "Rendered",
                softWrap: true,
            }),
        );
        expect(plain.getByRole("region", { name: "Plain source" }).textContent).toContain("second");
        expect(plain.getByRole("region", { name: "Plain source" }).getAttribute("data-soft-wrap")).toBe("true");
        expect(plain.container.querySelectorAll(".import-preview-line-number")).toHaveLength(2);
    });

    it("renders safe Markdown blocks and falls back to source for malformed formatted JSON", () => {
        const markdown = render(
            createElement(ImportPreviewText, {
                format: "markdown",
                mode: "alternate",
                text: [
                    "# Heading",
                    "",
                    "Paragraph with `code`, **bold**, __strong__, and *emphasis*.",
                    "",
                    "- First",
                    "* Second",
                    "",
                    "1. One",
                    "2. Two",
                    "",
                    "> Quoted",
                    "> together",
                    "",
                    "```ts",
                    "const value = 1;",
                    "```",
                    "",
                    "<script>never execute</script>",
                ].join("\n"),
                sourceLabel: "Source",
                renderedLabel: "Rendered Markdown",
            }),
        );
        expect(markdown.getByRole("region", { name: "Rendered Markdown" })).not.toBeNull();
        expect(markdown.getByRole("heading", { name: "Heading" })).not.toBeNull();
        expect(markdown.container.querySelectorAll("ul > li")).toHaveLength(2);
        expect(markdown.container.querySelectorAll("ol > li")).toHaveLength(2);
        expect(markdown.container.querySelector("blockquote")?.textContent).toBe("Quoted together");
        expect(markdown.container.querySelector("pre")?.textContent).toBe("const value = 1;");
        expect(markdown.container.querySelectorAll("strong")).toHaveLength(2);
        expect(markdown.container.querySelector("em")?.textContent).toBe("emphasis");
        expect(markdown.container.querySelector("script")).toBeNull();
        markdown.unmount();

        const unclosedFence = render(
            createElement(ImportPreviewText, {
                format: "markdown",
                mode: "alternate",
                text: "```\nkept as code",
                sourceLabel: "Source",
                renderedLabel: "Unclosed fence",
            }),
        );
        expect(unclosedFence.container.querySelector("pre")?.textContent).toBe("kept as code");
        unclosedFence.unmount();

        const invalidJson = render(
            createElement(ImportPreviewText, {
                format: "json",
                mode: "alternate",
                text: "{invalid",
                sourceLabel: "Invalid JSON source",
                renderedLabel: "Rendered",
            }),
        );
        expect(invalidJson.getByRole("region", { name: "Invalid JSON source" }).textContent).toContain("{invalid");
    });
});
