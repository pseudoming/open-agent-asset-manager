import { describe, expect, it } from "vitest";
import {
    hasExactKeys,
    hasNoExtraKeys,
    isCanonicalTargetRootPath,
    isNonEmptyString,
    isNonNegativeInteger,
    isPositiveInteger,
    isPosixRelativePath,
    isSafeSegment,
    isSha256Digest,
    isStrictArray,
    isStrictObject,
    isUuidV4,
    SHA256_RE,
    UUID_V4_RE,
} from "../../src/foundation/validators";

const UUID = "00000000-0000-4000-8000-000000000001";

describe("isUuidV4", () => {
    it("accepts valid v4", () => {
        expect(isUuidV4(UUID)).toBe(true);
        expect(isUuidV4("11111111-1111-4111-8111-111111111111")).toBe(true);
    });
    it("rejects non-v4 UUIDs", () => {
        expect(isUuidV4("00000000-0000-1000-8000-000000000001")).toBe(false); // v1
        expect(isUuidV4("00000000-0000-4000-3000-000000000001")).toBe(false); // bad variant
    });
    it("rejects non-strings / malformed", () => {
        expect(isUuidV4(null)).toBe(false);
        expect(isUuidV4(5)).toBe(false);
        expect(isUuidV4("xxx")).toBe(false);
        expect(isUuidV4("")).toBe(false);
    });
});

describe("isSha256Digest", () => {
    it("accepts sha256:<64 hex>", () => {
        expect(isSha256Digest(`sha256:${"a".repeat(64)}`)).toBe(true);
    });
    it("rejects wrong prefix / length / case", () => {
        expect(isSha256Digest(`sha1:${"a".repeat(64)}`)).toBe(false);
        expect(isSha256Digest(`sha256:${"a".repeat(63)}`)).toBe(false);
        expect(isSha256Digest(`sha256:${"A".repeat(64)}`)).toBe(false); // uppercase
        expect(isSha256Digest(`sha256:xyz`)).toBe(false);
        expect(isSha256Digest(null)).toBe(false);
    });
});

describe("isPosixRelativePath", () => {
    it("accepts valid relative", () => {
        expect(isPosixRelativePath("a.md")).toBe(true);
        expect(isPosixRelativePath("deep/nested/file.md")).toBe(true);
    });
    it("rejects empty", () => {
        expect(isPosixRelativePath("")).toBe(false);
    });
    it("rejects absolute", () => {
        expect(isPosixRelativePath("/etc/x")).toBe(false);
    });
    it("rejects ..", () => {
        expect(isPosixRelativePath("../x")).toBe(false);
        expect(isPosixRelativePath("a/../b")).toBe(false);
    });
    it("rejects .", () => {
        expect(isPosixRelativePath(".")).toBe(false);
        expect(isPosixRelativePath("./x")).toBe(false);
        expect(isPosixRelativePath("a/./b")).toBe(false);
    });
    it("rejects backslash", () => {
        expect(isPosixRelativePath("a\\b")).toBe(false);
    });
    it("rejects trailing slash", () => {
        expect(isPosixRelativePath("dir/")).toBe(false);
    });
    it("rejects embedded NUL", () => {
        expect(isPosixRelativePath("a\0b")).toBe(false);
    });
    it("rejects non-string", () => {
        expect(isPosixRelativePath(5)).toBe(false);
        expect(isPosixRelativePath(null)).toBe(false);
    });
});

describe("isCanonicalTargetRootPath", () => {
    it("accepts canonical Host-visible roots independently from the logical Platform", () => {
        expect(isCanonicalTargetRootPath("/tmp/oaam", "linux")).toBe(true);
        expect(isCanonicalTargetRootPath("/Users/example", "darwin")).toBe(true);
        expect(isCanonicalTargetRootPath("/mnt/c/work", "wsl")).toBe(true);
        expect(isCanonicalTargetRootPath("C:\\Users\\example", "win32")).toBe(true);
        expect(isCanonicalTargetRootPath("\\\\wsl.localhost\\Ubuntu\\home\\example", "wsl")).toBe(true);
        expect(isCanonicalTargetRootPath("/mnt/c/Users/example", "win32")).toBe(true);
    });

    it("rejects relative, non-canonical, malformed, and unknown-platform roots", () => {
        expect(isCanonicalTargetRootPath("relative/root", "linux")).toBe(false);
        expect(isCanonicalTargetRootPath("/tmp/a/../b", "linux")).toBe(false);
        expect(isCanonicalTargetRootPath("C:/Users/example", "win32")).toBe(false);
        expect(isCanonicalTargetRootPath("", "linux")).toBe(false);
        expect(isCanonicalTargetRootPath("/tmp/a\0b", "linux")).toBe(false);
        expect(isCanonicalTargetRootPath(5, "linux")).toBe(false);
        expect(isCanonicalTargetRootPath("/tmp/oaam", "other")).toBe(false);
    });
});

describe("isSafeSegment", () => {
    it("accepts letters/digits/dash/underscore", () => {
        expect(isSafeSegment("abc")).toBe(true);
        expect(isSafeSegment("ABC123_-")).toBe(true);
        expect(isSafeSegment(UUID)).toBe(true); // UUID is all hex+dashes
    });
    it("rejects path separators", () => {
        expect(isSafeSegment("../escape")).toBe(false);
        expect(isSafeSegment("a/b")).toBe(false);
        expect(isSafeSegment("a\\b")).toBe(false);
    });
    it("rejects dots / spaces / empty", () => {
        expect(isSafeSegment(".")).toBe(false);
        expect(isSafeSegment("a.b")).toBe(false);
        expect(isSafeSegment("a b")).toBe(false);
        expect(isSafeSegment("")).toBe(false);
    });
    it("rejects non-string", () => {
        expect(isSafeSegment(null)).toBe(false);
        expect(isSafeSegment(5)).toBe(false);
    });
});

describe("hasExactKeys", () => {
    it("accepts exact key set", () => {
        expect(hasExactKeys({ a: 1, b: 2 }, ["a", "b"])).toBe(true);
    });
    it("rejects extra key", () => {
        expect(hasExactKeys({ a: 1, b: 2, c: 3 }, ["a", "b"])).toBe(false);
    });
    it("rejects missing key", () => {
        expect(hasExactKeys({ a: 1 }, ["a", "b"])).toBe(false);
    });
    it("rejects null/array/non-object", () => {
        expect(hasExactKeys(null, ["a"])).toBe(false);
        expect(hasExactKeys([], ["a"])).toBe(false);
        expect(hasExactKeys("x", ["a"])).toBe(false);
    });
});

describe("hasNoExtraKeys", () => {
    it("accepts subset", () => {
        expect(hasNoExtraKeys({ a: 1 }, ["a", "b", "c"])).toBe(true);
        expect(hasNoExtraKeys({}, ["a"])).toBe(true);
    });
    it("rejects extra key", () => {
        expect(hasNoExtraKeys({ a: 1, z: 2 }, ["a", "b"])).toBe(false);
    });
    it("rejects non-object", () => {
        expect(hasNoExtraKeys(null, ["a"])).toBe(false);
        expect(hasNoExtraKeys([], ["a"])).toBe(false);
    });
});

describe("isStrictObject / isStrictArray", () => {
    it("isStrictObject accepts plain object, rejects null/array/primitive", () => {
        expect(isStrictObject({})).toBe(true);
        expect(isStrictObject(null)).toBe(false);
        expect(isStrictObject([])).toBe(false);
        expect(isStrictObject("x")).toBe(false);
        expect(isStrictObject(5)).toBe(false);
    });
    it("isStrictArray accepts array, rejects null/object", () => {
        expect(isStrictArray([])).toBe(true);
        expect(isStrictArray([1, 2])).toBe(true);
        expect(isStrictArray(null)).toBe(false);
        expect(isStrictArray({})).toBe(false);
        expect(isStrictArray("x")).toBe(false);
    });
});

describe("isNonEmptyString / isNonNegativeInteger / isPositiveInteger", () => {
    it("isNonEmptyString", () => {
        expect(isNonEmptyString("x")).toBe(true);
        expect(isNonEmptyString("")).toBe(false);
        expect(isNonEmptyString(null)).toBe(false);
        expect(isNonEmptyString(5)).toBe(false);
    });
    it("isNonNegativeInteger", () => {
        expect(isNonNegativeInteger(0)).toBe(true);
        expect(isNonNegativeInteger(1000)).toBe(true);
        expect(isNonNegativeInteger(-1)).toBe(false);
        expect(isNonNegativeInteger(1.5)).toBe(false);
        expect(isNonNegativeInteger("5")).toBe(false);
        expect(isNonNegativeInteger(null)).toBe(false);
    });
    it("isPositiveInteger", () => {
        expect(isPositiveInteger(1)).toBe(true);
        expect(isPositiveInteger(5)).toBe(true);
        expect(isPositiveInteger(0)).toBe(false);
        expect(isPositiveInteger(-1)).toBe(false);
        expect(isPositiveInteger(1.5)).toBe(false);
        expect(isPositiveInteger("1")).toBe(false);
    });
});

describe("regex exports", () => {
    it("UUID_V4_RE matches valid v4", () => {
        expect(UUID_V4_RE.test(UUID)).toBe(true);
        expect(UUID_V4_RE.test("not-uuid")).toBe(false);
    });
    it("SHA256_RE matches sha256:<64 hex>", () => {
        expect(SHA256_RE.test(`sha256:${"f".repeat(64)}`)).toBe(true);
        expect(SHA256_RE.test("sha256:short")).toBe(false);
    });
});

describe("hasExactKeys: same-length different-keys branch", () => {
    it("returns false when same length but a key differs", () => {
        // {a, x} has length 2, allowed ["a", "b"] has length 2 — length check
        // passes, but the key-set check must catch x.
        expect(hasExactKeys({ a: 1, x: 2 }, ["a", "b"])).toBe(false);
    });
});
