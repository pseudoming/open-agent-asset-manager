import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        setupFiles: ["./tests/setup-native-helper.ts"],
        include: ["tests/**/*.{spec,test}.ts"],
        exclude: ["node_modules/**"],
        coverage: {
            all: true,
            provider: "istanbul",
            reporter: ["text", "text-summary", "lcov", "json-summary"],
            include: ["src/**/*.{cts,mts,ts,tsx}"],
            exclude: [
                "src/paths/unix-like/filesystem-target-entry.ts",
                "src/paths/win32/filesystem-target-entry.ts",
                "src/**/*.d.{cts,mts,ts}",
            ],
            thresholds: {
                lines: 70,
                functions: 70,
                branches: 70,
                statements: 70,
            },
        },
    },
});
