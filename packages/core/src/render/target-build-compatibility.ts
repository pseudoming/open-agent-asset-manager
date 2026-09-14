/** Bounded Provider-declared routing from a current target build to an exact evidence anchor. */

import type { AdapterTargetBuildCompatibilityPolicyV1, AgentRuntimeId, Platform, Sha256Digest } from "../types";
import { compareUtf8Bytes } from "../foundation/text-order";
import { isSha256Digest } from "../foundation/validators";

export interface TargetBuildCompatibilityAnchor {
    agentRuntimeId: AgentRuntimeId;
    versionText: string;
    buildIdentity: Sha256Digest;
    platform: Platform;
}

export interface CurrentTargetBuildIdentity extends TargetBuildCompatibilityAnchor {}

export type TargetBuildCompatibilityResolution<TAnchor extends TargetBuildCompatibilityAnchor> =
    | { status: "exact"; anchor: TAnchor; reason: "exact_verified_build" }
    | {
          status: "compatible";
          anchor: TAnchor;
          reason: "newer_build" | "same_version_unverified_build" | "unknown_version_build";
      }
    | {
          status: "blocked";
          reason:
              | "invalid_candidate"
              | "invalid_policy"
              | "denied_build"
              | "no_platform_anchor"
              | "older_than_earliest_anchor"
              | "unknown_version_blocked"
              | "ambiguous_anchor";
          denyReasonCode?: string;
      };

export function resolveTargetBuildCompatibility<TAnchor extends TargetBuildCompatibilityAnchor>(input: {
    anchors: readonly TAnchor[];
    policy?: AdapterTargetBuildCompatibilityPolicyV1;
    current: CurrentTargetBuildIdentity;
}): TargetBuildCompatibilityResolution<TAnchor> {
    const { current } = input;
    if (
        current.versionText.trim() !== current.versionText ||
        current.versionText === "" ||
        current.versionText.includes("\0") ||
        !isSha256Digest(current.buildIdentity)
    ) {
        return { status: "blocked", reason: "invalid_candidate" };
    }
    if (input.policy !== undefined && !isValidTargetBuildCompatibilityPolicy(input.policy)) {
        return { status: "blocked", reason: "invalid_policy" };
    }
    const deny = input.policy?.deniedBuilds.find(
        (candidate) => candidate.versionText === current.versionText && candidate.buildIdentity === current.buildIdentity,
    );
    if (deny !== undefined) {
        return { status: "blocked", reason: "denied_build", denyReasonCode: deny.reasonCode };
    }
    const anchors = input.anchors.filter(
        (anchor) => anchor.agentRuntimeId === current.agentRuntimeId && anchor.platform === current.platform,
    );
    const exact = anchors.filter(
        (anchor) => anchor.versionText === current.versionText && anchor.buildIdentity === current.buildIdentity,
    );
    if (exact.length === 1) {
        return { status: "exact", anchor: exact[0] as TAnchor, reason: "exact_verified_build" };
    }
    if (exact.length > 1) return { status: "blocked", reason: "ambiguous_anchor" };
    if (anchors.length === 0) return { status: "blocked", reason: "no_platform_anchor" };
    if (input.policy === undefined) return { status: "blocked", reason: "unknown_version_blocked" };

    const currentVersion = parseNumericDottedCore(current.versionText);
    if (currentVersion === null) {
        if (input.policy.unknownVersionPolicy === "block") {
            return { status: "blocked", reason: "unknown_version_blocked" };
        }
        const anchor = selectUnknownVersionAnchor(anchors, current.versionText);
        return anchor === null
            ? { status: "blocked", reason: "ambiguous_anchor" }
            : { status: "compatible", anchor, reason: "unknown_version_build" };
    }

    const comparable = anchors.flatMap((anchor) => {
        const version = parseNumericDottedCore(anchor.versionText);
        return version === null ? [] : [{ anchor, version }];
    });
    if (comparable.length === 0) {
        if (input.policy.unknownVersionPolicy === "block") {
            return { status: "blocked", reason: "unknown_version_blocked" };
        }
        const anchor = selectUnknownVersionAnchor(anchors, current.versionText);
        return anchor === null
            ? { status: "blocked", reason: "ambiguous_anchor" }
            : { status: "compatible", anchor, reason: "unknown_version_build" };
    }
    const eligible = comparable.filter((candidate) => compareNumericVersions(candidate.version, currentVersion) <= 0);
    if (eligible.length === 0) return { status: "blocked", reason: "older_than_earliest_anchor" };
    eligible.sort((left, right) => {
        const versionOrder = compareNumericVersions(right.version, left.version);
        return versionOrder !== 0 ? versionOrder : compareUtf8Bytes(anchorIdentity(left.anchor), anchorIdentity(right.anchor));
    });
    const newestVersion = (eligible as [(typeof eligible)[number], ...Array<(typeof eligible)[number]>])[0].version;
    const nearest = eligible.filter((candidate) => compareNumericVersions(candidate.version, newestVersion) === 0);
    const rawVersionMatches = nearest.filter((candidate) => candidate.anchor.versionText === current.versionText);
    const selected = rawVersionMatches.length === 1 ? rawVersionMatches[0] : nearest.length === 1 ? nearest[0] : null;
    if (selected === null) return { status: "blocked", reason: "ambiguous_anchor" };
    return {
        status: "compatible",
        anchor: selected.anchor,
        reason: compareNumericVersions(selected.version, currentVersion) < 0 ? "newer_build" : "same_version_unverified_build",
    };
}

export function isValidTargetBuildCompatibilityPolicy(policy: AdapterTargetBuildCompatibilityPolicyV1): boolean {
    if (
        policy.schemaVersion !== 1 ||
        policy.versionOrdering !== "numeric_dotted_core_v1" ||
        (policy.unknownVersionPolicy !== "allow_with_warning" && policy.unknownVersionPolicy !== "block") ||
        !Array.isArray(policy.deniedBuilds)
    ) {
        return false;
    }
    const keys = policy.deniedBuilds.map((deny) => {
        if (
            deny.versionText.trim() !== deny.versionText ||
            deny.versionText === "" ||
            deny.versionText.includes("\0") ||
            !isSha256Digest(deny.buildIdentity) ||
            !/^[a-z][a-z0-9_]{0,127}$/u.test(deny.reasonCode)
        ) {
            return null;
        }
        return `${deny.versionText}\0${deny.buildIdentity}\0${deny.reasonCode}`;
    });
    if (keys.some((key) => key === null)) return false;
    const values = keys as string[];
    return (
        new Set(values).size === values.length &&
        values.every((value, index) => index === 0 || compareUtf8Bytes(values[index - 1] as string, value) < 0)
    );
}

function selectUnknownVersionAnchor<TAnchor extends TargetBuildCompatibilityAnchor>(
    anchors: readonly TAnchor[],
    currentVersionText: string,
): TAnchor | null {
    const rawMatches = anchors.filter((anchor) => anchor.versionText === currentVersionText);
    if (rawMatches.length === 1) return rawMatches[0] as TAnchor;
    if (rawMatches.length > 1) return null;
    if (anchors.length === 1) return anchors[0] as TAnchor;
    const comparable = anchors.flatMap((anchor) => {
        const version = parseNumericDottedCore(anchor.versionText);
        return version === null ? [] : [{ anchor, version }];
    });
    if (comparable.length === 0) return null;
    comparable.sort((left, right) => compareNumericVersions(right.version, left.version));
    const newest = (comparable as [(typeof comparable)[number], ...Array<(typeof comparable)[number]>])[0].version;
    const nearest = comparable.filter((candidate) => compareNumericVersions(candidate.version, newest) === 0);
    return nearest.length === 1 ? (nearest as [(typeof nearest)[number]])[0].anchor : null;
}

function parseNumericDottedCore(value: string): readonly number[] | null {
    const match = /^([0-9]+(?:\.[0-9]+)*)(?:[-+].*)?$/u.exec(value);
    if (match?.[1] === undefined) return null;
    const values = match[1].split(".").map(Number);
    return values.length <= 16 && values.every((item) => Number.isSafeInteger(item)) ? values : null;
}

function compareNumericVersions(left: readonly number[], right: readonly number[]): number {
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
        const leftValue = left[index] ?? 0;
        const rightValue = right[index] ?? 0;
        if (leftValue !== rightValue) return leftValue < rightValue ? -1 : 1;
    }
    return 0;
}

function anchorIdentity(anchor: TargetBuildCompatibilityAnchor): string {
    return [anchor.agentRuntimeId, anchor.versionText, anchor.buildIdentity, anchor.platform].join("\0");
}
