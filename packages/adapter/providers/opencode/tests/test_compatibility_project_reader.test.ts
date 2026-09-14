import { describe, expect, it, vi } from "vitest";
import {
    readCompatibleOpenCodeProjects,
    runOpenCodeCompatibilityReaderMain,
    type OpenCodeCompatibilityReaderOutput,
} from "../src/opencode-compatibility-project-reader";

const projectSchema = [
    column(0, "id", "TEXT", 0, 1),
    column(1, "worktree", "TEXT", 1, 0),
    column(2, "vcs", "TEXT", 0, 0),
    column(3, "name", "TEXT", 0, 0),
    column(4, "icon_url", "TEXT", 0, 0),
    column(5, "icon_url_override", "TEXT", 0, 0),
    column(6, "icon_color", "TEXT", 0, 0),
    column(7, "time_created", "INTEGER", 1, 0),
    column(8, "time_updated", "INTEGER", 1, 0),
    column(9, "time_initialized", "INTEGER", 0, 0),
    column(10, "sandboxes", "TEXT", 1, 0),
    column(11, "commands", "TEXT", 0, 0),
];
const directorySchema = [
    column(0, "project_id", "TEXT", 1, 1),
    column(1, "directory", "TEXT", 1, 2),
    column(2, "type", "TEXT", 0, 0),
    column(3, "strategy", "TEXT", 0, 0),
    column(4, "time_created", "INTEGER", 1, 0),
];

interface FakeDatabaseOptions {
    readonly projects?: readonly Record<string, unknown>[];
    readonly directories?: readonly Record<string, unknown>[];
    readonly projectSchema?: readonly Record<string, unknown>[];
    readonly directorySchema?: readonly Record<string, unknown>[];
    readonly sqliteVersion?: unknown;
}

function fakeDatabase(options: FakeDatabaseOptions = {}) {
    const pragmas: string[] = [];
    const statements: string[] = [];
    let closed = false;
    const database = {
        pragma(source: string) {
            pragmas.push(source);
            if (source === "table_info(project)") return options.projectSchema ?? projectSchema;
            if (source === "table_info(project_directory)") return options.directorySchema ?? directorySchema;
            return [];
        },
        prepare(source: string) {
            statements.push(source);
            return {
                all: () =>
                    source.includes("FROM project_directory") ? [...(options.directories ?? [])] : [...(options.projects ?? [])],
                get: () => ({ version: options.sqliteVersion ?? "3.53.2" }),
            };
        },
        close() {
            closed = true;
        },
    };
    return {
        database,
        state: {
            pragmas,
            statements,
            get closed() {
                return closed;
            },
        },
    };
}

function project(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: "project-a",
        worktree: "/work/project-a",
        name: "Project A",
        sandboxes: JSON.stringify(["/work/z", "/work/a"]),
        ...overrides,
    };
}

describe("OpenCode compatibility project reader", () => {
    it("accepts only the known schema and queries the bounded registration columns", () => {
        const fake = fakeDatabase({
            projects: [project()],
            directories: [
                { project_id: "project-a", directory: "/work/c" },
                { project_id: "project-a", directory: "/work/a" },
            ],
        });
        const result = readCompatibleOpenCodeProjects("/registry.db", () => fake.database);

        expect(result).toEqual({
            status: "complete",
            readerVersion: "12.11.1",
            sqliteVersion: "3.53.2",
            schemaFingerprint: "opencode-project-registry-20260423070820",
            projects: [
                {
                    id: "project-a",
                    worktree: "/work/project-a",
                    name: "Project A",
                    sandboxes: ["/work/a", "/work/c", "/work/z"],
                },
            ],
            failureCode: "",
        });
        expect(fake.state.pragmas).toEqual(["query_only = ON", "table_info(project)", "table_info(project_directory)"]);
        expect(fake.state.statements).toEqual([
            "SELECT id, worktree, name, sandboxes FROM project ORDER BY id LIMIT ?",
            "SELECT project_id, directory FROM project_directory ORDER BY project_id, directory LIMIT ?",
            "SELECT sqlite_version() AS version",
        ]);
        expect(fake.state.closed).toBe(true);
    });

    it.each([
        ["missing project column", { projectSchema: projectSchema.slice(0, -1) }, "schema_project"],
        ["extra project column", { projectSchema: [...projectSchema, column(12, "future", "TEXT", 0, 0)] }, "schema_project"],
        [
            "changed project nullability",
            { projectSchema: projectSchema.map((item, index) => (index === 1 ? { ...item, notnull: 0 } : item)) },
            "schema_project",
        ],
        ["missing directory table", { directorySchema: [] }, "schema_project_directory"],
        ["malformed schema row", { projectSchema: [null as unknown as Record<string, unknown>] }, "schema_column"],
        ["duplicate project", { projects: [project(), project()] }, "duplicate_project"],
        [
            "orphan directory",
            { projects: [project()], directories: [{ project_id: "other", directory: "/work/other" }] },
            "orphan_project_directory",
        ],
        ["malformed sandboxes", { projects: [project({ sandboxes: "{" })] }, "invalid_sandboxes"],
        ["non-array sandboxes", { projects: [project({ sandboxes: "{}" })] }, "invalid_sandboxes"],
        ["invalid identity", { projects: [project({ id: " project-a" })] }, "invalid_text"],
    ])("fails closed for %s", (_label, options, failureCode) => {
        const fake = fakeDatabase(options);
        expect(readCompatibleOpenCodeProjects("/registry.db", () => fake.database)).toMatchObject({
            status: "failed",
            projects: [],
            failureCode,
        });
        expect(fake.state.closed).toBe(true);
    });

    it("enforces row, per-project path, text, and serialized-output bounds", () => {
        const projects = Array.from({ length: 10_001 }, (_, index) =>
            project({ id: `project-${index}`, worktree: `/work/${index}`, sandboxes: "[]" }),
        );
        expect(readCompatibleOpenCodeProjects("/registry.db", () => fakeDatabase({ projects }).database).failureCode).toBe(
            "project_limit",
        );

        const directories = Array.from({ length: 100_001 }, (_, index) => ({
            project_id: "project-a",
            directory: `/work/${index}`,
        }));
        expect(
            readCompatibleOpenCodeProjects(
                "/registry.db",
                () => fakeDatabase({ projects: [project({ sandboxes: "[]" })], directories }).database,
            ).failureCode,
        ).toBe("project_directory_limit");

        const sandboxes = Array.from({ length: 4_097 }, (_, index) => `/work/${index}`);
        expect(
            readCompatibleOpenCodeProjects("/registry.db", () => fakeDatabase({ projects: [project({ sandboxes })] }).database)
                .failureCode,
        ).toBe("invalid_sandboxes");
        expect(
            readCompatibleOpenCodeProjects(
                "/registry.db",
                () => fakeDatabase({ projects: [project({ name: "x".repeat(32_769) })] }).database,
            ).failureCode,
        ).toBe("invalid_text");
        expect(
            readCompatibleOpenCodeProjects(
                "/registry.db",
                () =>
                    fakeDatabase({
                        projects: Array.from({ length: 200 }, (_, index) =>
                            project({
                                id: `project-${index}`,
                                worktree: `/work/${index}/${"x".repeat(22_000)}`,
                                sandboxes: "[]",
                            }),
                        ),
                    }).database,
            ).failureCode,
        ).toBe("project_output_limit");
    });

    it.each([
        ["busy", "SQLITE_BUSY", "sqlite_busy"],
        ["cannot open", "SQLITE_CANTOPEN", "sqlite_cantopen"],
        ["corrupt", "SQLITE_CORRUPT", "sqlite_invalid"],
    ])("classifies %s database failures", (_label, code, failureCode) => {
        const result = readCompatibleOpenCodeProjects("/registry.db", () => {
            throw Object.assign(new Error(code), { code });
        });
        expect(result).toMatchObject({ status: "failed", failureCode });
    });

    it("rejects an untyped database failure and an invalid SQLite version", () => {
        expect(
            readCompatibleOpenCodeProjects("/registry.db", () => {
                throw new Error("untyped failure");
            }),
        ).toMatchObject({ status: "failed", failureCode: "sqlite_invalid" });
        expect(readCompatibleOpenCodeProjects("/registry.db", () => fakeDatabase({ sqliteVersion: 42 }).database)).toMatchObject({
            status: "failed",
            failureCode: "invalid_text",
        });
    });

    it("emits one strict envelope and returns the matching process status", () => {
        const complete: OpenCodeCompatibilityReaderOutput = {
            status: "complete",
            readerVersion: "12.11.1",
            sqliteVersion: "3.53.2",
            schemaFingerprint: "opencode-project-registry-20260423070820",
            projects: [],
            failureCode: "",
        };
        const output: string[] = [];
        expect(
            runOpenCodeCompatibilityReaderMain(
                ["/registry.db"],
                (value) => output.push(value),
                () => complete,
            ),
        ).toBe(0);
        expect(output).toEqual([`${JSON.stringify(complete)}\n`]);
        expect(runOpenCodeCompatibilityReaderMain([], () => undefined)).toBe(2);
        expect(runOpenCodeCompatibilityReaderMain(["bad\0path"], () => undefined)).toBe(2);
        expect(runOpenCodeCompatibilityReaderMain(["a", "b"], () => undefined)).toBe(2);
    });

    it("uses stdout only at the fixed child-process entry", () => {
        const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
        expect(
            runOpenCodeCompatibilityReaderMain(["/registry.db"], undefined, () => ({
                status: "failed",
                readerVersion: "12.11.1",
                sqliteVersion: "",
                schemaFingerprint: "",
                projects: [],
                failureCode: "fixture",
            })),
        ).toBe(2);
        expect(write).toHaveBeenCalledTimes(1);
        write.mockRestore();
    });
});

function column(cid: number, name: string, type: string, notnull: 0 | 1, pk: number) {
    return { cid, name, type, notnull, dflt_value: null, pk };
}
