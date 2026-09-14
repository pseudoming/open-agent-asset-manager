/** Exact Host permissions retain real locks and bind the service's complete observed closure before final I/O. */
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSelectedWslPathProjection } from "@oaam/shared/paths";
import { acquireAllLocks } from "../../src/foundation/physical-path-locks";
import { createRestrictedSourceHostAuthority } from "../../src/source-import/restricted-source-host-authority";
import { createRestrictedSourceReadRun, type RestrictedSourceReadStep } from "../../src/source-import/restricted-source-read-run";
import { restrictedReadAuthorityKeys } from "../../src/source-import/restricted-source-read-operation";
import {
    cloneRestrictedSourceSession,
    decodeRestrictedSourceAuthority,
    decodeRestrictedSourceTarget,
    decodeRestrictedSourceContinuation,
    RESTRICTED_SOURCE_HOST_LOCK_AUTHORITY,
} from "../../src/source-import/restricted-source-request";
import { prepareRead } from "../../src/source-import/source-read-preparation";
import { failedResult, sourceDiagnostic } from "../../src/source-import/source-read-validation-helpers";
import type { AdapterReadResult, CoreResult } from "../../src/types";
import {
    authority,
    provider,
    root,
    sandbox,
    sourceFile,
    target,
    validRead,
    DEPLOYMENT_ID,
    RESERVATION,
} from "./fixtures/source-contract-test-fixtures";

const physical = vi.hoisted(() => ({ batches: 0, reads: 0 }));
vi.mock("@oaam/shared/filesystem", async (importOriginal) => {
    const original = await importOriginal<typeof import("@oaam/shared/filesystem")>();
    return {
        ...original,
        readRegularFileNoFollow: (...args: Parameters<typeof original.readRegularFileNoFollow>) => {
            physical.reads++;
            return original.readRegularFileNoFollow(...args);
        },
        readRegularFilesNoFollow: (...args: Parameters<typeof original.readRegularFilesNoFollow>) => {
            physical.batches++;
            return original.readRegularFilesNoFollow(...args);
        },
    };
});
beforeEach(() => {
    physical.batches = 0;
    physical.reads = 0;
});
afterEach(() => vi.restoreAllMocks());

function fixture(options: { revalidate?: () => boolean; invalidCandidate?: boolean; checkLocks?: boolean } = {}) {
    const hostRoot = `\\\\wsl.localhost\\read-test${sandbox.replaceAll("/", "\\")}`;
    const projection = createSelectedWslPathProjection("read-test", hostRoot);
    let calls = 0;
    let revalidations = 0;
    const selected = provider(async (input) => {
        calls++;
        const result = await validRead()(input);
        if (options.invalidCandidate) result.candidates[0]!.sourceFileOrigins = [];
        return result;
    });
    const selectedTarget = target([root("root-1", projection.toHost(sourceFile))]);
    if (selectedTarget.sourceSelector.selectorKind !== "probe_roots") throw new Error("expected probe selector");
    const context = { platform: "wsl" as const, platformInstanceId: "read-test", accessRootPath: hostRoot };
    selectedTarget.sourceSelector.observation.platformContext = context;
    selectedTarget.sourceSelector.observation.observedAgentRuntimes[0]!.installationEvidence[0]!.path = projection.toHost(
        `${sandbox}/mock-bin`,
    );
    const hostAuthority = authority();
    const prepared = prepareRead(selected, selectedTarget, hostAuthority);
    if ("diagnostics" in prepared) throw new Error(JSON.stringify(prepared.diagnostics));
    const keys = restrictedReadAuthorityKeys(
        { platform: prepared.platform, sourceRoots: prepared.roots },
        {
            phase: "access",
            targets: [{ sourceRootId: "root-1", relativePath: "", entryKind: "file" }],
        },
    );
    const host = createRestrictedSourceHostAuthority({
        target: selectedTarget,
        preparation: prepared,
        authority: hostAuthority,
        revalidateAuthority() {
            revalidations++;
            if (options.checkLocks !== false) {
                const rival = acquireAllLocks(hostAuthority.transactionsRoot, keys);
                rival?.release();
                expect(rival).toBeNull();
            }
            return options.revalidate?.() ?? true;
        },
    });
    const run = createRestrictedSourceReadRun({
        provider: selected,
        target: selectedTarget,
        authority: { ...hostAuthority, transactionsRoot: RESTRICTED_SOURCE_HOST_LOCK_AUTHORITY },
        projection,
        deadlineAt: Date.now() + 60_000,
    });
    return {
        host,
        run,
        selected,
        selectedTarget,
        context,
        hostAuthority,
        keys,
        calls: () => calls,
        revalidations: () => revalidations,
    };
}

async function complete(h: ReturnType<typeof fixture>, mutate?: (result: CoreResult<AdapterReadResult>) => void) {
    let step: RestrictedSourceReadStep = await h.run.advance();
    try {
        for (let count = 0; count < 20; count++) {
            if (step.kind === "complete") {
                mutate?.(step.result);
                return h.host.finish(step.result);
            }
            const continuation = step.kind === "acquire_authority" ? h.host.grant(step) : h.host.release(step);
            const decoded = decodeRestrictedSourceContinuation(JSON.parse(JSON.stringify(continuation)));
            if (decoded === null) throw new Error("Host returned malformed continuation");
            step = await h.run.advance(decoded);
        }
        throw new Error("test exceeded its finite expected continuation count");
    } finally {
        h.run.cancel();
        await h.run.settled();
        h.host.dispose();
    }
}

describe("restricted source request and Host authority", () => {
    it.each([
        new Error("Host revalidation failed"),
        "primitive Host revalidation failure",
    ])("returns a diagnosed original refusal after revalidation throws %s", async (error) => {
        const h = fixture({
            revalidate() {
                throw error;
            },
        });
        const result = await complete(h);
        expect(result.status).toBe("failed");
        expect(result.value).toBeUndefined();
        expect(h.revalidations()).toBe(1);
        const lock = acquireAllLocks(h.hostAuthority.transactionsRoot, h.keys);
        try {
            expect(lock).not.toBeNull();
        } finally {
            lock?.release();
        }
    });

    it.each(["null", "invalid_id", "replay", "extra", "disposed"])("refuses malformed or retired Host grant %s", async (kind) => {
        const h = fixture();
        const step = await h.run.advance();
        if (step.kind !== "acquire_authority") throw new Error("missing initial permission request");
        try {
            if (kind === "disposed") h.host.dispose();
            if (kind === "replay") h.host.grant(step);
            const damaged =
                kind === "null"
                    ? null
                    : kind === "invalid_id"
                      ? { ...step, stepId: "invalid" }
                      : kind === "extra"
                        ? { ...step, extra: true }
                        : step;
            expect(() => h.host.grant(damaged)).toThrow();
        } finally {
            h.run.cancel();
            await h.run.settled();
            h.host.dispose();
        }
        expect(physical.reads).toBe(0);
    });

    it("refuses an early result while the original physical authority remains held", async () => {
        const h = fixture();
        const step = await h.run.advance();
        if (step.kind !== "acquire_authority") throw new Error("missing permission request");
        const failed = failedResult<AdapterReadResult>([sourceDiagnostic("read.control", "original refusal")]);
        try {
            h.host.grant(step);
            expect(() => h.host.finish(failed)).toThrow(/before authority release/);
            expect(acquireAllLocks(h.hostAuthority.transactionsRoot, h.keys)).toBeNull();
        } finally {
            h.run.cancel();
            await h.run.settled();
            h.host.dispose();
        }
    });

    it.each(["status", "diagnostics", "empty"])("refuses an undiagnosed empty result with invalid %s", (kind) => {
        const h = fixture();
        const result = failedResult<AdapterReadResult>([sourceDiagnostic("read.control", "original refusal")]);
        if (kind === "status") result.status = "complete";
        else if (kind === "diagnostics") Object.assign(result, { diagnostics: [null] });
        else result.diagnostics = [];
        try {
            expect(() => h.host.finish(result)).toThrow(/diagnosed failure/);
        } finally {
            h.host.dispose();
        }
    });

    it.each([
        "success",
        "unblocked_report",
        "missing_diagnostic",
    ])("rejects changed invalid-candidate result %s after the real final grant", async (kind) => {
        const h = fixture({ invalidCandidate: true });
        await expect(
            complete(h, (result) => {
                expect(result.status).toBe("failed");
                if (kind === "success") {
                    result.status = "complete";
                    result.value.status = "complete";
                } else if (kind === "unblocked_report") result.value.sourceReports[0]!.status = "scanned";
                else {
                    result.diagnostics = [];
                    result.value.diagnostics = [];
                }
            }),
        ).rejects.toThrow(/invalid snapshot closure/);
    });

    it("preserves one original Provider read, lock-held revalidation, two passes and release-before-completion", async () => {
        const h = fixture();
        expect(decodeRestrictedSourceTarget(h.selectedTarget, h.selected, h.context)).toEqual(h.selectedTarget);
        const result = await complete(h);
        expect(result.status, JSON.stringify(result.diagnostics)).toBe("complete");
        expect(h.calls()).toBe(1);
        expect(h.revalidations()).toBe(3);
        expect(physical.reads).toBe(4); // Initial resolve/read, then the two original single-file closure passes.
        expect(physical.batches).toBe(0);
        const acquired = acquireAllLocks(h.hostAuthority.transactionsRoot, h.keys);
        expect(acquired).not.toBeNull();
        acquired!.release();
        expect(result.value.candidates[0]?.files[0]).toMatchObject({ text: "# Guidance\n" });
    });

    it("accepts original diagnosed Provider-candidate refusals without accepting their candidates", async () => {
        const h = fixture({ invalidCandidate: true });
        const result = await complete(h);
        expect(result.status).toBe("failed");
        expect(result.value.sourceReports.every((report) => report.status === "blocked")).toBe(true);
        expect(result.diagnostics.some((diagnostic) => diagnostic.code.includes("origin"))).toBe(true);
    });

    it("keeps stale durable authority as an original failed read before physical content access", async () => {
        const h = fixture({ revalidate: () => false });
        const result = await complete(h);
        expect(result.status).toBe("failed");
        expect(result.value).toBeUndefined();
        expect(h.revalidations()).toBe(1);
        expect(physical.batches).toBe(0);
    });

    it("retains the actual busy-lock refusal without recomputing authority outside a held lock", async () => {
        const h = fixture();
        const rival = acquireAllLocks(h.hostAuthority.transactionsRoot, h.keys)!;
        try {
            expect((await complete(h)).status).toBe("failed");
            expect(h.revalidations()).toBe(0);
        } finally {
            rival.release();
        }
    });

    it("rejects a modified final closure before the service performs either final physical pass", async () => {
        const h = fixture({ checkLocks: false });
        let step = await h.run.advance();
        try {
            for (let count = 0; count < 10; count++) {
                if (step.kind === "complete") throw new Error("missing final authority step");
                if (step.kind === "acquire_authority" && step.intent.phase === "final_validate") {
                    expect(physical.batches).toBe(0);
                    const readsBeforeFinal = physical.reads;
                    // Use the real Host grant calculation, with a corrupted on-wire omission.
                    const grant = h.host.grant({ ...step, intent: { ...step.intent, targets: [] } });
                    expect(grant).toMatchObject({ permission: { state: "held" } });
                    await expect(h.run.advance(grant)).rejects.toThrow(/authority metadata/);
                    expect(physical.batches).toBe(0);
                    expect(physical.reads).toBe(readsBeforeFinal);
                    expect(h.calls()).toBe(1);
                    return;
                }
                step = await h.run.advance(step.kind === "acquire_authority" ? h.host.grant(step) : h.host.release(step));
            }
            throw new Error("missing expected final step");
        } finally {
            h.run.cancel();
            await h.run.settled();
            h.host.dispose();
        }
    });

    it.each(["target", "observed_closure"])("rejects changed %s metadata before returning a read result", async (kind) => {
        const h = fixture();
        await expect(
            complete(h, (result) => {
                if (kind === "target") result.value.readTarget.allowedKinds = ["Skill"];
                else result.value.observedReadEntries = [];
            }),
        ).rejects.toThrow(/Host read authority|entire observed ledger/);
    });

    it("holds authority on a wrong release and drops it only after confirmed cancellation", async () => {
        const h = fixture();
        const step = await h.run.advance();
        if (step.kind !== "acquire_authority") throw new Error("missing access step");
        h.host.grant(step);
        expect(() => h.host.release({ kind: "release_authority", stepId: randomUUID(), acquiredStepId: randomUUID() })).toThrow(
            /does not match/,
        );
        expect(acquireAllLocks(h.hostAuthority.transactionsRoot, h.keys)).toBeNull();
        h.run.cancel();
        await h.run.settled();
        h.host.dispose();
        const acquired = acquireAllLocks(h.hostAuthority.transactionsRoot, h.keys)!;
        expect(acquired).not.toBeNull();
        acquired.release();
    });

    it.each([
        "foreign_distro",
        "foreign_root",
        "extra_state",
        "duplicate_kind",
    ])("rejects %s request before Provider execution", (kind) => {
        const h = fixture();
        const changed = structuredClone(h.selectedTarget);
        if (changed.sourceSelector.selectorKind !== "probe_roots") throw new Error("missing observation");
        if (kind === "foreign_distro") changed.sourceSelector.observation.platformContext.platformInstanceId = "other";
        if (kind === "foreign_root")
            changed.sourceSelector.observation.sourceRoots[0]!.path = "\\\\wsl.localhost\\other\\private";
        if (kind === "extra_state") Object.assign(changed, { stateRoot: "/private" });
        if (kind === "duplicate_kind") changed.allowedKinds = ["Guidance", "Guidance"];
        expect(decodeRestrictedSourceTarget(changed, h.selected, h.context)).toBeNull();
        expect(h.calls()).toBe(0);
        h.host.dispose();
    });

    it("strips no authority fields silently and keeps private Host lock paths off the wire", () => {
        const h = fixture();
        expect(decodeRestrictedSourceAuthority(h.hostAuthority)).toBeNull();
        const minimal = { managedTargetGuards: [], reservationIdentityFingerprints: [] };
        expect(decodeRestrictedSourceAuthority(minimal)).toEqual(minimal);
        const guard = {
            sourceRootId: "root-1",
            matchKind: "exact_file",
            managementState: "in_flight_managed",
            deploymentId: DEPLOYMENT_ID,
            relativePath: "asset.md",
            reservationIdentityFingerprint: RESERVATION,
        };
        expect(decodeRestrictedSourceAuthority({ ...minimal, managedTargetGuards: [guard] })).not.toBeNull();
        expect(
            decodeRestrictedSourceAuthority({ ...minimal, managedTargetGuards: [{ ...guard, appliedContentHash: RESERVATION }] }),
        ).toBeNull();
        expect(() =>
            cloneRestrictedSourceSession({
                hostInstanceId: randomUUID(),
                sessionId: randomUUID(),
                platformContext: { ...h.context, platform: "linux" },
            }),
        ).toThrow(/session/);
        expect(fs.readFileSync(sourceFile, "utf8")).toBe("# Guidance\n");
        h.host.dispose();
    });
});
