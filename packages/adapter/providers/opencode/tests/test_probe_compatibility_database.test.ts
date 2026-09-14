import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SafeFilesystemError } from "@oaam/shared/filesystem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    discoverOpenCodeCompatibilityDatabase,
    runOpenCodeCompatibilityReaderBounded,
} from "../src/opencode-probe-compatibility-database";

let sandbox = "";
let databasePath = "";

beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-opencode-compatibility-probe-"));
    databasePath = path.join(sandbox, "opencode.db");
    fs.writeFileSync(databasePath, "fixture database");
});

afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
});

function input(pathValue = databasePath) {
    return {
        databasePath: pathValue,
        platformContext: {
            platform: "linux" as const,
            platformInstanceId: "fixture",
            accessRootPath: sandbox,
        },
    };
}

function envelope() {
    return Buffer.from(
        JSON.stringify({
            status: "complete",
            readerVersion: "12.11.1",
            sqliteVersion: "3.53.2",
            schemaFingerprint: "opencode-project-registry-20260423070820",
            projects: [
                {
                    id: "project-a",
                    worktree: "/work/project-a",
                    name: "Project A",
                    sandboxes: ["/work/project-a-sandbox"],
                },
            ],
            failureCode: "",
        }),
        "utf8",
    );
}

function complete(stdout = envelope()) {
    return {
        status: "complete" as const,
        stdout,
        failureCode: "",
        processId: 42,
        processExited: true,
    };
}

describe("OpenCode compatibility database coordinator", () => {
    it("returns one low-confidence partial document after an unchanged no-WAL read", async () => {
        const calls: unknown[] = [];
        const result = await discoverOpenCodeCompatibilityDatabase(input(), {
            readerModulePath: "/reader.js",
            runReader: async (...arguments_) => {
                calls.push(arguments_);
                return complete();
            },
        });
        expect(result).toMatchObject({
            status: "partial",
            projectDocument: expect.any(Uint8Array),
            diagnostics: [{ code: "opencode_compatibility_database_used" }],
        });
        expect(calls).toEqual([["/reader.js", databasePath, 1_500, 4 * 1_024 * 1_024]]);
    });

    it("treats target-built not-found sidecar failures as absence without branching on platform codes", async () => {
        const inspectFile = (filePath: string) => {
            if (filePath === databasePath) {
                return {
                    deviceId: "fixture",
                    fileId: "database",
                    entryKind: "file" as const,
                };
            }
            throw new SafeFilesystemError({
                failureKind: "not_found",
                operation: "inspect_regular_file",
                targetPath: filePath,
                systemCode: "ntstatus_c0000034/win32_2",
                message: "fixture sidecar is absent",
            });
        };
        const result = await discoverOpenCodeCompatibilityDatabase(input(), {
            inspectFile,
            runReader: async () => complete(),
        });
        expect(result).toMatchObject({
            projectDocument: expect.any(Uint8Array),
            diagnostics: [{ code: "opencode_compatibility_database_used" }],
        });
    });

    it("accepts a stable zero-byte WAL but rejects non-empty and malformed sidecar states before reading", async () => {
        fs.writeFileSync(`${databasePath}-wal`, "");
        fs.writeFileSync(`${databasePath}-shm`, "stable index");
        let calls = 0;
        const empty = await discoverOpenCodeCompatibilityDatabase(input(), {
            runReader: async () => {
                calls += 1;
                return complete();
            },
        });
        expect(empty.projectDocument).not.toBeNull();
        expect(calls).toBe(1);

        fs.writeFileSync(`${databasePath}-wal`, "non-empty");
        const nonEmpty = await discoverOpenCodeCompatibilityDatabase(input(), {
            runReader: async () => {
                calls += 1;
                return complete();
            },
        });
        expect(nonEmpty.diagnostics[0]?.code).toBe("opencode_compatibility_database_nonempty_wal");
        expect(calls).toBe(1);

        fs.rmSync(`${databasePath}-wal`);
        const orphanShm = await discoverOpenCodeCompatibilityDatabase(input(), {
            runReader: async () => {
                calls += 1;
                return complete();
            },
        });
        expect(orphanShm.diagnostics[0]?.code).toBe("opencode_compatibility_database_orphan_shm");
        expect(calls).toBe(1);

        fs.rmSync(`${databasePath}-shm`);
        fs.writeFileSync(`${databasePath}-journal`, "rollback");
        const journal = await discoverOpenCodeCompatibilityDatabase(input(), {
            runReader: async () => {
                calls += 1;
                return complete();
            },
        });
        expect(journal.diagnostics[0]?.code).toBe("opencode_compatibility_database_journal_present");
        expect(calls).toBe(1);
    });

    it("rejects oversized database and shared-memory members before invoking the reader", async () => {
        fs.truncateSync(databasePath, Number(8n * 1_024n * 1_024n * 1_024n + 1n));
        let calls = 0;
        const oversizedDatabase = await discoverOpenCodeCompatibilityDatabase(input(), {
            runReader: async () => {
                calls += 1;
                return complete();
            },
        });
        expect(oversizedDatabase.diagnostics[0]?.code).toBe("opencode_compatibility_database_size_limit");

        fs.truncateSync(databasePath, 1);
        fs.writeFileSync(`${databasePath}-wal`, "");
        fs.writeFileSync(`${databasePath}-shm`, "");
        fs.truncateSync(`${databasePath}-shm`, Number(64n * 1_024n * 1_024n + 1n));
        const oversizedShm = await discoverOpenCodeCompatibilityDatabase(input(), {
            runReader: async () => {
                calls += 1;
                return complete();
            },
        });
        expect(oversizedShm.diagnostics[0]?.code).toBe("opencode_compatibility_database_shm_size_limit");
        expect(calls).toBe(0);
    });

    it("rejects foreign, missing, symlinked, and concurrently changed registry authorities", async () => {
        const foreign = await discoverOpenCodeCompatibilityDatabase(input("/foreign/opencode.db"), {
            runReader: async () => complete(),
        });
        expect(foreign.diagnostics[0]?.code).toBe("opencode_compatibility_database_path_invalid");

        fs.rmSync(databasePath);
        const missing = await discoverOpenCodeCompatibilityDatabase(input(), {
            runReader: async () => complete(),
        });
        expect(missing.diagnostics[0]?.code).toContain("opencode_compatibility_database_before_");

        fs.writeFileSync(path.join(sandbox, "target.db"), "target");
        fs.symlinkSync(path.join(sandbox, "target.db"), databasePath);
        const symlink = await discoverOpenCodeCompatibilityDatabase(input(), {
            runReader: async () => complete(),
        });
        expect(symlink.projectDocument).toBeNull();

        fs.rmSync(databasePath);
        fs.writeFileSync(databasePath, "fixture database");
        const changed = await discoverOpenCodeCompatibilityDatabase(input(), {
            runReader: async () => {
                fs.appendFileSync(databasePath, "changed");
                return complete();
            },
        });
        expect(changed.diagnostics[0]?.code).toBe("opencode_compatibility_database_changed");
    });

    it("rejects a registry that disappears after reading or changes physical identity", async () => {
        const disappeared = await discoverOpenCodeCompatibilityDatabase(input(), {
            runReader: async () => {
                fs.rmSync(databasePath);
                return complete();
            },
        });
        expect(disappeared.diagnostics[0]?.code).toContain("opencode_compatibility_database_after_");

        fs.writeFileSync(databasePath, "fixture database");
        const identityChanged = await discoverOpenCodeCompatibilityDatabase(input(), {
            sameFile: () => false,
            runReader: async () => complete(),
        });
        expect(identityChanged.diagnostics[0]?.code).toBe("opencode_compatibility_database_changed");
    });

    it.each([
        [
            "timeout",
            {
                status: "timed_out" as const,
                stdout: new Uint8Array(),
                failureCode: "timeout",
                processId: 42,
                processExited: true,
            },
            "opencode_compatibility_database_reader_timeout",
        ],
        [
            "abnormal exit",
            {
                status: "failed" as const,
                stdout: new Uint8Array(),
                failureCode: "exit",
                processId: 42,
                processExited: true,
            },
            "opencode_compatibility_database_reader_exit",
        ],
        [
            "residual process",
            {
                status: "failed" as const,
                stdout: new Uint8Array(),
                failureCode: "exit",
                processId: 42,
                processExited: false,
            },
            "opencode_compatibility_database_reader_residual",
        ],
    ])("fails closed for a %s", async (_label, invocation, code) => {
        const result = await discoverOpenCodeCompatibilityDatabase(input(), {
            runReader: async () => invocation,
        });
        expect(result).toMatchObject({ projectDocument: null, diagnostics: [{ code }] });
    });

    it.each([
        ["malformed output", Buffer.from("{", "utf8"), "opencode_compatibility_database_reader_output_invalid"],
        [
            "wrong reader",
            Buffer.from(
                JSON.stringify({
                    status: "complete",
                    readerVersion: "0.0.0",
                    sqliteVersion: "3.53.2",
                    schemaFingerprint: "opencode-project-registry-20260423070820",
                    projects: [],
                    failureCode: "",
                }),
            ),
            "opencode_compatibility_database_reader_version_mismatch",
        ],
        [
            "unknown schema",
            Buffer.from(
                JSON.stringify({
                    status: "complete",
                    readerVersion: "12.11.1",
                    sqliteVersion: "3.53.2",
                    schemaFingerprint: "future",
                    projects: [],
                    failureCode: "",
                }),
            ),
            "opencode_compatibility_database_reader_output_invalid",
        ],
        [
            "reader failure",
            Buffer.from(
                JSON.stringify({
                    status: "failed",
                    readerVersion: "12.11.1",
                    sqliteVersion: "",
                    schemaFingerprint: "",
                    projects: [],
                    failureCode: "schema_project",
                }),
            ),
            "opencode_compatibility_database_schema_project",
        ],
    ])("rejects %s without publishing a Project document", async (_label, stdout, code) => {
        const result = await discoverOpenCodeCompatibilityDatabase(input(), {
            runReader: async () => complete(stdout),
        });
        expect(result).toMatchObject({ projectDocument: null, diagnostics: [{ code }] });
    });

    it("waits for the fixed reader callback and records the exited root process", async () => {
        let observedOptions: import("node:child_process").ExecFileOptionsWithBufferEncoding | undefined;
        const executeFile = ((_file, _arguments, options, callback) => {
            observedOptions = options;
            queueMicrotask(() => callback(null, envelope(), Buffer.alloc(0)));
            return { pid: 42 };
        }) as unknown as typeof import("node:child_process").execFile;
        const result = await runOpenCodeCompatibilityReaderBounded("/fixed/reader.cjs", databasePath, 1_000, 16_384, executeFile);
        expect(result).toMatchObject({ status: "complete", processExited: true });
        expect(result.processId).toBe(42);
        expect(observedOptions?.env).toMatchObject({
            ELECTRON_RUN_AS_NODE: "1",
            SQLITE_USE_URI: "1",
        });
    });

    it.each([
        [
            "output limit",
            Object.assign(new Error("too much output"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }),
            "output_limit",
        ],
        ["spawn failure", Object.assign(new Error("denied"), { code: "EACCES" }), "eacces"],
        ["plain failure", new Error("failed"), "exit"],
    ])("classifies a bounded reader %s and discards output", async (_label, error, failureCode) => {
        const executeFile = ((_file, _arguments, _options, callback) => {
            queueMicrotask(() => callback(error, Buffer.from("{"), Buffer.from("private stderr")));
            return { pid: 43 };
        }) as unknown as typeof import("node:child_process").execFile;
        const result = await runOpenCodeCompatibilityReaderBounded("/fixed/reader.cjs", databasePath, 1_000, 16_384, executeFile);
        expect(result).toMatchObject({
            status: "failed",
            stdout: new Uint8Array(),
            failureCode,
            processId: 43,
            processExited: true,
        });
    });

    it("kills a timed-out fixed reader and publishes no partial stdout", async () => {
        const scriptPath = path.join(sandbox, "slow-reader.cjs");
        fs.writeFileSync(scriptPath, "process.stdout.write('{'); setInterval(() => undefined, 1000);\n");
        const result = await runOpenCodeCompatibilityReaderBounded(scriptPath, databasePath, 20, 16_384);
        expect(result).toMatchObject({
            status: "timed_out",
            stdout: new Uint8Array(),
            failureCode: "timeout",
            processExited: true,
        });
        if (process.platform === "linux") {
            expect(fs.existsSync(`/proc/${result.processId}`)).toBe(false);
        }
    });
});
