import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["tests/**/*.{spec,test}.ts"],
        coverage: {
            all: true,
            provider: "istanbul",
            reporter: ["text", "text-summary", "lcov", "json-summary"],
            include: ["src/**/*.{cts,mts,ts,tsx}"],
            exclude: ["src/index.ts", "src/**/*.d.{cts,mts,ts}"],
            thresholds: {
                lines: 100,
                functions: 100,
                branches: 100,
                statements: 100,
            },
        },
    },
});
