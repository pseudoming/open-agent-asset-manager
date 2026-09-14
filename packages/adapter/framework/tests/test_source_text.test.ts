import { describe, expect, it } from "vitest";
import {
    compareCodeUnitText,
    compareLogicalPath,
    decodeUtf8Strict,
    isAsciiWhitespace,
    isPortablePathAtOrBelow,
    isPlainRecord,
    isPortableSourcePattern,
    normalizePortableRelativeReference,
    portableBasename,
    portableParentPath,
    portablePathWithoutExtension,
    relativePortablePath,
    trimNonBlankText,
    unknownSourceKeys,
    uniqueSortedStrings,
    uniqueStringsPreservingOrder,
} from "../src";

describe("runtime-neutral source text mechanics", () => {
    it("orders code units and classifies only the four ASCII whitespace characters", () => {
        expect(compareCodeUnitText("a", "b")).toBe(-1);
        expect(compareCodeUnitText("b", "a")).toBe(1);
        expect(compareCodeUnitText("a", "a")).toBe(0);
        expect([" ", "\t", "\n", "\r"].every(isAsciiWhitespace)).toBe(true);
        expect(isAsciiWhitespace("\u00a0")).toBe(false);
    });

    it("decodes strict UTF-8 and rejects malformed bytes", () => {
        expect(decodeUtf8Strict(new TextEncoder().encode("hello"))).toBe("hello");
        expect(decodeUtf8Strict(new Uint8Array([0xc3, 0x28]))).toBeNull();
    });

    it("applies portable path and stable uniqueness mechanics", () => {
        expect(portableBasename("root/file.md")).toBe("file.md");
        expect(portableBasename("file.md")).toBe("file.md");
        expect(portableParentPath("root/file.md")).toBe("root");
        expect(portableParentPath("file.md")).toBe("");
        expect(relativePortablePath("root/file.md", "root")).toBe("file.md");
        expect(relativePortablePath("file.md", "")).toBe("file.md");
        expect(isPortableSourcePattern("src/**/*.ts")).toBe(true);
        expect(["", "   ", "a//b", "a/./b", "a/../b", "/root", "a\\b", "a\0b"].map(isPortableSourcePattern)).toEqual([
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
        ]);
        expect(uniqueStringsPreservingOrder(["b", "a", "b"])).toEqual(["b", "a"]);
        expect(uniqueSortedStrings(["b", "a", "b"])).toEqual(["a", "b"]);
        expect(compareLogicalPath({ logicalPath: "a" }, { logicalPath: "b" })).toBe(-1);
        expect(isPlainRecord({ value: 1 })).toBe(true);
        expect(isPlainRecord(null)).toBe(false);
        expect(isPlainRecord([])).toBe(false);
        expect(trimNonBlankText("  value  ")).toBe("value");
        expect(trimNonBlankText("  ")).toBeUndefined();
        expect(trimNonBlankText(undefined)).toBeUndefined();
        expect(unknownSourceKeys({ presentKeys: ["name", "description", "extra"] }, ["name", "description"])).toEqual(["extra"]);
    });

    it("owns portable extension, containment, and bounded relative-reference mechanics", () => {
        expect(portablePathWithoutExtension("file.md")).toBe("file");
        expect(portablePathWithoutExtension("dir/file.test.md")).toBe("dir/file.test");
        expect(portablePathWithoutExtension("dir.with.dot/file")).toBe("dir.with.dot/file");
        expect(portablePathWithoutExtension(".hidden")).toBe(".hidden");
        expect(portablePathWithoutExtension("dir/.hidden")).toBe("dir/.hidden");

        expect(isPortablePathAtOrBelow("root", "root")).toBe(true);
        expect(isPortablePathAtOrBelow("root/child", "root")).toBe(true);
        expect(isPortablePathAtOrBelow("sibling", "root")).toBe(false);
        expect(isPortablePathAtOrBelow("anything", "")).toBe(true);

        const external = (value: string) => value.startsWith("external:");
        expect(normalizePortableRelativeReference("a.md", "", external)).toBe("a.md");
        expect(normalizePortableRelativeReference("../a.md", "docs", external)).toBe("a.md");
        expect(normalizePortableRelativeReference("./a//b.md", "docs", external)).toBe("docs/a/b.md");
        expect(normalizePortableRelativeReference("external:item", "docs", external)).toBeNull();
        expect(normalizePortableRelativeReference("../../escape.md", "docs", external)).toBeNull();
        expect(normalizePortableRelativeReference("..", "docs", external)).toBeNull();
        expect(normalizePortableRelativeReference("", "docs", external)).toBeNull();
        expect(normalizePortableRelativeReference("a\\b.md", "docs", external)).toBeNull();
        expect(normalizePortableRelativeReference("a\0b.md", "docs", external)).toBeNull();
        expect(normalizePortableRelativeReference("a.md", "bad/../root", external)).toBeNull();
        expect(normalizePortableRelativeReference("a.md", "bad//root", external)).toBeNull();
    });
});
