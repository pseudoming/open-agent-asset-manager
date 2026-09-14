import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
    build: {
        target: "node22",
        outDir: path.resolve(__dirname, "dist/preload"),
        emptyOutDir: false,
        minify: false,
        sourcemap: true,
        lib: {
            entry: path.resolve(__dirname, "src/preload/index.ts"),
            formats: ["cjs"],
            fileName: () => "index.js",
        },
        rollupOptions: {
            external: ["electron"],
            output: {
                exports: "named",
            },
        },
    },
});
