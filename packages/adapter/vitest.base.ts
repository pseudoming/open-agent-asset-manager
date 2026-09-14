import { defineConfig } from "vitest/config";

/** Shared executable gate for every built-in runtime-adapter workspace. */
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
                lines: 95,
                functions: 95,
                branches: 90,
                statements: 95,
            },
        },
    },
});
