import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
    PROTOCOL_DIAGNOSTIC_CAUSES,
    PROTOCOL_DIAGNOSTIC_OPERATIONS,
    PROTOCOL_SUGGESTED_ACTIONS,
} from "../../packages/app-server/protocol/src";
import type { OperationDiagnostic, SuggestedAction } from "../../packages/core/src/types";

type IsExact<TLeft, TRight> =
    (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2
        ? (<T>() => T extends TRight ? 1 : 2) extends <T>() => T extends TLeft ? 1 : 2
            ? true
            : false
        : false;

type ProtocolCoreOperation = Exclude<(typeof PROTOCOL_DIAGNOSTIC_OPERATIONS)[number], "host" | "protocol">;
const EXACT_OPERATION_PROJECTION: IsExact<ProtocolCoreOperation, OperationDiagnostic["operation"]> = true;
const EXACT_CAUSE_PROJECTION: IsExact<(typeof PROTOCOL_DIAGNOSTIC_CAUSES)[number], OperationDiagnostic["causeKind"]> = true;
const EXACT_ACTION_PROJECTION: IsExact<(typeof PROTOCOL_SUGGESTED_ACTIONS)[number], SuggestedAction> = true;

describe("Client Protocol mirrors the exact browser-safe Core diagnostic vocabulary", () => {
    it("keeps compile-time equality and runtime literal inventories", () => {
        expect(EXACT_OPERATION_PROJECTION).toBe(true);
        expect(EXACT_CAUSE_PROJECTION).toBe(true);
        expect(EXACT_ACTION_PROJECTION).toBe(true);
        expect(PROTOCOL_DIAGNOSTIC_OPERATIONS).toEqual([
            "project",
            "asset",
            "version",
            "probe",
            "read",
            "render",
            "deploy",
            "scan",
            "search",
            "reindex",
            "settings",
            "backup",
            "restore",
            "reverse_accept",
            "internal",
            "host",
            "protocol",
        ]);
        expect(PROTOCOL_DIAGNOSTIC_CAUSES).toEqual([
            "not_found",
            "unavailable",
            "permission_denied",
            "version_incompatible",
            "partial",
            "invalid_schema",
            "unsupported",
            "conflict",
            "verification_failed",
            "internal_error",
        ]);
        expect(PROTOCOL_SUGGESTED_ACTIONS).toEqual([
            "retry",
            "grant_permission",
            "install_runtime",
            "upgrade_runtime",
            "upgrade_adapter",
            "choose_target",
            "rebuild_deployment",
            "skip",
            "contact_support",
        ]);
    });

    it("keeps the Protocol package free of OAAM workspace dependencies", () => {
        const manifest = JSON.parse(
            fs.readFileSync(path.resolve(__dirname, "../../packages/app-server/protocol/package.json"), "utf8"),
        ) as Record<string, unknown>;
        expect(manifest.dependencies).toBeUndefined();
        expect(manifest.peerDependencies).toBeUndefined();
        expect(manifest.optionalDependencies).toBeUndefined();
    });
});
