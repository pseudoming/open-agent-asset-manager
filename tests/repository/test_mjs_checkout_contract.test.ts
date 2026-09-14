import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createServer } from "vite";
import { expect, it } from "vitest";

const repository = fileURLToPath(new URL("../../", import.meta.url));

it("keeps imported MJS tools valid when Git checkout otherwise uses CRLF", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-mjs-checkout-"));
    const source = path.join(root, "source");
    const relative = "tests/repository/workspace-graph.mjs";
    fs.mkdirSync(path.join(source, "tests/repository"), { recursive: true });
    const git = (...args: string[]) =>
        execFileSync("git", ["-c", "core.autocrlf=true", ...args], {
            cwd: source,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 10_000,
        });
    const server = await createServer({ configFile: false, root, logLevel: "silent", server: { watch: null } });
    try {
        fs.copyFileSync(path.join(repository, relative), path.join(source, relative));
        git("init", "--quiet");
        git("add", "--", relative);
        for (const preserveLf of [false, true]) {
            if (preserveLf) {
                fs.copyFileSync(path.join(repository, ".gitattributes"), path.join(source, ".gitattributes"));
                git("add", "--", ".gitattributes");
            }
            const checkout = path.join(root, preserveLf ? "lf" : "crlf");
            fs.mkdirSync(checkout);
            git("checkout-index", "--all", `--prefix=${checkout.replaceAll("\\", "/")}/`);
            const text = fs.readFileSync(path.join(checkout, relative), "utf8");
            expect(text.includes("\r\n")).toBe(!preserveLf);
            const transformed = await server.ssrTransform(text, null, "/" + relative);
            if (!transformed) throw new Error("Vite did not transform the module");
            // Vite-node strips a hashbang only when it remains the first character of the output.
            const code = transformed.code.startsWith("#")
                ? transformed.code.replace(/^#!.*/, (line) => " ".repeat(line.length))
                : transformed.code;
            const parse = () => vm.runInThisContext(`async () => {${code}\n}`);
            if (preserveLf) expect(parse).not.toThrow();
            else expect(parse).toThrow(SyntaxError);
        }
    } finally {
        await server.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
});
