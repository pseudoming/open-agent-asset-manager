import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectDesktopUiConformance } from "./desktop-ui-conformance.mjs";

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

function fixture(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-desktop-ui-conformance-"));
    roots.push(root);
    for (const directory of [
        "packages/client/desktop/src/renderer/ui",
        "packages/client/desktop/src/renderer/features/example",
        "packages/client/desktop/src/bridge",
        "packages/client/desktop/src/main",
        "packages/client/desktop/src/preload",
    ]) {
        fs.mkdirSync(path.join(root, directory), { recursive: true });
    }
    fs.writeFileSync(
        path.join(root, "packages/client/desktop/src/renderer/ui/icons.tsx"),
        'import { Search } from "lucide-react"; export const icon = <Search />;\n',
    );
    fs.writeFileSync(
        path.join(root, "packages/client/desktop/src/renderer/ui/WorkbenchPrimitives.tsx"),
        'export const Select = () => <div role="listbox" />;\n',
    );
    fs.writeFileSync(path.join(root, "packages/client/desktop/src/main/index.ts"), "export const main = true;\n");
    return root;
}

describe("Desktop UI conformance gate", () => {
    it("accepts the live reviewed registry and renderer-owned About boundary", () => {
        expect(inspectDesktopUiConformance(process.cwd())).toMatchObject({
            diagnosticProjection: "packages/client/desktop/src/renderer/presentation/protocol-diagnostics.ts",
            iconRegistry: "packages/client/desktop/src/renderer/ui/icons.tsx",
        });
    });

    it("rejects direct icon imports, raw action SVGs, and a native About route", () => {
        const directImport = fixture();
        fs.writeFileSync(
            path.join(directImport, "packages/client/desktop/src/renderer/features/example/Action.tsx"),
            'import { Search } from "lucide-react"; export const Action = () => <Search />;\n',
        );
        expect(() => inspectDesktopUiConformance(directImport)).toThrow(/outside the OAAM icon registry/u);

        const rawSvg = fixture();
        fs.writeFileSync(
            path.join(rawSvg, "packages/client/desktop/src/renderer/features/example/Action.tsx"),
            "export const Action = () => <svg />;\n",
        );
        expect(() => inspectDesktopUiConformance(rawSvg)).toThrow(/raw SVG/u);

        const nativeAbout = fixture();
        fs.writeFileSync(
            path.join(nativeAbout, "packages/client/desktop/src/main/index.ts"),
            'export const action = "show_about"; dialog.showMessageBox("window.about.title");\n',
        );
        expect(() => inspectDesktopUiConformance(nativeAbout)).toThrow(/About escaped|message box/u);
    });

    it("rejects feature-local listboxes/dialogs, unregistered native controls, and unreviewed raw page colors", () => {
        const listbox = fixture();
        fs.writeFileSync(
            path.join(listbox, "packages/client/desktop/src/renderer/features/example/Action.tsx"),
            'export const Action = () => <div role="listbox" />;\n',
        );
        expect(() => inspectDesktopUiConformance(listbox)).toThrow(/feature-local listbox/u);

        const dialog = fixture();
        fs.writeFileSync(
            path.join(dialog, "packages/client/desktop/src/renderer/features/example/Action.tsx"),
            'export const Action = () => <div role="dialog" aria-modal="true" />;\n',
        );
        expect(() => inspectDesktopUiConformance(dialog)).toThrow(/feature-local dialog/u);

        const nativeControl = fixture();
        fs.writeFileSync(
            path.join(nativeControl, "packages/client/desktop/src/renderer/features/example/Action.tsx"),
            'export const Action = () => <input type="checkbox" />;\n',
        );
        expect(() => inspectDesktopUiConformance(nativeControl)).toThrow(/semantic-control primitives/u);

        const rawColor = fixture();
        fs.writeFileSync(
            path.join(rawColor, "packages/client/desktop/src/renderer/features/example/action.css"),
            ".action { color: #ff0000; }\n",
        );
        expect(() => inspectDesktopUiConformance(rawColor)).toThrow(/legacy-style baseline/u);

        const booleanStyle = fixture();
        fs.writeFileSync(
            path.join(booleanStyle, "packages/client/desktop/src/renderer/features/example/action.css"),
            '.action[aria-pressed="true"] { font-weight: 700; }\n',
        );
        expect(() => inspectDesktopUiConformance(booleanStyle)).toThrow(/boolean-state selector/u);

        const unclassifiedAction = fixture();
        fs.writeFileSync(
            path.join(unclassifiedAction, "packages/client/desktop/src/renderer/features/example/Action.tsx"),
            'export const Action = () => <button className="danger-button">Delete</button>;\n',
        );
        expect(() => inspectDesktopUiConformance(unclassifiedAction)).toThrow(/lacks journey classification/u);
    });

    it("rejects raw Protocol diagnostic message flattening outside the reviewed presentation owner", () => {
        const firstMessage = fixture();
        fs.writeFileSync(
            path.join(firstMessage, "packages/client/desktop/src/renderer/features/example/Action.tsx"),
            "export const message = result.diagnostics[0]?.message;\n",
        );
        expect(() => inspectDesktopUiConformance(firstMessage)).toThrow(/first diagnostic message/u);

        const mappedMessage = fixture();
        fs.writeFileSync(
            path.join(mappedMessage, "packages/client/desktop/src/renderer/features/example/Action.tsx"),
            "export const messages = result.diagnostics.map((diagnostic) => diagnostic.message);\n",
        );
        expect(() => inspectDesktopUiConformance(mappedMessage)).toThrow(/mapped diagnostic message|raw diagnostic message/u);
    });
});
