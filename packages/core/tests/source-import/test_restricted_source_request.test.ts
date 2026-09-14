import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULT_ADAPTER_READ_OPERATION_LIMITS } from "../../src/adapters/adapter-read-budget";
import { isRestrictedSourceDiagnostics } from "../../src/source-import/restricted-source-diagnostics";
import {
    cloneRestrictedSourceSession,
    decodeRestrictedReadAuthorityIntent,
    decodeRestrictedSourceAuthority,
    decodeRestrictedSourceContinuation,
    decodeRestrictedSourceTarget,
} from "../../src/source-import/restricted-source-request";
import type { AdapterReadTarget, PlatformContext } from "../../src/types";
import { provider, root, target, sandbox } from "./fixtures/source-contract-test-fixtures";

const fingerprint = `sha256:${"b".repeat(64)}`;
function fixture(userSelected = false) {
    const selected = provider();
    const hostRoot = `\\\\wsl.localhost\\read-test${sandbox.replaceAll("/", "\\")}`;
    const context: PlatformContext = { platform: "wsl", platformInstanceId: "read-test", accessRootPath: hostRoot };
    const sourceRoot = root("root-1", `${hostRoot}\\source.md`);
    const selectedTarget: AdapterReadTarget = target([sourceRoot]);
    if (userSelected) {
        selectedTarget.sourceSelector = {
            selectorKind: "user_selected_root",
            platformContext: context,
            binding: { sourceRoot, assetScope: "project", projectRootPath: hostRoot },
        };
    } else {
        if (selectedTarget.sourceSelector.selectorKind !== "probe_roots") throw new Error("expected probe selector");
        const observation = selectedTarget.sourceSelector.observation;
        observation.platformContext = context;
        observation.observedAgentRuntimes[0]!.installationEvidence[0]!.path = `${hostRoot}\\bin`;
    }
    expect(decodeRestrictedSourceTarget(selectedTarget, selected, context)).toEqual(selectedTarget);
    return { selected, selectedTarget, context };
}
function set(value: unknown, field: string, replacement: unknown) {
    const segments = field.split(".");
    const key = segments.pop()!;
    let owner = value as Record<string, unknown>;
    for (const segment of segments) owner = owner[segment] as Record<string, unknown>;
    owner[key] = replacement;
}

describe("restricted source request identity and selector closure", () => {
    it("preserves a nonempty contracted suggested action and rejects an unknown action", () => {
        const diagnostic = {
            severity: "error",
            code: "read.failed",
            message: "retryable read failure",
            path: "",
            traceId: "",
            operation: "read",
            causeKind: "unavailable",
            retryable: true,
            suggestedActions: ["retry"],
            rawSummary: "",
        };
        expect(isRestrictedSourceDiagnostics([diagnostic])).toBe(true);
        expect(isRestrictedSourceDiagnostics([{ ...diagnostic, suggestedActions: ["execute_arbitrary_command"] }])).toBe(false);
        expect(diagnostic.suggestedActions).toEqual(["retry"]);
    });

    it("clones the exact session without retaining mutable caller references", () => {
        const { context } = fixture();
        const input = { hostInstanceId: randomUUID(), sessionId: randomUUID(), platformContext: context };
        const decoded = cloneRestrictedSourceSession(input);
        context.platformInstanceId = "changed";
        expect(decoded.platformContext.platformInstanceId).toBe("read-test");
    });
    it.each([
        ["hostInstanceId", "invalid"],
        ["sessionId", "invalid"],
        ["platformContext", null],
        ["platformContext.platform", "win32"],
        ["platformContext.platformInstanceId", ""],
        ["platformContext.accessRootPath", ""],
        ["platformContext.accessRootPath", "\\\\wsl.localhost\\other\\tmp"],
    ])("rejects an invalid session %s", (field, value) => {
        const input = { hostInstanceId: randomUUID(), sessionId: randomUUID(), platformContext: fixture().context };
        set(input, field as string, value);
        expect(() => cloneRestrictedSourceSession(input)).toThrow();
    });
    it("preserves optional probe fields and partial observations without installed runtime rows", () => {
        const { selectedTarget, selected, context } = fixture();
        delete selectedTarget.allowedKinds;
        if (selectedTarget.sourceSelector.selectorKind !== "probe_roots") throw new Error("expected probe selector");
        selectedTarget.sourceSelector.observation.environmentReferences = [];
        expect(decodeRestrictedSourceTarget(selectedTarget, selected, context)).toEqual(selectedTarget);
        selectedTarget.sourceSelector.observation.observedAgentRuntimes = [];
        expect(decodeRestrictedSourceTarget(selectedTarget, selected, context)).toEqual(selectedTarget);
    });
    it.each([
        ["adapterId", "OTHER"],
        ["allowedKinds", ["Guidance", "Guidance"]],
        ["allowedKinds", ["Other"]],
        ["sourceSelector.selectorKind", "arbitrary_path"],
        ["sourceSelector.sourceRootIds", ["root-1", "root-1"]],
        ["sourceSelector.observation.observedAgentRuntimes.0.agentRuntimeId", "UNREGISTERED"],
        ["sourceSelector.observation.sourceRoots.0.path", "\\\\wsl.localhost\\other\\tmp\\source.md"],
    ])("rejects a mismatched probe target %s", (field, value) => {
        const { selectedTarget, selected, context } = fixture();
        set(selectedTarget, field as string, value);
        expect(decodeRestrictedSourceTarget(selectedTarget, selected, context)).toBeNull();
    });
    it("accepts a global selected root only with the empty project locator", () => {
        const { selectedTarget, selected, context } = fixture(true);
        if (selectedTarget.sourceSelector.selectorKind !== "user_selected_root") throw new Error("expected selected root");
        const binding = selectedTarget.sourceSelector.binding;
        binding.assetScope = "global";
        expect(decodeRestrictedSourceTarget(selectedTarget, selected, context)).toBeNull();
        binding.projectRootPath = "";
        expect(decodeRestrictedSourceTarget(selectedTarget, selected, context)).toEqual(selectedTarget);
    });
    it.each([
        ["sourceSelector.extra", true],
        ["sourceSelector.platformContext.platform", "linux"],
        ["sourceSelector.platformContext.accessRootPath", "\\\\wsl.localhost\\read-test\\other"],
        ["sourceSelector.binding.extra", true],
        ["sourceSelector.binding.assetScope", "workspace"],
        ["sourceSelector.binding.projectRootPath", "\\\\wsl.localhost\\other\\tmp"],
        ["sourceSelector.binding.sourceRoot.extra", true],
        ["sourceSelector.binding.sourceRoot.sourceRootId", " "],
        ["sourceSelector.binding.sourceRoot.rootRole", "other"],
        ["sourceSelector.binding.sourceRoot.sourceDomain", "other"],
        ["sourceSelector.binding.sourceRoot.accessStatus", "other"],
        ["sourceSelector.binding.sourceRoot.diagnostics", null],
        ["sourceSelector.binding.sourceRoot.locatorEvidence", null],
        ["sourceSelector.binding.sourceRoot.locatorEvidence.0.locatorKind", "other"],
        ["sourceSelector.binding.sourceRoot.locatorEvidence.0.locatorKey", "bad\0key"],
        ["sourceSelector.binding.sourceRoot.locatorEvidence.0.evidenceLevel", "other"],
    ])("rejects malformed selected-root authority %s", (field, value) => {
        const { selectedTarget, selected, context } = fixture(true);
        set(selectedTarget, field as string, value);
        expect(decodeRestrictedSourceTarget(selectedTarget, selected, context)).toBeNull();
    });
});

function guard(matchKind = "entire_root", managementState = "active_managed") {
    const fingerprintKey =
        managementState === "in_flight_managed"
            ? "reservationIdentityFingerprint"
            : matchKind === "exact_file"
              ? "appliedContentHash"
              : "outputUnitFingerprint";
    return {
        sourceRootId: "root-1",
        deploymentId: randomUUID(),
        matchKind,
        managementState,
        [fingerprintKey]: fingerprint,
        ...(matchKind === "entire_root" ? {} : { relativePath: "child" }),
    };
}
const decodeGuards = (guards: unknown[]) =>
    decodeRestrictedSourceAuthority({ managedTargetGuards: guards, reservationIdentityFingerprints: [] });
describe("restricted source managed guards and authority continuations", () => {
    it.each([
        {
            matchKind: "exact_file",
            managementState: "active_managed",
            relativePath: "child",
            appliedContentHash: fingerprint,
        },
        {
            matchKind: "directory_prefix",
            managementState: "residual_managed",
            relativePath: "child",
            outputUnitFingerprint: fingerprint,
        },
        {
            matchKind: "entire_root",
            managementState: "in_flight_managed",
            reservationIdentityFingerprint: fingerprint,
        },
    ])("binds $managementState $matchKind to its semantic fingerprint field", (fields) => {
        const input = { sourceRootId: "root-1", deploymentId: randomUUID(), ...fields };
        expect(decodeGuards([input])?.managedTargetGuards).toEqual([input]);
        const damaged: Record<string, unknown> = { ...input };
        if (fields.matchKind === "exact_file") {
            delete damaged.appliedContentHash;
            damaged.outputUnitFingerprint = fingerprint;
        } else if (fields.matchKind === "directory_prefix") {
            delete damaged.outputUnitFingerprint;
            damaged.reservationIdentityFingerprint = fingerprint;
        } else {
            delete damaged.reservationIdentityFingerprint;
            damaged.appliedContentHash = fingerprint;
        }
        expect(decodeGuards([damaged])).toBeNull();
    });
    it.each(["active_managed", "residual_managed", "in_flight_managed"])("accepts exact guard fingerprints for %s", (state) => {
        for (const match of ["entire_root", "exact_file", "directory_prefix"]) {
            const input = { managedTargetGuards: [guard(match, state)], reservationIdentityFingerprints: [fingerprint] };
            expect(decodeRestrictedSourceAuthority(input)).toEqual(input);
        }
    });
    it.each([
        ["sourceRootId", ""],
        ["deploymentId", "invalid"],
        ["matchKind", "other"],
        ["managementState", "other"],
        ["outputUnitFingerprint", "invalid"],
        ["relativePath", "child"],
    ])("rejects malformed whole-root guard %s", (field, value) => {
        expect(decodeGuards([{ ...guard(), [field as string]: value }])).toBeNull();
    });
    it("rejects malformed guards, escaped partial paths and duplicate reservation identities", () => {
        expect(decodeGuards([null])).toBeNull();
        expect(decodeGuards(["invalid"])).toBeNull();
        expect(decodeGuards([{ ...guard("exact_file"), relativePath: "../escaped" }])).toBeNull();
        expect(
            decodeRestrictedSourceAuthority({
                managedTargetGuards: [],
                reservationIdentityFingerprints: [fingerprint, fingerprint],
            }),
        ).toBeNull();
    });
    it.each([
        { phase: "unknown", targets: [] },
        { phase: "access", targets: [] },
        { phase: "final_validate", targets: null },
        { phase: "access", targets: [{ sourceRootId: "r", relativePath: "", entryKind: "file", extra: true }] },
        { phase: "access", targets: [{ sourceRootId: "", relativePath: "", entryKind: "file" }] },
        { phase: "access", targets: [{ sourceRootId: "r", relativePath: "../escaped", entryKind: "file" }] },
        { phase: "access", targets: [{ sourceRootId: "r", relativePath: "", entryKind: "symlink" }] },
        { phase: "final_validate", targets: [], extra: true },
    ])("rejects malformed read authority intent: %j", (intent) => {
        expect(decodeRestrictedReadAuthorityIntent(intent)).toBeNull();
    });
    it("retains the original whole-read limit for final validation closures", () => {
        const maximum =
            DEFAULT_ADAPTER_READ_OPERATION_LIMITS.maxReadFiles + DEFAULT_ADAPTER_READ_OPERATION_LIMITS.maxListedDirectories;
        const intent = {
            phase: "final_validate",
            targets: Array.from({ length: maximum }, (_, index) => ({
                sourceRootId: "r",
                relativePath: `file-${index}`,
                entryKind: "file",
            })),
        };
        expect(decodeRestrictedReadAuthorityIntent(intent)).toEqual(intent);
        intent.targets.push({ sourceRootId: "r", relativePath: "overflow", entryKind: "file" });
        expect(decodeRestrictedReadAuthorityIntent(intent)).toBeNull();
    });
    it("keeps acquisition and release acknowledgements distinct", () => {
        const stepId = randomUUID();
        for (const permission of [
            { state: "held" },
            { state: "busy" },
            { state: "stale" },
            { state: "io_error", message: "denied" },
        ]) {
            const input = { stepId, intentFingerprint: fingerprint, permission };
            expect(decodeRestrictedSourceContinuation(input)).toEqual(input);
        }
        expect(decodeRestrictedSourceContinuation({ stepId, released: true })).toEqual({ stepId, released: true });
        for (const invalid of [
            null,
            "bad",
            { stepId: "invalid", released: true },
            { stepId, released: false },
            { stepId, permission: { state: "held" }, intentFingerprint: "invalid" },
            { stepId, permission: { state: "io_error", message: 1 }, intentFingerprint: fingerprint },
            { stepId, permission: null, intentFingerprint: fingerprint },
            { stepId, released: true, permission: { state: "held" }, intentFingerprint: fingerprint },
        ])
            expect(decodeRestrictedSourceContinuation(invalid)).toBeNull();
    });
});
