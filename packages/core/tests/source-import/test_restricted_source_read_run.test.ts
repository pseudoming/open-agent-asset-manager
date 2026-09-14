/** A paused original Provider read advances only through exact Host grant and release decisions. */
import * as fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSelectedWslPathProjection } from "@oaam/shared/paths";
import type { AdapterProvider } from "../../src/types";
import * as adapterAccess from "../../src/adapters/adapter-read-access";
import { acquireAllLocks, type LockHandle } from "../../src/foundation/physical-path-locks";
import {
    createRestrictedSourceReadRun,
    type RestrictedSourceReadContinuation,
    type RestrictedSourceReadStep,
} from "../../src/source-import/restricted-source-read-run";
import {
    restrictedReadAuthorityKeys,
    restrictedReadAuthorityIntentFingerprint,
} from "../../src/source-import/restricted-source-read-operation";
import { prepareRead } from "../../src/source-import/source-read-preparation";
import { validateAdapterReadResultSnapshot } from "../../src/source-import/source-read-snapshot-validator";
import { authority, provider, root, sandbox, sourceFile, target, validRead } from "./fixtures/source-contract-test-fixtures";

afterEach(() => vi.restoreAllMocks());

function fixture(onRead?: (input: Parameters<AdapterProvider["read"]>[0]) => void) {
    const hostRoot = `\\\\wsl.localhost\\read-test${sandbox.replaceAll("/", "\\")}`;
    const projection = createSelectedWslPathProjection("read-test", hostRoot);
    const phases: string[] = [];
    let calls = 0;
    const selected = provider(async (input) => {
        calls++;
        phases.push("provider_entered");
        onRead?.(input);
        const result = await validRead()(input);
        phases.push("provider_returned");
        return result;
    });
    const selectedTarget = target([root("root-1", projection.toHost(sourceFile))]);
    if (selectedTarget.sourceSelector.selectorKind !== "probe_roots") throw new Error("expected probe root fixture");
    selectedTarget.sourceSelector.observation.platformContext = {
        platform: "wsl",
        platformInstanceId: "read-test",
        accessRootPath: hostRoot,
    };
    const ownedAuthority = authority();
    const prepared = prepareRead(selected, selectedTarget, ownedAuthority);
    if ("diagnostics" in prepared) throw new Error(JSON.stringify(prepared.diagnostics));
    const deadlineAt = Date.now() + 60_000;
    const construction = {
        provider: selected,
        target: selectedTarget,
        authority: ownedAuthority,
        projection,
        deadlineAt,
    };
    const run = createRestrictedSourceReadRun(construction);
    const keyInput = { platform: prepared.platform, sourceRoots: prepared.roots };
    return { run, phases, selectedTarget, ownedAuthority, keyInput, deadlineAt, construction, providerCalls: () => calls };
}

async function completeRun(
    h: ReturnType<typeof fixture>,
    options: { staleAtFinal?: boolean; beforeFirstGrant?: () => void } = {},
) {
    const steps: RestrictedSourceReadStep[] = [];
    let held: LockHandle | null = null;
    let acquireId = "";
    let step = await h.run.advance();
    try {
        for (let count = 0; count < 20; count++) {
            steps.push(step);
            if (step.kind === "complete") return { result: step.result, steps };
            if (step.kind === "acquire_authority") {
                expect(held).toBeNull();
                if (steps.length === 1) options.beforeFirstGrant?.();
                const keys = restrictedReadAuthorityKeys(h.keyInput, step.intent);
                held = acquireAllLocks(h.ownedAuthority.transactionsRoot, keys);
                expect(held).not.toBeNull();
                acquireId = step.stepId;
                const permission = {
                    state:
                        options.staleAtFinal && step.intent.phase === "final_validate" ? ("stale" as const) : ("held" as const),
                };
                step = await h.run.advance({
                    stepId: acquireId,
                    intentFingerprint: restrictedReadAuthorityIntentFingerprint(step.intent),
                    permission,
                });
            } else {
                expect(step.acquiredStepId).toBe(acquireId);
                expect(held).not.toBeNull();
                held!.release();
                held = null;
                step = await h.run.advance({ stepId: step.stepId, released: true });
            }
        }
        throw new Error("source continuation fixture exceeded its expected bound");
    } finally {
        held?.release();
        if (step.kind !== "complete") h.run.cancel();
        await h.run.settled();
    }
}

describe("restricted source read continuations", () => {
    it("rejects invalid deadlines and unsolicited continuations without invoking the Provider", async () => {
        const h = fixture();
        for (const deadlineAt of [Date.now() - 1, Date.now() + 700_000, Date.now() + 0.5]) {
            expect(() => createRestrictedSourceReadRun({ ...h.construction, deadlineAt })).toThrow(/deadline/);
        }
        await h.run.settled();
        await expect(h.run.advance({ stepId: "unsolicited", released: true })).rejects.toThrow(/not requested authority/);
        await h.run.settled();
        expect(h.providerCalls()).toBe(0);
    });

    it.each([
        new Error("final validation fault"),
        "primitive final validation fault",
    ])("releases Host authority before reporting final-validation rejection %s", async (error) => {
        const create = adapterAccess.createAdapterReadOperationWithPhysicalAuthority;
        vi.spyOn(adapterAccess, "createAdapterReadOperationWithPhysicalAuthority").mockImplementation((...args) => {
            const operation = create(...args);
            return {
                ...operation,
                finalValidate() {
                    operation.finalValidate();
                    throw error;
                },
            };
        });
        const h = fixture();
        const completed = await completeRun(h);
        expect(completed.result.status).toBe("failed");
        expect(completed.result.diagnostics).toContainEqual(
            expect.objectContaining({ code: "read.restricted_operation_failed", message: String(error) }),
        );
        expect(completed.steps.slice(-3).map((step) => step.kind)).toEqual([
            "acquire_authority",
            "release_authority",
            "complete",
        ]);
        const lock = acquireAllLocks(
            h.ownedAuthority.transactionsRoot,
            restrictedReadAuthorityKeys(h.keyInput, {
                phase: "access",
                targets: [{ sourceRootId: "root-1", relativePath: "", entryKind: "file" }],
            }),
        );
        try {
            expect(lock).not.toBeNull();
        } finally {
            lock?.release();
        }
        expect(h.providerCalls()).toBe(1);
    });

    it("rejects completion when the deadline expires after the final release is admitted", async () => {
        const h = fixture();
        let held: LockHandle | null = null;
        let final = false;
        let step = await h.run.advance();
        try {
            for (let count = 0; count < 12; count++) {
                if (step.kind === "complete") throw new Error("completion preceded the final release control");
                if (step.kind === "acquire_authority") {
                    final = step.intent.phase === "final_validate";
                    held = acquireAllLocks(
                        h.ownedAuthority.transactionsRoot,
                        restrictedReadAuthorityKeys(h.keyInput, step.intent),
                    );
                    expect(held).not.toBeNull();
                    step = await h.run.advance({
                        stepId: step.stepId,
                        intentFingerprint: restrictedReadAuthorityIntentFingerprint(step.intent),
                        permission: { state: "held" },
                    });
                } else {
                    held!.release();
                    held = null;
                    const next = h.run.advance({ stepId: step.stepId, released: true });
                    if (final) {
                        vi.spyOn(Date, "now").mockReturnValue(h.deadlineAt);
                        await expect(next).rejects.toThrow(/expired/);
                        await h.run.settled();
                        expect(h.phases).toEqual(["provider_entered", "provider_returned"]);
                        return;
                    }
                    step = await next;
                }
            }
            throw new Error("fixture did not reach final validation");
        } finally {
            held?.release();
            h.run.cancel();
            await h.run.settled();
        }
    });

    it("rejects a retained Provider readAccess call immediately after completion without requesting new authority", async () => {
        let retained: Parameters<AdapterProvider["read"]>[0] | undefined;
        const h = fixture((input) => {
            retained = input;
        });
        const result = await completeRun(h);
        expect(result.result.status).toBe("complete");
        if (retained === undefined) throw new Error("Provider readAccess was not captured");
        const obligation = retained.sourceReadObligations[0]!;
        const late = retained.readAccess.resolveRootEntry(obligation.sourceReadObligationId, obligation.sourceRootId);
        let outcome: unknown = "pending";
        const joined = late.then(
            (value) => {
                outcome = value;
            },
            (error) => {
                outcome = error;
            },
        );
        try {
            // The next event-loop turn drains the already-scheduled operation, without an arbitrary time budget.
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(outcome).toBeInstanceOf(Error);
            expect(String(outcome)).toMatch(/complete/);
            expect(h.providerCalls()).toBe(1);
        } finally {
            h.run.cancel();
            await joined;
            await h.run.settled();
        }
    });

    it("rejects retained readAccess once final validation has requested authority, before the complete result exists", async () => {
        let retained: Parameters<AdapterProvider["read"]>[0] | undefined;
        const h = fixture((input) => {
            retained = input;
        });
        let held: LockHandle | null = null;
        let late: Promise<unknown> | undefined;
        let acquisitions = 0;
        let step = await h.run.advance();
        try {
            for (let count = 0; count < 12; count++) {
                if (step.kind === "complete") {
                    expect(late).toBeDefined();
                    expect(step.result.status).toBe("complete");
                    expect(acquisitions).toBe(3);
                    expect(h.providerCalls()).toBe(1);
                    return;
                }
                if (step.kind === "acquire_authority") {
                    acquisitions++;
                    if (step.intent.phase === "final_validate") {
                        if (retained === undefined) throw new Error("Provider callback was not captured");
                        const obligation = retained.sourceReadObligations[0]!;
                        let outcome: unknown = "pending";
                        late = retained.readAccess
                            .resolveRootEntry(obligation.sourceReadObligationId, obligation.sourceRootId)
                            .then(
                                (value) => {
                                    outcome = value;
                                },
                                (error) => {
                                    outcome = error;
                                },
                            );
                        await new Promise<void>((resolve) => setImmediate(resolve));
                        expect(outcome).toBeInstanceOf(Error);
                        expect(String(outcome)).toMatch(/complete/);
                        expect(h.phases).toEqual(["provider_entered", "provider_returned"]);
                    }
                    held = acquireAllLocks(
                        h.ownedAuthority.transactionsRoot,
                        restrictedReadAuthorityKeys(h.keyInput, step.intent),
                    );
                    expect(held).not.toBeNull();
                    step = await h.run.advance({
                        stepId: step.stepId,
                        intentFingerprint: restrictedReadAuthorityIntentFingerprint(step.intent),
                        permission: { state: "held" },
                    });
                } else {
                    held!.release();
                    held = null;
                    step = await h.run.advance({ stepId: step.stepId, released: true });
                }
            }
            throw new Error("fixture did not request final authority");
        } finally {
            held?.release();
            h.run.cancel();
            await h.run.settled();
            await late;
        }
    });

    it("finishes one original Provider call with the original validated candidate and complete ledger", async () => {
        const h = fixture();
        const completed = await completeRun(h, {
            beforeFirstGrant() {
                // Replacement before permission would expose any premature identity read.
                fs.renameSync(sourceFile, `${sourceFile}.before-permission`);
                fs.writeFileSync(sourceFile, "# After Host permission\n");
            },
        });
        expect(h.providerCalls()).toBe(1);
        expect(completed.steps.map((step) => step.kind)).toEqual([
            "acquire_authority",
            "release_authority",
            "acquire_authority",
            "release_authority",
            "acquire_authority",
            "release_authority",
            "complete",
        ]);
        expect(completed.result.status, JSON.stringify(completed.result.diagnostics)).toBe("complete");
        expect(completed.result.value.readTarget).toEqual(h.selectedTarget);
        expect(completed.result.value.candidates[0]?.files[0]).toMatchObject({
            contentKind: "text",
            text: "# After Host permission\n",
        });
        expect(completed.result.value.readAccessOutcomes.map((outcome) => outcome.operation)).toEqual([
            "resolve_root",
            "read_file",
            "final_validate",
        ]);
        expect(validateAdapterReadResultSnapshot(completed.result.value)).toEqual([]);
        expect(h.phases).toEqual(["provider_entered", "provider_returned"]);
        await expect(h.run.advance()).rejects.toThrow(/stale or unrelated/);
        expect(h.providerCalls()).toBe(1);
    });

    it("does not resume Provider parsing until the Host acknowledges release of the completed access", async () => {
        const h = fixture();
        const first = await h.run.advance();
        if (first.kind !== "acquire_authority") throw new Error("expected initial authority");
        const held = acquireAllLocks(h.ownedAuthority.transactionsRoot, restrictedReadAuthorityKeys(h.keyInput, first.intent))!;
        try {
            const release = await h.run.advance({
                stepId: first.stepId,
                intentFingerprint: restrictedReadAuthorityIntentFingerprint(first.intent),
                permission: { state: "held" },
            });
            expect(release.kind).toBe("release_authority");
            expect(h.phases).toEqual(["provider_entered"]);
            expect(h.providerCalls()).toBe(1);
            h.run.cancel();
            await h.run.settled();
            expect(h.phases).toEqual(["provider_entered"]);
        } finally {
            held.release();
        }
    });

    it("reports stale final authority through the original source status and final-validation ledger", async () => {
        const h = fixture();
        const completed = await completeRun(h, { staleAtFinal: true });
        expect(completed.result.status).toBe("failed");
        expect(completed.result.value.readAccessOutcomes).toContainEqual(
            expect.objectContaining({ operation: "final_validate", status: "stale" }),
        );
        expect(completed.result.value.sourceReports[0]?.status).toBe("blocked");
        expect(h.providerCalls()).toBe(1);
    });

    it.each([
        "old_step",
        "extra_authority",
        "wrong_intent",
    ])("rejects %s continuation without another Provider call", async (kind) => {
        const h = fixture();
        const first = await h.run.advance();
        if (first.kind !== "acquire_authority") throw new Error("expected initial authority");
        const intentFingerprint = restrictedReadAuthorityIntentFingerprint(first.intent);
        const continuation =
            kind === "old_step"
                ? { stepId: "unrelated", intentFingerprint, permission: { state: "held" } }
                : kind === "wrong_intent"
                  ? {
                        stepId: first.stepId,
                        intentFingerprint: restrictedReadAuthorityIntentFingerprint({ phase: "final_validate", targets: [] }),
                        permission: { state: "held" },
                    }
                  : { stepId: first.stepId, intentFingerprint, permission: { state: "held", bypass: true } };
        await expect(h.run.advance(continuation as RestrictedSourceReadContinuation)).rejects.toThrow(/continuation/);
        await h.run.settled();
        await expect(h.run.advance()).rejects.toThrow(/closed/);
        expect(h.providerCalls()).toBe(1);
        expect(h.phases).toEqual(["provider_entered"]);
    });

    it("rejects simultaneous advances while retaining the single pending Provider operation", async () => {
        const h = fixture();
        const first = h.run.advance();
        await expect(h.run.advance()).rejects.toThrow(/active continuation/);
        expect((await first).kind).toBe("acquire_authority");
        h.run.cancel();
        await h.run.settled();
        expect(h.providerCalls()).toBe(1);
    });

    it("rejects permission after the original deadline and joins cancellation without resuming the Provider", async () => {
        const h = fixture();
        const first = await h.run.advance();
        if (first.kind !== "acquire_authority") throw new Error("expected initial authority");
        vi.spyOn(Date, "now").mockReturnValue(h.deadlineAt);
        await expect(
            h.run.advance({
                stepId: first.stepId,
                intentFingerprint: restrictedReadAuthorityIntentFingerprint(first.intent),
                permission: { state: "held" },
            }),
        ).rejects.toThrow(/expired/);
        await h.run.settled();
        expect(h.providerCalls()).toBe(1);
        expect(h.phases).toEqual(["provider_entered"]);
    });
});
