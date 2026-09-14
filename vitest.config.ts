import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["tests/**/*.{spec,test}.ts"],
        exclude: ["packages/**/tests/**", "node_modules/**"],
    },
});
