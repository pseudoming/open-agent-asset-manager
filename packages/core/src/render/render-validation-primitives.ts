/** Strict JSON and scalar validation primitives shared by render authority codecs. */

import type { EpochMillis, Sha256Digest, UuidV4 } from "../contracts/primitives";
import { stableStringify } from "../foundation/fingerprint";
import {
    hasExactKeys,
    isCanonicalRelativePath,
    isNonNegativeInteger,
    isSha256Digest,
    isStrictObject,
    isUuidV4,
} from "../foundation/validators";

export function requireSameOrderedKeys(left: readonly string[], right: readonly string[], label: string): void {
    if (stableStringify(left) !== stableStringify(right)) {
        throw new Error(`${label} must be a complete one-to-one closure`);
    }
}

export function requireSortedUnique(values: readonly unknown[], keyOf: (value: unknown) => string, label: string): void {
    let previous: string | undefined;
    for (const value of values) {
        const key = keyOf(value);
        if (previous !== undefined && key <= previous) {
            throw new Error(`${label} must be strictly sorted and unique`);
        }
        previous = key;
    }
}

export function requireArray(value: unknown, label: string): unknown[] {
    if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
    return value;
}

export function requireObject(value: unknown, label: string): Record<string, unknown> {
    if (!isStrictObject(value)) throw new Error(`${label} must be an object`);
    return value;
}

export function requireExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
    if (!hasExactKeys(value, allowed)) {
        throw new Error(`${label} has missing or undeclared fields`);
    }
}

export function requireFingerprint(value: unknown, label: string): asserts value is Sha256Digest {
    if (!isSha256Digest(value)) throw new Error(`${label} must be a SHA-256 digest`);
}

export function requireUuid(value: unknown, label: string): asserts value is UuidV4 {
    if (!isUuidV4(value)) throw new Error(`${label} must be a UUID v4`);
}

export function requirePath(value: unknown, label: string): void {
    if (!isCanonicalRelativePath(value)) {
        throw new Error(`${label} must be a canonical POSIX-relative path`);
    }
}

export function requireNonBlank(value: unknown, label: string): asserts value is string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`${label} must be non-blank`);
    }
}

export function requireBoolean(value: unknown, label: string): asserts value is boolean {
    if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
}

export function requirePositiveInteger(value: unknown, label: string): asserts value is number {
    if (!Number.isInteger(value) || (value as number) < 1) {
        throw new Error(`${label} must be a positive integer`);
    }
}

export function requireEpoch(value: unknown, label: string): asserts value is EpochMillis {
    if (!isNonNegativeInteger(value)) {
        throw new Error(`${label} must be a non-negative epoch-ms integer`);
    }
}

export function requireOneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): asserts value is T {
    if (typeof value !== "string" || !allowed.includes(value as T)) {
        throw new Error(`${label} is invalid`);
    }
}

export function prettyCanonicalJson(value: unknown): string {
    return `${JSON.stringify(JSON.parse(stableStringify(value)), null, 2)}\n`;
}
