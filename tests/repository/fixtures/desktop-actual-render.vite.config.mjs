import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "../../../packages/client/desktop/node_modules/@vitejs/plugin-react/dist/index.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const fixtureRoot = path.join(repositoryRoot, "tests", "repository", "fixtures", "desktop-actual-render");
const outputRoot = process.env.OAAM_ACTUAL_RENDER_OUTPUT;
if (outputRoot === undefined || outputRoot === "") throw new Error("OAAM_ACTUAL_RENDER_OUTPUT is required");

export default defineConfig({
    root: fixtureRoot,
    base: "./",
    plugins: [react()],
    build: {
        outDir: outputRoot,
        emptyOutDir: true,
        sourcemap: false,
    },
});
