import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const presentation = fs.readFileSync(path.resolve(__dirname, "../src/renderer/ui/tokens.css"), "utf8");
const primitives = fs.readFileSync(path.resolve(__dirname, "../src/renderer/ui/primitives.css"), "utf8");
const styles = fs.readFileSync(path.resolve(__dirname, "../src/renderer/styles.css"), "utf8");
const projectLibrary = fs.readFileSync(path.resolve(__dirname, "../src/renderer/project-library.css"), "utf8");

describe("Desktop presentation contract", () => {
    it("uses the reviewed compact tool-shell dimensions and local system font stacks", () => {
        expect(presentation).toContain("--toolbar-height: 2.875rem");
        expect(presentation).toContain("--font-size-ui: 14px");
        expect(presentation).toContain(':root[data-oaam-text-size="large"]');
        expect(presentation).toContain("--font-size-ui: 16px");
        expect(primitives).toContain("font-family: var(--font-ui)");
        expect(primitives).toContain("font-size: var(--font-size-ui)");
        expect(presentation).toContain('ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas');
        expect(styles).toContain("grid-template-columns: var(--oaam-left-pane-width, 288px) 1px minmax(0, 1fr)");
        expect(projectLibrary).toContain("grid-template-columns: var(--oaam-left-pane-width, 288px) 1px minmax(0, 1fr)");
        expect(`${presentation}\n${styles}\n${projectLibrary}`).not.toContain("--sidebar-width");
        expect(`${presentation}\n${styles}`).not.toMatch(/\b(?:Inter|OpenAI Sans)\b/u);
    });

    it("supports system light and dark colors without losing accessibility fallbacks", () => {
        expect(presentation).toContain("color-scheme: light");
        expect(presentation).toContain("--color-canvas: #f6f4f1");
        expect(presentation).toContain(':root[data-oaam-theme="dark"]');
        expect(presentation).toContain("@media (prefers-color-scheme: dark)");
        expect(presentation).toContain("--color-canvas: #1c1b19");
        expect(presentation).toContain("--color-accent: #3b82c4");
        expect(styles).toContain("@media (prefers-contrast: more)");
        expect(primitives).toContain("@media (prefers-reduced-motion: reduce)");
        expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
        expect(styles).toContain(".journey-stage:not([hidden])");
        expect(styles).toContain("animation: none");
        expect(primitives).toContain(":focus-visible");
    });

    it("reuses the guided-journey accent language for the Project and Global scope switch", () => {
        const selectedSubject = projectLibrary.match(
            /\.subject-switch button\[aria-selected="true"\] \{(?<declarations>[^}]*)\}/u,
        )?.groups?.declarations;

        expect(selectedSubject).toContain("background: var(--color-accent-soft)");
        expect(selectedSubject).toContain("color: var(--color-accent-strong)");
        expect(projectLibrary).toContain("padding: 0.1875rem");
        expect(projectLibrary).toContain("background: transparent");
    });
});
