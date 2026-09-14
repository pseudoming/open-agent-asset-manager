import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["tests/**/*.{spec,test}.ts"],
        coverage: {
            all: true,
            provider: "istanbul",
            reporter: ["text", "text-summary", "lcov", "json-summary"],
            include: ["src/**/*.{cts,mts,ts,tsx}"],
            // index.ts (type barrel), types.ts (pure types), type-guards.ts (compile-time
            // IsExact assertions only), and declaration files have no testable runtime.
            exclude: ["src/index.ts", "src/types.ts", "src/type-guards.ts", "src/**/*.d.{cts,mts,ts}"],
            thresholds: {
                lines: 100,
                functions: 100,
                branches: 100,
                statements: 100,
            },
        },
    },
});
