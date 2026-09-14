import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
    root: path.resolve(__dirname, "src/renderer"),
    base: "./",
    plugins: [react()],
    build: {
        outDir: path.resolve(__dirname, "dist/webview"),
        emptyOutDir: true,
        sourcemap: false,
        chunkSizeWarningLimit: 500,
        rollupOptions: {
            output: {
                codeSplitting: {
                    includeDependenciesRecursively: false,
                    groups: [
                        {
                            name: "ui-icons",
                            test: /node_modules[\\/]lucide-react[\\/]/u,
                            priority: 30,
                        },
                        {
                            name(moduleId) {
                                return (
                                    /[\\/]renderer[\\/]client[\\/](packaged-[^\\/]+-proof)\.ts$/u.exec(moduleId)?.[1] ??
                                    "installed-proof"
                                );
                            },
                            test: /[\\/]renderer[\\/]client[\\/]packaged-[^\\/]+-proof\.ts$/u,
                            priority: 20,
                        },
                        {
                            name: "locale-zh-cn",
                            test: /[\\/]presentation[\\/]catalog-zh-cn\.ts$/u,
                            priority: 10,
                        },
                        {
                            name: "locale-de",
                            test: /[\\/]presentation[\\/]catalog-de\.ts$/u,
                            priority: 10,
                        },
                        {
                            name: "locale-ja",
                            test: /[\\/]presentation[\\/]catalog-ja\.ts$/u,
                            priority: 10,
                        },
                    ],
                },
            },
        },
    },
});
