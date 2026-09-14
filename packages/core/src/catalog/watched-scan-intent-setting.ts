/** Strict codec and canonical construction for the watched-scan reserved setting. */

import {
    computeWatchedScanIntentSettingFingerprint,
    computeWatchedSourceSelectorFingerprint,
    stableStringify,
} from "../foundation/fingerprint";
import { compareCodeUnitText } from "../foundation/fingerprint-base";
import { hasExactKeys, isNonNegativeInteger, isSha256Digest, isStrictObject, isUuidV4 } from "../foundation/validators";
import { isCanonicalPhysicalAccessPath } from "@oaam/shared/paths";
import type {
    AgentRuntimeId,
    SettingValue,
    Sha256Digest,
    UuidV4,
    WatchedEnvironmentIntentV1,
    WatchedEnvironmentSelectorV1,
    WatchedScanIntentV1,
    WatchedSourceIdentityV1,
    WatchedSourceSelectorV1,
} from "../types";

export const WATCHED_SCAN_INTENT_KEY = "core.watched_scan_intent_v1";
export const WATCHED_SCAN_INTENT_SETTING_ID = "watched_scan_intent_v1";

type WatchedIntentPreimage = WatchedScanIntentV1 extends infer T
    ? T extends { settingFingerprint: Sha256Digest }
        ? Omit<T, "settingFingerprint">
        : never
    : never;

type WatchedSelectorPreimage = WatchedSourceSelectorV1 extends infer T
    ? T extends { selectorFingerprint: Sha256Digest }
        ? Omit<T, "selectorFingerprint">
        : never
    : never;

const PLATFORMS = new Set(["win32", "darwin", "linux", "wsl"]);
const ROOT_ROLES = new Set(["config", "source", "project_actual", "unknown"]);
const SOURCE_DOMAINS = new Set([
    "family_shared",
    "agent_runtime_private",
    "project_root",
    "project_keyed",
    "external_managed",
    "unknown",
]);
const ROOT_LOCATOR_KINDS = new Set([
    "runtime_known_rule",
    "runtime_declared_path",
    "project_registry_entry",
    "user_provided_path",
    "unknown",
]);

export function virginWatchedScanIntentAuthority(): WatchedScanIntentV1 {
    const preimage: WatchedIntentPreimage = {
        configVersion: 1,
        settingId: WATCHED_SCAN_INTENT_SETTING_ID,
        revision: 0,
        environments: [],
        updatedAt: 0,
    };
    return {
        ...preimage,
        settingFingerprint: computeWatchedScanIntentSettingFingerprint(preimage),
    };
}

export function buildWatchedScanIntentAuthority(input: {
    currentRevision: number;
    environments: readonly WatchedEnvironmentIntentV1[];
    userActionEvidenceId: string;
    updatedAt: number;
}): WatchedScanIntentV1 {
    requireEvidence(input.userActionEvidenceId);
    if (!Number.isInteger(input.currentRevision) || input.currentRevision < 0) {
        throw new Error("current watched-scan revision must be a non-negative integer");
    }
    if (!Number.isInteger(input.updatedAt) || input.updatedAt <= 0) {
        throw new Error("watched-scan updatedAt must be a positive epoch-ms integer");
    }
    const environments = canonicalWatchedEnvironments(input.environments);
    const preimage: WatchedIntentPreimage = {
        configVersion: 1,
        settingId: WATCHED_SCAN_INTENT_SETTING_ID,
        revision: input.currentRevision + 1,
        environments,
        userActionEvidenceId: input.userActionEvidenceId,
        updatedAt: input.updatedAt,
    };
    return {
        ...preimage,
        settingFingerprint: computeWatchedScanIntentSettingFingerprint(preimage),
    };
}

export function buildWatchedSourceSelector(
    selector: WatchedSelectorPreimage,
    environment: WatchedEnvironmentSelectorV1,
): WatchedSourceSelectorV1 {
    const canonical = canonicalSelectorPreimage(selector);
    return {
        ...canonical,
        selectorFingerprint: computeWatchedSourceSelectorFingerprint(environment, canonical),
    } as WatchedSourceSelectorV1;
}

export function validateStoredWatchedScanIntent(value: SettingValue): asserts value is WatchedScanIntentV1 & SettingValue {
    if (!isStrictObject(value)) throw new Error("watched-scan intent must be an object");
    if (
        !hasExactKeys(value, [
            "configVersion",
            "settingId",
            "revision",
            "environments",
            "userActionEvidenceId",
            "updatedAt",
            "settingFingerprint",
        ])
    ) {
        throw new Error("stored watched-scan intent has missing or undeclared fields");
    }
    if (value.configVersion !== 1 || value.settingId !== WATCHED_SCAN_INTENT_SETTING_ID) {
        throw new Error("stored watched-scan intent identity is invalid");
    }
    if (!Number.isInteger(value.revision) || (value.revision as number) < 1) {
        throw new Error("stored watched-scan revision must be a positive integer");
    }
    if (!Array.isArray(value.environments)) throw new Error("watched-scan environments must be an array");
    const environments = canonicalWatchedEnvironments(value.environments as WatchedEnvironmentIntentV1[]);
    if (!jsonEqual(environments, value.environments)) {
        throw new Error("stored watched-scan environments must be canonical sorted and unique");
    }
    requireEvidence(value.userActionEvidenceId);
    if (!isNonNegativeInteger(value.updatedAt) || value.updatedAt === 0) {
        throw new Error("stored watched-scan updatedAt must be positive");
    }
    if (!isSha256Digest(value.settingFingerprint)) {
        throw new Error("stored watched-scan fingerprint is invalid");
    }
    const preimage: WatchedIntentPreimage = {
        configVersion: 1,
        settingId: WATCHED_SCAN_INTENT_SETTING_ID,
        revision: value.revision as number,
        environments,
        userActionEvidenceId: value.userActionEvidenceId as string,
        updatedAt: value.updatedAt as number,
    };
    if (computeWatchedScanIntentSettingFingerprint(preimage) !== value.settingFingerprint) {
        throw new Error("stored watched-scan fingerprint mismatch");
    }
}

export function canonicalWatchedEnvironments(input: readonly WatchedEnvironmentIntentV1[]): WatchedEnvironmentIntentV1[] {
    if (!Array.isArray(input)) throw new Error("watched-scan environments must be an array");
    const environments = input.map((environment) => canonicalEnvironment(environment));
    environments.sort((left, right) => compareCodeUnitText(environmentKey(left), environmentKey(right)));
    if (new Set(environments.map(environmentKey)).size !== environments.length) {
        throw new Error("watched-scan environments must be unique");
    }
    return environments;
}

export function canonicalWatchedSourceIdentity(source: WatchedSourceIdentityV1): WatchedSourceIdentityV1 {
    if (
        !isStrictObject(source) ||
        !hasExactKeys(source, ["adapterId", "rootRole", "sourceDomain", "canonicalPath", "locatorIdentities"])
    ) {
        throw new Error("watched source identity has missing or undeclared fields");
    }
    requireNonBlank(source.adapterId, "watched source adapterId");
    requireAllowed(source.rootRole, ROOT_ROLES, "watched source rootRole");
    requireAllowed(source.sourceDomain, SOURCE_DOMAINS, "watched source sourceDomain");
    if (!Array.isArray(source.locatorIdentities) || source.locatorIdentities.length === 0) {
        throw new Error("watched source requires locator identities");
    }
    const locatorIdentities = source.locatorIdentities.map((locator) => {
        if (!isStrictObject(locator) || !hasExactKeys(locator, ["locatorKind", "locatorKey"])) {
            throw new Error("watched source locator has missing or undeclared fields");
        }
        requireAllowed(locator.locatorKind, ROOT_LOCATOR_KINDS, "watched source locatorKind");
        requireNonBlank(locator.locatorKey, "watched source locatorKey");
        return { locatorKind: locator.locatorKind, locatorKey: locator.locatorKey };
    });
    locatorIdentities.sort((left, right) =>
        compareCodeUnitText(`${left.locatorKind}\0${left.locatorKey}`, `${right.locatorKind}\0${right.locatorKey}`),
    );
    const locatorKeys = locatorIdentities.map((locator) => `${locator.locatorKind}\0${locator.locatorKey}`);
    if (new Set(locatorKeys).size !== locatorKeys.length) {
        throw new Error("watched source locator identities must be unique");
    }
    return {
        adapterId: source.adapterId,
        rootRole: source.rootRole,
        sourceDomain: source.sourceDomain,
        canonicalPath: source.canonicalPath,
        locatorIdentities,
    };
}

function canonicalEnvironment(input: WatchedEnvironmentIntentV1): WatchedEnvironmentIntentV1 {
    if (!isStrictObject(input) || !hasExactKeys(input, ["environment", "sourceSelectors"])) {
        throw new Error("watched environment has missing or undeclared fields");
    }
    if (!isStrictObject(input.environment) || !hasExactKeys(input.environment, ["platform", "platformInstanceId"])) {
        throw new Error("watched environment selector has missing or undeclared fields");
    }
    requireAllowed(input.environment.platform, PLATFORMS, "watched environment platform");
    requireNonBlank(input.environment.platformInstanceId, "watched environment platformInstanceId");
    if (!Array.isArray(input.sourceSelectors) || input.sourceSelectors.length === 0) {
        throw new Error("watched environment requires sourceSelectors");
    }
    const sourceSelectors = input.sourceSelectors.map((selector) => validateAndCanonicalizeSelector(selector, input.environment));
    sourceSelectors.sort((left, right) => compareCodeUnitText(left.selectorFingerprint, right.selectorFingerprint));
    if (new Set(sourceSelectors.map((selector) => selector.selectorFingerprint)).size !== sourceSelectors.length) {
        throw new Error("watched source selectors must be unique");
    }
    return {
        environment: {
            platform: input.environment.platform,
            platformInstanceId: input.environment.platformInstanceId,
        },
        sourceSelectors,
    };
}

function validateAndCanonicalizeSelector(
    selector: WatchedSourceSelectorV1,
    environment: WatchedEnvironmentSelectorV1,
): WatchedSourceSelectorV1 {
    if (!isStrictObject(selector) || !isSha256Digest(selector.selectorFingerprint)) {
        throw new Error("watched source selector is invalid");
    }
    const allowedKeys =
        selector.disposition === "included"
            ? ["disposition", "source", "agentRuntimeIds", "binding", "selectorFingerprint"]
            : ["disposition", "source", "agentRuntimeIds", "selectorFingerprint"];
    if (!hasExactKeys(selector, allowedKeys) || (selector.disposition !== "included" && selector.disposition !== "excluded")) {
        throw new Error("watched source selector has missing or undeclared fields");
    }
    const { selectorFingerprint: _fingerprint, ...preimage } = selector;
    const canonical = canonicalSelectorPreimage(preimage as WatchedSelectorPreimage);
    const fingerprint = computeWatchedSourceSelectorFingerprint(environment, canonical);
    if (fingerprint !== selector.selectorFingerprint) throw new Error("watched source selector fingerprint mismatch");
    return { ...canonical, selectorFingerprint: fingerprint } as WatchedSourceSelectorV1;
}

function canonicalSelectorPreimage(selector: WatchedSelectorPreimage): WatchedSelectorPreimage {
    const source = canonicalWatchedSourceIdentity(selector.source);
    const agentRuntimeIds = canonicalRuntimeIds(selector.agentRuntimeIds);
    if (agentRuntimeIds.length === 0) throw new Error("watched source selector requires agentRuntimeIds");
    if (!isCanonicalPhysicalAccessPath(source.canonicalPath)) {
        throw new Error("watched source canonicalPath is invalid for its environment");
    }
    if (selector.disposition === "excluded") {
        return { disposition: "excluded", source, agentRuntimeIds };
    }
    if (source.rootRole === "unknown" || source.sourceDomain === "unknown") {
        throw new Error("included watched source cannot retain unknown role or domain");
    }
    if (source.locatorIdentities.some((locator) => locator.locatorKind === "unknown")) {
        throw new Error("included watched source cannot retain an unknown locator");
    }
    return {
        disposition: "included",
        source,
        agentRuntimeIds,
        binding: canonicalBinding(selector.binding),
    };
}

function canonicalBinding(
    binding: WatchedSourceSelectorV1 extends infer T ? (T extends { binding: infer B } ? B : never) : never,
): { assetScope: "global" } | { assetScope: "project"; projectId: UuidV4 } {
    if (!isStrictObject(binding)) throw new Error("watched source binding must be an object");
    if (binding.assetScope === "global" && hasExactKeys(binding, ["assetScope"])) return { assetScope: "global" };
    if (binding.assetScope === "project" && hasExactKeys(binding, ["assetScope", "projectId"]) && isUuidV4(binding.projectId)) {
        return { assetScope: "project", projectId: binding.projectId };
    }
    throw new Error("watched source binding is invalid");
}

function canonicalRuntimeIds(value: unknown): AgentRuntimeId[] {
    if (!Array.isArray(value)) throw new Error("agentRuntimeIds must be an array");
    const ids = value.map((item) => {
        requireNonBlank(item, "agentRuntimeId");
        return item as AgentRuntimeId;
    });
    ids.sort(compareCodeUnitText);
    if (new Set(ids).size !== ids.length) throw new Error("agentRuntimeIds must be unique");
    return ids;
}

function environmentKey(value: WatchedEnvironmentIntentV1): string {
    return `${value.environment.platform}\0${value.environment.platformInstanceId}`;
}

function requireAllowed(value: unknown, allowed: ReadonlySet<string>, label: string): asserts value is string {
    if (typeof value !== "string" || !allowed.has(value)) throw new Error(`${label} is invalid`);
}

function requireNonBlank(value: unknown, label: string): asserts value is string {
    if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
        throw new Error(`${label} must be non-blank`);
    }
}

function requireEvidence(value: unknown): asserts value is string {
    requireNonBlank(value, "userActionEvidenceId");
}

function jsonEqual(left: unknown, right: unknown): boolean {
    return stableStringify(left) === stableStringify(right);
}
