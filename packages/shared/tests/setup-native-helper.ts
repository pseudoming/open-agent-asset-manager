import { resolve } from "node:path";
import { vi } from "vitest";

// Source tests use the same built native artifact as installed consumers. Only
// its location differs; the real helper, framing and mutation code still run.
vi.mock("../src/paths/unix-like/linux-helper-path", () => ({
    resolveLinuxPhysicalHelperPath: () => resolve(__dirname, "../dist/paths/unix-like/oaam_linux_file_mutation"),
}));
