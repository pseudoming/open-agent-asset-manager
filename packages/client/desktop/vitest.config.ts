import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "jsdom",
        include: ["tests/**/*.{spec,test}.ts"],
        coverage: {
            all: true,
            provider: "istanbul",
            reporter: ["text", "text-summary", "lcov", "json-summary"],
            include: ["src/**/*.{cts,mts,ts,tsx}"],
            exclude: [
                "src/index.ts",
                "src/host/index.ts",
                "src/main/index.ts",
                "src/preload/index.ts",
                "src/renderer/main.tsx",
                "src/**/*.d.{cts,mts,ts}",
            ],
            thresholds: {
                lines: 95,
                functions: 95,
                branches: 90,
                statements: 95,
            },
        },
    },
});
