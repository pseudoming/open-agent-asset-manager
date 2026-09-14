/** Source-root and capability selection before provider dispatch. */

import type {
    AdapterAssetSourceCapability,
    AdapterProvider,
    AdapterReadTarget,
    ManagedTargetReadGuard,
    OperationDiagnostic,
    Platform,
    Sha256Digest,
    SourceRoot,
} from "../types";
import { fingerprintDomain, stableStringify } from "../foundation/fingerprint";
import { physicalAccessPathContains } from "@oaam/shared/paths";
import { BUILTIN_ASSET_KINDS } from "../specs/registry";
import { isCanonicalRelativePath, isSha256Digest, isUuidV4 } from "../foundation/validators";
import type { AdapterReadAuthorityContext, PreparedRead } from "./source-read-execution";
import { compareGuard, compareRoot, compareCodeUnitText, sourceDiagnostic, uniqueMap } from "./source-read-validation-helpers";

import { isValidReadAgentRuntimeSelection } from "./source-read-runtime-selection";

const READ_AUTHORITY_DOMAIN = "oaam.read.authority.v1";
const READ_OBLIGATION_DOMAIN = "oaam.read.source-obligation.v1";

export function computeReadAuthorityFingerprint(
    provider: Pick<AdapterProvider, "adapterId" | "version">,
    target: AdapterReadTarget,
    roots: readonly SourceRoot[],
    guards: readonly ManagedTargetReadGuard[],
    reservationIdentityFingerprints: readonly Sha256Digest[],
): Sha256Digest {
    return fingerprintDomain(READ_AUTHORITY_DOMAIN, {
        adapterId: provider.adapterId,
        providerVersion: provider.version,
        readTarget: target,
        sourceRoots: [...roots].sort(compareRoot),
        managedTargetGuards: [...guards].sort(compareGuard),
        reservationIdentityFingerprints: [...reservationIdentityFingerprints].sort(compareCodeUnitText),
    });
}
export function prepareRead(
    provider: AdapterProvider,
    target: AdapterReadTarget,
    authority: AdapterReadAuthorityContext,
): PreparedRead | { diagnostics: OperationDiagnostic[] } {
    const diagnostics: OperationDiagnostic[] = [];
    const selected = selectRoots(provider, target, diagnostics);
    validateAuthorityContext(selected.roots, authority, diagnostics);
    const allowedKinds = target.allowedKinds ?? [...BUILTIN_ASSET_KINDS];
    if (new Set(allowedKinds).size !== allowedKinds.length) {
        diagnostics.push(sourceDiagnostic("read.allowed_kind_duplicate", "allowedKinds must be unique"));
    }
    if (!isValidReadAgentRuntimeSelection(provider, target)) {
        diagnostics.push(
            sourceDiagnostic(
                "read.agent_runtime_selection_invalid",
                "selected runtime entries must be a nonempty unique subset of the Provider and selected source owners",
            ),
        );
        return { diagnostics };
    }
    const capabilities = selectCapabilities(provider, target, selected.roots, allowedKinds, diagnostics);
    const readAuthorityFingerprint = computeReadAuthorityFingerprint(
        provider,
        target,
        selected.roots,
        authority.managedTargetGuards,
        authority.reservationIdentityFingerprints,
    );
    const obligations = capabilities.map((capability, index) => ({
        sourceReadObligationId: fingerprintDomain(READ_OBLIGATION_DOMAIN, {
            readAuthorityFingerprint,
            sourceRootId: capability.root.sourceRootId,
            sourceCapabilityFingerprint: capability.capability.sourceCapabilityFingerprint,
            index,
        }),
        sourceRootId: capability.root.sourceRootId,
        sourceCapabilityFingerprint: capability.capability.sourceCapabilityFingerprint,
    }));
    if (diagnostics.length > 0) return { diagnostics };
    return {
        platform: selected.platform,
        roots: selected.roots,
        obligations,
        capabilities: capabilities.map((item) => item.capability),
        readAuthorityFingerprint,
    };
}

function selectRoots(
    provider: AdapterProvider,
    target: AdapterReadTarget,
    diagnostics: OperationDiagnostic[],
): { platform: Platform; roots: SourceRoot[] } {
    const selector = target.sourceSelector;
    if (selector.selectorKind === "user_selected_root") {
        const root = selector.binding.sourceRoot;
        validateSelectedRoot(root, selector.platformContext.accessRootPath, diagnostics);
        if (selector.binding.assetScope === "global" && selector.binding.projectRootPath !== "") {
            diagnostics.push(sourceDiagnostic("read.user_root_scope_invalid", "global binding cannot carry a project root"));
        }
        if (
            selector.binding.assetScope === "project" &&
            !physicalAccessPathContains(selector.platformContext.accessRootPath, selector.binding.projectRootPath)
        ) {
            diagnostics.push(
                sourceDiagnostic(
                    "read.user_root_project_invalid",
                    "project binding requires a canonical project root inside the selected access root",
                ),
            );
        }
        return { platform: selector.platformContext.platform, roots: [root] };
    }
    if (selector.observation.adapterId !== provider.adapterId || target.adapterId !== provider.adapterId) {
        diagnostics.push(sourceDiagnostic("read.adapter_identity_mismatch", "read target/provider identity mismatch"));
    }
    const descriptors = new Set(provider.agentRuntimes.map((descriptor) => descriptor.agentRuntimeId));
    for (const runtime of selector.observation.observedAgentRuntimes) {
        if (!descriptors.has(runtime.agentRuntimeId)) {
            diagnostics.push(sourceDiagnostic("read.runtime_identity_mismatch", "observation contains a foreign agent runtime"));
        }
    }
    const roots = uniqueMap(
        selector.observation.sourceRoots,
        (root) => root.sourceRootId,
        "read.observation_root_duplicate",
        diagnostics,
    );
    if (new Set(selector.sourceRootIds).size !== selector.sourceRootIds.length) {
        diagnostics.push(sourceDiagnostic("read.selected_root_duplicate", "sourceRootIds must be unique"));
    }
    const selected: SourceRoot[] = [];
    for (const rootId of selector.sourceRootIds) {
        const root = roots.get(rootId);
        if (root === undefined) {
            diagnostics.push(sourceDiagnostic("read.selected_root_missing", `selected root is missing: ${rootId}`));
        } else {
            validateSelectedRoot(root, selector.observation.platformContext.accessRootPath, diagnostics);
            selected.push(root);
        }
    }
    return { platform: selector.observation.platformContext.platform, roots: selected };
}

function selectCapabilities(
    provider: AdapterProvider,
    target: AdapterReadTarget,
    roots: SourceRoot[],
    allowedKinds: readonly string[],
    diagnostics: OperationDiagnostic[],
): Array<{ root: SourceRoot; capability: AdapterAssetSourceCapability }> {
    const selected: Array<{ root: SourceRoot; capability: AdapterAssetSourceCapability }> = [];
    for (const root of roots) {
        const owners =
            target.sourceSelector.selectorKind === "probe_roots"
                ? new Set(
                      target.sourceSelector.observation.observedAgentRuntimes
                          .filter((runtime) => runtime.sourceRootIds.includes(root.sourceRootId))
                          .map((runtime) => runtime.agentRuntimeId),
                  )
                : new Set(provider.agentRuntimes.map((runtime) => runtime.agentRuntimeId));
        const rows = provider.assetSourceCapabilities.filter(
            (capability) =>
                owners.has(capability.agentRuntimeId) &&
                (target.agentRuntimeIds === undefined || target.agentRuntimeIds.includes(capability.agentRuntimeId)) &&
                capability.entrySupportStatus === "supported" &&
                capability.rootRole === root.rootRole &&
                capability.sourceDomain === root.sourceDomain &&
                root.locatorEvidence.some((evidence) => evidence.locatorKind === capability.rootLocatorKind) &&
                allowedKinds.includes(capability.assetKind) &&
                (target.sourceSelector.selectorKind === "probe_roots"
                    ? capability.readPolicy === "auto_read"
                    : capability.readPolicy === "user_selected_root_only"),
        );
        if (rows.length === 0) {
            diagnostics.push(
                sourceDiagnostic(
                    "read.source_capability_unavailable",
                    `selected root has no exact supported source capability: ${root.sourceRootId}`,
                ),
            );
        }
        for (const capability of rows) selected.push({ root, capability });
    }
    selected.sort((left, right) =>
        compareCodeUnitText(
            `${left.root.sourceRootId}\0${left.capability.sourceCapabilityFingerprint}`,
            `${right.root.sourceRootId}\0${right.capability.sourceCapabilityFingerprint}`,
        ),
    );
    return selected;
}

function validateAuthorityContext(
    roots: readonly SourceRoot[],
    authority: AdapterReadAuthorityContext,
    diagnostics: OperationDiagnostic[],
): void {
    const rootIds = new Set(roots.map((root) => root.sourceRootId));
    const guardKeys = new Set<string>();
    for (const guard of authority.managedTargetGuards) {
        if (!rootIds.has(guard.sourceRootId)) {
            diagnostics.push(sourceDiagnostic("read.guard_root_foreign", "managed guard references an unselected root"));
        }
        if (guard.matchKind !== "entire_root" && !isCanonicalRelativePath(guard.relativePath)) {
            diagnostics.push(sourceDiagnostic("read.guard_path_invalid", "managed guard path is not canonical"));
        }
        const authorityFingerprint =
            guard.managementState === "in_flight_managed"
                ? guard.reservationIdentityFingerprint
                : guard.matchKind === "exact_file"
                  ? guard.appliedContentHash
                  : guard.outputUnitFingerprint;
        if (!isUuidV4(guard.deploymentId) || !isSha256Digest(authorityFingerprint)) {
            diagnostics.push(
                sourceDiagnostic(
                    "read.guard_authority_invalid",
                    "managed guard requires a valid deployment and authority fingerprint",
                ),
            );
        }
        const key = stableStringify(guard);
        if (guardKeys.has(key)) diagnostics.push(sourceDiagnostic("read.guard_duplicate", "managed guards must be unique"));
        guardKeys.add(key);
    }
    if (
        new Set(authority.reservationIdentityFingerprints).size !== authority.reservationIdentityFingerprints.length ||
        authority.reservationIdentityFingerprints.some((value) => !isSha256Digest(value))
    ) {
        diagnostics.push(
            sourceDiagnostic("read.reservation_identity_invalid", "reservation identities must be unique SHA-256 digests"),
        );
    }
    if (authority.transactionsRoot === "") {
        diagnostics.push(sourceDiagnostic("read.lock_root_missing", "transactionsRoot is required for physical locks"));
    }
}

function validateSelectedRoot(root: SourceRoot, accessRootPath: string, diagnostics: OperationDiagnostic[]): void {
    if (!physicalAccessPathContains(accessRootPath, root.path)) {
        diagnostics.push(
            sourceDiagnostic(
                "read.root_path_invalid",
                `root path is not canonical within the selected access root: ${root.sourceRootId}`,
            ),
        );
    }
    if (root.accessStatus !== "available") {
        diagnostics.push(sourceDiagnostic("read.root_not_available", `selected root is not available: ${root.sourceRootId}`));
    }
}
