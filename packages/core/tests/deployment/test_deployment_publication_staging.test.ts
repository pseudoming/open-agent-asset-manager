/** Persistent location policy; Linux device proof and explicit Windows path-policy fixtures. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { directoriesShareFilesystem } from "@oaam/shared/filesystem";
import { getPhysicalHomeDirectory } from "@oaam/shared/paths";
import {
    selectPublicationStagingRoot,
    projectPublicationRootForBinding,
} from "../../src/deployment/deployment-publication-staging";
import { createTargetIo } from "../../src/deployment/deployment-target-io";
import type { JournalPublication } from "../../src/deployment/deployment-publication-model";

vi.mock("@oaam/shared/paths", async (original) => ({ ...(await original<object>()), getPhysicalHomeDirectory: vi.fn() }));
vi.mock("@oaam/shared/filesystem", async (original) => {
    const actual = await original<typeof import("@oaam/shared/filesystem")>();
    return { ...actual, directoriesShareFilesystem: vi.fn(actual.directoriesShareFilesystem) };
});
const txn = "00000000-0000-4000-8000-000000000123";
const leaf = ".claude/skills/example";
const units: JournalPublication[] = [
    { kind: "directory", relativePath: leaf, completeReplacement: true, oldTree: null, preparedIdentity: null, recovery: null },
];
let root: string, state: string, home: string, project: string;
beforeEach(async () => {
    const actual = await vi.importActual<typeof import("@oaam/shared/filesystem")>("@oaam/shared/filesystem");
    vi.mocked(directoriesShareFilesystem).mockImplementation(actual.directoriesShareFilesystem);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-publication-staging-"));
    state = path.join(root, "state");
    home = path.join(root, "home");
    project = path.join(root, "project");
    fs.mkdirSync(state);
    fs.mkdirSync(home);
    fs.mkdirSync(path.join(project, ".claude/skills"), { recursive: true });
    vi.mocked(getPhysicalHomeDirectory).mockReturnValue(home);
});
afterEach(() => {
    vi.resetAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
});

describe("persistent publication staging", () => {
    it("uses existing State on the same filesystem before resolving another home", () => {
        expect(
            selectPublicationStagingRoot(createTargetIo(project), txn, units, [leaf], {
                stateRootPath: state,
                projectRootPath: project,
            }),
        ).toBe(path.join(state, `oaam-deployment-${txn}`));
        expect(getPhysicalHomeDirectory).not.toHaveBeenCalled();
        expect(fs.readdirSync(state)).toEqual([]);
    });
    it.skipIf(process.platform !== "linux" || !fs.existsSync("/dev/shm"))(
        "rejects an actual different-device root and retains material on the target filesystem",
        () => {
            expect(fs.statSync("/dev/shm").dev).not.toBe(fs.statSync(project).dev);
            expect(selectPublicationStagingRoot(createTargetIo(project), txn, units, [leaf], { stateRootPath: "/dev/shm" })).toBe(
                path.join(home, `oaam-deployment-${txn}`),
            );
        },
    );
    it("uses the exact D-drive Project fallback when both State and home belong to C (path-policy fixture)", () => {
        vi.mocked(getPhysicalHomeDirectory).mockReturnValue("C:\\Users\\owner");
        vi.mocked(directoriesShareFilesystem).mockImplementation((first, second) => first.slice(0, 2) === second.slice(0, 2));
        expect(
            selectPublicationStagingRoot(createTargetIo("D:\\work\\project"), txn, units, [leaf], {
                stateRootPath: "C:\\Users\\owner\\AppData\\Local\\OAAM",
                projectRootPath: "D:\\work\\project",
            }),
        ).toBe(`D:\\work\\project\\oaam-deployment-${txn}`);
        expect(getPhysicalHomeDirectory).not.toHaveBeenCalled();
    });
    it("keeps Project staging inside its exact selected root before considering an equally eligible HOME", () => {
        expect(selectPublicationStagingRoot(createTargetIo(project), txn, units, [leaf], { projectRootPath: project })).toBe(
            path.join(project, `oaam-deployment-${txn}`),
        );
        expect(getPhysicalHomeDirectory).not.toHaveBeenCalled();
        expect(fs.readdirSync(project)).toEqual([".claude"]);
        expect(fs.readdirSync(home)).toEqual([]);
    });
    it("does not exclude the whole home for Global deployment or depend on its OS temp directory", () => {
        fs.mkdirSync(path.join(home, ".claude/skills"), { recursive: true });
        expect(selectPublicationStagingRoot(createTargetIo(home), txn, units, [leaf], {})).toBe(
            path.join(home, `oaam-deployment-${txn}`),
        );
    });
    it("rejects even an OAAM State path when it lies inside the managed leaf's loading container", () => {
        const unsafeState = path.join(project, ".claude/skills/state");
        fs.mkdirSync(unsafeState);
        expect(selectPublicationStagingRoot(createTargetIo(project), txn, units, [leaf], { stateRootPath: unsafeState })).toBe(
            path.join(home, `oaam-deployment-${txn}`),
        );
        expect(directoriesShareFilesystem).not.toHaveBeenCalledWith(unsafeState, expect.anything());
    });
    it("keeps inert file-only recovery slots on their parent filesystem without a whole-tree constraint", () => {
        const files: JournalPublication[] = [
            { kind: "file", relativePath: "CLAUDE.md", completeReplacement: true, recovery: null },
        ];
        expect(selectPublicationStagingRoot(createTargetIo(project), txn, files, [], {})).toBe(
            path.join(project, `oaam-deployment-${txn}`),
        );
        expect(getPhysicalHomeDirectory).not.toHaveBeenCalled();
    });
    it("does not guess a Project root from a config/shared-Skill target when no persistent same-device owner is available", () => {
        vi.mocked(directoriesShareFilesystem).mockReturnValue(false);
        expect(() =>
            selectPublicationStagingRoot(createTargetIo(project), txn, units, [leaf], {
                projectRootPath: path.join(root, "unrelated"),
            }),
        ).toThrow("no persistent same-filesystem");
        expect(directoriesShareFilesystem).toHaveBeenCalledTimes(3);
        expect(fs.readdirSync(project)).toEqual([".claude"]);
    });
    it("projects an exact selected-WSL Project ancestor and rejects an invented drive mapping", () => {
        const binding = {
            bindingId: txn,
            deploymentId: txn,
            platformInstanceId: "Ubuntu",
            targetRootPath: "\\\\wsl.localhost\\Ubuntu\\home\\example\\project\\.claude",
            executionRootPath: "/home/example/project/.claude",
        };
        expect(projectPublicationRootForBinding("\\\\wsl.localhost\\Ubuntu\\home\\example\\project", binding)).toBe(
            "/home/example/project",
        );
        expect(projectPublicationRootForBinding("D:\\project", binding)).toBeUndefined();
        expect(projectPublicationRootForBinding("relative/project", binding)).toBeUndefined();
        expect(projectPublicationRootForBinding(`${binding.targetRootPath}\\child`, binding)).toBeUndefined();
        expect(projectPublicationRootForBinding(binding.targetRootPath, binding)).toBe(binding.executionRootPath);
        expect(
            projectPublicationRootForBinding("\\\\wsl.localhost\\Ubuntu\\home\\example\\project", {
                ...binding,
                executionRootPath: "/foreign/project/.claude",
            }),
        ).toBeUndefined();
        expect(projectPublicationRootForBinding("\\\\wsl.localhost\\Other\\home\\example\\project", binding)).toBeUndefined();
    });
    it.each([
        false,
        true,
    ])("retains a cross-volume Global target without a Project manifest; direct Skill root=%s (path-policy fixture)", (direct) => {
        vi.mocked(getPhysicalHomeDirectory).mockReturnValue("C:\\Users\\owner");
        vi.mocked(directoriesShareFilesystem).mockImplementation((first, second) => first.slice(0, 2) === second.slice(0, 2));
        const targetRoot = direct ? "D:\\personal\\skills" : "D:\\personal\\config";
        const boundary = direct ? "example" : "skills/example";
        const directory: JournalPublication = {
            kind: "directory",
            relativePath: boundary,
            completeReplacement: true,
            oldTree: null,
            preparedIdentity: null,
            recovery: null,
        };
        const selected = selectPublicationStagingRoot(createTargetIo(targetRoot), txn, [directory], [boundary], {
            stateRootPath: "C:\\Users\\owner\\AppData\\Local\\OAAM",
        });
        expect(selected).toBe(`${direct ? "D:\\personal" : targetRoot}\\oaam-deployment-${txn}`);
        expect(selected.startsWith(`${targetRoot}\\${direct ? "" : "skills\\"}`)).toBe(false);
    });
});
