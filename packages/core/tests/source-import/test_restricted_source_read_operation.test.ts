/** Original read ledgers and stable closure under separately owned Host physical locks. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSelectedWslPathProjection } from "@oaam/shared/paths";
import { SafeFilesystemError } from "@oaam/shared/filesystem";
import * as adapterAccess from "../../src/adapters/adapter-read-access";
import {
    createAdapterReadOperation,
    type AdapterReadOperation,
    type CreateAdapterReadOperationInput,
} from "../../src/adapters/adapter-read-access";
import { acquireAllLocks } from "../../src/foundation/physical-path-locks";
import {
    createRestrictedSourceReadOperation,
    restrictedReadAuthorityKeys,
    type RestrictedReadAuthorityIntent,
    type RestrictedReadAuthorityOwner,
    type RestrictedReadAuthorityPermission,
} from "../../src/source-import/restricted-source-read-operation";
import type { PosixRelativePath } from "../../src/types";

const observations = vi.hoisted(() => ({ read: vi.fn(), inventory: vi.fn(), batch: vi.fn() }));
vi.mock("@oaam/shared/filesystem", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@oaam/shared/filesystem")>();
    return {
        ...actual,
        readRegularFileNoFollow: (...args: Parameters<typeof actual.readRegularFileNoFollow>) => {
            observations.read(...args);
            return actual.readRegularFileNoFollow(...args);
        },
        inventoryDirectoryNoFollow: (...args: Parameters<typeof actual.inventoryDirectoryNoFollow>) => {
            observations.inventory(...args);
            return actual.inventoryDirectoryNoFollow(...args);
        },
        readRegularFilesNoFollow: (...args: Parameters<typeof actual.readRegularFilesNoFollow>) => {
            observations.batch(...args);
            return actual.readRegularFilesNoFollow(...args);
        },
    };
});
const FP = `sha256:${"1".repeat(64)}` as const;
const AUTHORITY = `sha256:${"2".repeat(64)}` as const;

describe("restricted source operation physical authority", () => {
    let root = "";
    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-restricted-source-operation-"));
        observations.read.mockReset();
        observations.inventory.mockReset();
        observations.batch.mockReset();
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    function fixture(
        options: {
            beforeGrant?: (intent: RestrictedReadAuthorityIntent) => void | Promise<void>;
            permission?: () => RestrictedReadAuthorityPermission;
        } = {},
    ) {
        const sourceRoot = path.join(root, "source");
        fs.mkdirSync(sourceRoot);
        fs.writeFileSync(path.join(sourceRoot, "GUIDANCE.md"), "# Guidance\n");
        fs.writeFileSync(path.join(sourceRoot, "ignored.bin"), Buffer.from([0, 255, 128]));
        fs.chmodSync(path.join(sourceRoot, "ignored.bin"), 0o700);
        const projection = createSelectedWslPathProjection(
            "read-test",
            `\\\\wsl.localhost\\read-test${root.replaceAll("/", "\\")}`,
        );
        const input: CreateAdapterReadOperationInput = {
            platform: "wsl",
            sourceRoots: [
                {
                    sourceRootId: "root-1",
                    rootRole: "source",
                    sourceDomain: "agent_runtime_private",
                    path: projection.toHost(sourceRoot),
                    accessStatus: "available",
                    locatorEvidence: [
                        { locatorKind: "runtime_known_rule", locatorKey: "fixture", evidenceLevel: "agent_runtime_verified" },
                    ],
                    diagnostics: [],
                },
            ],
            sourceReadObligations: [
                { sourceReadObligationId: "obligation", sourceRootId: "root-1", sourceCapabilityFingerprint: FP },
            ],
            sourceCapabilities: [
                {
                    sourceCapabilityFingerprint: FP,
                    agentRuntimeId: "FIXTURE_CLI",
                    entrySupportStatus: "supported",
                    rootLocatorKind: "runtime_known_rule",
                    rootRole: "source",
                    sourceDomain: "agent_runtime_private",
                    assetKind: "Guidance",
                    sourcePathMechanism: "recursive_entry",
                    evidenceLevel: "agent_runtime_verified",
                    readPolicy: "auto_read",
                    diagnostics: [],
                },
            ],
            managedTargetGuards: [],
            readAuthorityFingerprint: AUTHORITY,
            transactionsRoot: path.join(root, "Host-transactions"),
        };
        const intents: RestrictedReadAuthorityIntent[] = [];
        let activeKeys: string[] | undefined;
        const owner: RestrictedReadAuthorityOwner = {
            async withAuthority(intent, run) {
                intents.push(structuredClone(intent));
                await options.beforeGrant?.(intent);
                const keys = restrictedReadAuthorityKeys(input, intent);
                const lock = acquireAllLocks(input.transactionsRoot, keys);
                try {
                    activeKeys = keys;
                    return await run(lock === null ? { state: "busy" } : (options.permission?.() ?? { state: "held" }));
                } finally {
                    activeKeys = undefined;
                    lock?.release();
                }
            },
        };
        const operation = createRestrictedSourceReadOperation(input, projection, owner);
        const assertLocked = () => {
            if (activeKeys === undefined) throw new Error("physical source access preceded Host admission");
            const attempted = acquireAllLocks(input.transactionsRoot, activeKeys);
            expect(attempted).toBeNull();
            attempted?.release();
        };
        return { sourceRoot, input, projection, owner, operation, intents, assertLocked };
    }

    async function readAll(operation: Pick<AdapterReadOperation, "readAccess">) {
        const resolved = await operation.readAccess.resolveRootEntry("obligation", "root-1");
        if (resolved.state !== "succeeded") throw new Error(JSON.stringify(resolved));
        const listed = await operation.readAccess.listDirectory(resolved.value.readEntryHandleId);
        if (listed.state !== "succeeded") throw new Error(JSON.stringify(listed));
        for (const child of listed.value.children) {
            const read = await operation.readAccess.readFile(child.readEntryHandleId);
            expect(read.state).toBe("succeeded");
        }
        return listed.value.children;
    }

    it("reproduces the original local ledger and two fresh passes while every physical access holds the Host key closure", async () => {
        const h = fixture();
        const local = createAdapterReadOperation(
            { ...h.input, sourceRoots: h.input.sourceRoots.map((source) => ({ ...source, path: h.sourceRoot })) },
            () => true,
        );
        await readAll(local);
        expect(local.finalValidate()).toEqual({ valid: true, diagnostics: [] });
        observations.read.mockClear();
        observations.inventory.mockClear();
        observations.batch.mockClear();
        observations.read.mockImplementation(h.assertLocked);
        observations.inventory.mockImplementation(h.assertLocked);
        observations.batch.mockImplementation(h.assertLocked);
        await readAll(h.operation);
        expect(await h.operation.finalValidate()).toEqual({ valid: true, diagnostics: [] });
        expect(h.operation.snapshot()).toEqual(local.snapshot());
        expect(observations.batch).toHaveBeenCalledTimes(2);
        expect(h.intents.at(-1)).toEqual({
            phase: "final_validate",
            targets: [
                { sourceRootId: "root-1", relativePath: "", entryKind: "directory" },
                { sourceRootId: "root-1", relativePath: "GUIDANCE.md", entryKind: "file" },
                { sourceRootId: "root-1", relativePath: "ignored.bin", entryKind: "file" },
            ],
        });
        const released = acquireAllLocks(h.input.transactionsRoot, restrictedReadAuthorityKeys(h.input, h.intents.at(-1)!));
        expect(released).not.toBeNull();
        released?.release();
    });

    it("performs no identity, inventory or byte read while waiting for Host permission", async () => {
        let release!: () => void;
        let entered!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const entering = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const h = fixture({
            beforeGrant: async () => {
                entered();
                await gate;
            },
        });
        const read = h.operation.readAccess.resolveRootEntry("obligation", "root-1");
        await entering;
        expect(observations.inventory).not.toHaveBeenCalled();
        expect(observations.read).not.toHaveBeenCalled();
        release();
        expect((await read).state).toBe("succeeded");
        expect(observations.inventory).toHaveBeenCalledTimes(1);
    });

    it("rejects a wrong platform and an authority closure outside the declared roots", () => {
        const h = fixture();
        expect(() => createRestrictedSourceReadOperation({ ...h.input, platform: "linux" }, h.projection, h.owner)).toThrow(
            /selected WSL/,
        );
        for (const target of [
            { sourceRootId: "other", relativePath: "", entryKind: "file" },
            { sourceRootId: "root-1", relativePath: "../escape", entryKind: "file" },
            { sourceRootId: "root-1", relativePath: "", entryKind: "symlink" },
        ])
            expect(() => restrictedReadAuthorityKeys(h.input, { phase: "access", targets: [target as never] })).toThrow(
                /declared roots/,
            );
        expect(observations.inventory).not.toHaveBeenCalled();
    });

    it.each(["omitted", "replayed"])("refuses an authority owner that %s its callback", async (kind) => {
        const h = fixture();
        const owner: RestrictedReadAuthorityOwner = {
            async withAuthority<T>(
                intent: RestrictedReadAuthorityIntent,
                run: (permission: RestrictedReadAuthorityPermission) => T | Promise<T>,
            ): Promise<T> {
                if (kind === "omitted") return undefined as T;
                await h.owner.withAuthority(intent, run);
                return h.owner.withAuthority(intent, run);
            },
        };
        const operation = createRestrictedSourceReadOperation(h.input, h.projection, owner);
        await expect(operation.readAccess.resolveRootEntry("obligation", "root-1")).rejects.toThrow(/omitted|replayed/);
        await operation.settle();
        expect(observations.inventory).toHaveBeenCalledTimes(kind === "omitted" ? 0 : 1);
    });

    it("refuses a physical port requesting another lock closure under a real Host grant", async () => {
        const h = fixture();
        const create = adapterAccess.createAdapterReadOperationWithPhysicalAuthority;
        vi.spyOn(adapterAccess, "createAdapterReadOperationWithPhysicalAuthority").mockImplementation((...args) => {
            const operation = create(...args);
            const [input, _filesystem, acquire] = args;
            return {
                ...operation,
                readAccess: {
                    ...operation.readAccess,
                    async resolveRootEntry(...request) {
                        acquire(input.transactionsRoot, ["ungranted-physical-key"]);
                        return operation.readAccess.resolveRootEntry(...request);
                    },
                },
            };
        });
        try {
            const operation = createRestrictedSourceReadOperation(h.input, h.projection, h.owner);
            await expect(operation.readAccess.resolveRootEntry("obligation", "root-1")).rejects.toThrow(
                /no matching Host physical authority/,
            );
            await operation.settle();
            expect(h.intents).toHaveLength(1);
            expect(observations.inventory).not.toHaveBeenCalled();
            const lock = acquireAllLocks(h.input.transactionsRoot, restrictedReadAuthorityKeys(h.input, h.intents[0]!));
            try {
                expect(lock).not.toBeNull();
            } finally {
                lock?.release();
            }
        } finally {
            vi.restoreAllMocks();
        }
    });

    it.each(["ordinary", "safe"])("keeps %s physical read failure in the original outcome and Host coordinates", async (kind) => {
        const h = fixture();
        observations.inventory.mockImplementation(() => {
            throw kind === "ordinary"
                ? new Error("inventory denied")
                : new SafeFilesystemError({
                      failureKind: "permission_denied",
                      operation: "inventory_directory",
                      targetPath: h.sourceRoot,
                      message: "inventory denied",
                  });
        });
        const result = await h.operation.readAccess.resolveRootEntry("obligation", "root-1");
        expect(result.state).toBe("failed");
        expect(h.operation.snapshot().outcomes).toContainEqual(
            expect.objectContaining({ operation: "resolve_root", sourceRootId: "root-1" }),
        );
        expect(observations.inventory).toHaveBeenCalledTimes(1);
        expect(observations.read).not.toHaveBeenCalled();
    });

    it("retains the original wrong-entry-kind failure when a valid file handle is listed as a directory", async () => {
        const h = fixture();
        const file = await h.operation.readAccess.resolveEntry("obligation", "root-1", "GUIDANCE.md" as PosixRelativePath);
        if (file.state !== "succeeded") throw new Error("file fixture did not resolve");
        expect(await h.operation.readAccess.listDirectory(file.value.readEntryHandleId)).toMatchObject({ state: "failed" });
        expect(h.intents).toHaveLength(2);
    });

    it("preserves a real busy Host lock refusal and succeeds after its release", async () => {
        const h = fixture();
        const keys = restrictedReadAuthorityKeys(h.input, {
            phase: "access",
            targets: [{ sourceRootId: "root-1", relativePath: "", entryKind: "file" }],
        });
        const lock = acquireAllLocks(h.input.transactionsRoot, keys)!;
        const first = await h.operation.readAccess.resolveRootEntry("obligation", "root-1");
        expect(first).toMatchObject({ state: "failed", failureStatus: "busy" });
        expect(observations.inventory).not.toHaveBeenCalled();
        lock.release();
        expect((await h.operation.readAccess.resolveRootEntry("obligation", "root-1")).state).toBe("succeeded");
    });

    it.each(["stale", "io_error"] as const)("preserves Host %s authority refusal before filesystem access", async (state) => {
        const h = fixture({
            permission: () => (state === "io_error" ? { state, message: "controlled Host lock error" } : { state }),
        });
        expect(await h.operation.readAccess.resolveRootEntry("obligation", "root-1")).toMatchObject({
            state: "failed",
            failureStatus: state,
        });
        expect(observations.inventory).not.toHaveBeenCalled();
        expect(observations.read).not.toHaveBeenCalled();
    });

    it("keeps managed targets and invalid opaque-handle/path requests outside physical reads", async () => {
        const h = fixture();
        const blocked = createRestrictedSourceReadOperation(
            {
                ...h.input,
                managedTargetGuards: [
                    {
                        sourceRootId: "root-1",
                        matchKind: "entire_root",
                        managementState: "active_managed",
                        deploymentId: "00000000-0000-4000-8000-000000000001",
                        outputUnitFingerprint: FP,
                    },
                ],
            },
            h.projection,
            h.owner,
        );
        expect(await blocked.readAccess.resolveRootEntry("obligation", "root-1")).toMatchObject({
            state: "failed",
            failureStatus: "blocked_managed_target",
        });
        expect(
            await h.operation.readAccess.resolveEntry("obligation", "root-1", "../outside" as PosixRelativePath),
        ).toMatchObject({ state: "failed" });
        expect(await h.operation.readAccess.readFile("unknown-handle")).toMatchObject({ state: "failed" });
        expect(observations.inventory).not.toHaveBeenCalled();
        expect(observations.read).not.toHaveBeenCalled();
        expect(h.intents).toHaveLength(1);
    });

    it("rejects a real second-pass change even for a read input with no candidate projection", async () => {
        const h = fixture();
        await readAll(h.operation);
        let passes = 0;
        observations.batch.mockImplementation(() => {
            h.assertLocked();
            if (++passes === 2) fs.writeFileSync(path.join(h.sourceRoot, "ignored.bin"), Buffer.from([1, 255, 128]));
        });
        const validated = await h.operation.finalValidate();
        expect(validated.valid).toBe(false);
        expect(validated.diagnostics.some((diagnostic) => diagnostic.code === "read_final_stale")).toBe(true);
        expect(passes).toBe(2);
        expect(
            h.operation
                .snapshot()
                .outcomes.some(
                    (outcome) =>
                        outcome.operation === "final_validate" &&
                        outcome.relativePath === "ignored.bin" &&
                        outcome.status === "stale",
                ),
        ).toBe(true);
    });

    it("retains source-read capacity above the unrelated 12 MiB target frame size", async () => {
        const h = fixture();
        const bytes = Buffer.alloc(13 * 1024 * 1024, 42);
        fs.writeFileSync(path.join(h.sourceRoot, "ignored.bin"), bytes);
        await readAll(h.operation);
        const payload = h.operation.snapshot().filePayloads.find((entry) => entry.bytes.byteLength === bytes.byteLength);
        expect(payload?.bytes.byteLength).toBe(bytes.byteLength);
        expect(Buffer.from(payload!.bytes).equals(bytes)).toBe(true);
        expect(await h.operation.finalValidate()).toEqual({ valid: true, diagnostics: [] });
    });

    it("joins queued Provider calls before inspection of their ledger", async () => {
        const h = fixture();
        const first = h.operation.readAccess.resolveRootEntry("obligation", "root-1");
        const second = h.operation.readAccess.resolveEntry("obligation", "root-1", "GUIDANCE.md" as PosixRelativePath);
        await h.operation.settle();
        expect((await first).state).toBe("succeeded");
        expect((await second).state).toBe("succeeded");
        expect(h.operation.snapshot().handles).toHaveLength(2);
        expect(h.intents).toHaveLength(2);
    });

    it("seals all new access after draining admitted reads while preserving the original unavailable attestation result", async () => {
        const h = fixture();
        const request = {
            verifier: { componentId: "unregistered", componentVersion: 1, configFingerprint: FP },
            subject: { subjectKind: "source_root_entry" as const, sourceRootId: "root-1", relativePath: "" as const },
        };
        const first = h.operation.readAccess.resolveRootEntry("obligation", "root-1");
        const attestation = h.operation.readAccess.verifyExternalAttestation(request);
        await h.operation.settle();
        expect((await first).state).toBe("succeeded");
        expect(await attestation).toMatchObject({ state: "failed", failureStatus: "unsupported_verifier" });
        const ledger = h.operation.snapshot();
        const handle = ledger.handles[0]!;
        for (const call of [
            () => h.operation.readAccess.resolveRootEntry("obligation", "root-1"),
            () => h.operation.readAccess.resolveEntry("obligation", "root-1", "GUIDANCE.md" as PosixRelativePath),
            () => h.operation.readAccess.readFile(handle.readEntryHandleId),
            () => h.operation.readAccess.listDirectory(handle.readEntryHandleId),
            () => h.operation.readAccess.verifyExternalAttestation(request),
        ])
            await expect(call()).rejects.toThrow(/access is complete/);
        expect(h.operation.snapshot()).toEqual(ledger);
        expect(h.intents).toHaveLength(1);
        expect(await h.operation.finalValidate()).toEqual({ valid: true, diagnostics: [] });
    });
});
