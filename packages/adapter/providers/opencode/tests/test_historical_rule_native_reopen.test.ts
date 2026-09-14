import * as crypto from "node:crypto";
import type { AssetVersionFileContentV2, NativeDialectValidationInputV1, Sha256Digest } from "@oaam/core";
import { describe, expect, it } from "vitest";
import { OPENCODE_NATIVE_DIALECTS } from "../src/opencode-source-read-model";
import { validateOpencodeNativeDialect } from "../src/opencode-source-read-native";

const RULE_PATH = "docs/retained-rule.md";
const FRAGMENT_PATH = "resources/opencode-instructions.fragment.jsonc";
const BODY = "Retained historical OpenCode instruction.\n";
const FRAGMENT = new TextEncoder().encode('["' + RULE_PATH + '"]');
const ZERO = ("sha256:" + "0".repeat(64)) as Sha256Digest;

describe("OpenCode historical instructions Rule native reopen", () => {
    it("reopens an already-imported exact native graph without restoring current Rule discovery or target support", () => {
        const valid = input();
        expect(validateOpencodeNativeDialect(valid)).toBe(true);

        for (const mutate of [
            (value: NativeDialectValidationInputV1) => {
                value.canonical.kind = "Guidance";
            },
            (value: NativeDialectValidationInputV1) => {
                value.representation.schemaVersion = 2;
            },
            (value: NativeDialectValidationInputV1) => {
                if (value.canonical.kind !== "Rule") throw new Error("Rule fixture changed");
                value.canonical.typeData.name = " ";
            },
            (value: NativeDialectValidationInputV1) => {
                value.representation.files[0] = { ...value.representation.files[0], executable: true };
            },
            (value: NativeDialectValidationInputV1) => {
                value.nativeFiles[0] = { ...value.nativeFiles[0], bytes: Uint8Array.of(0xff) };
            },
            (value: NativeDialectValidationInputV1) => {
                value.canonicalFiles = value.canonicalFiles.slice(0, 1);
            },
            (value: NativeDialectValidationInputV1) => {
                const entry = value.canonicalFiles.find((file) => file.file.logicalPath === "RULE.md");
                if (entry?.contentKind !== "text") throw new Error("Rule entry missing");
                entry.text = "changed\n";
            },
        ]) {
            const changed = structuredClone(valid);
            mutate(changed);
            expect(validateOpencodeNativeDialect(changed)).toBe(false);
        }
    });
});

function input(): NativeDialectValidationInputV1 {
    const ruleBytes = new TextEncoder().encode(BODY);
    const nativeFiles = [
        nativeDescriptor("opencode.jsonc", "binary", FRAGMENT, "application/jsonc"),
        nativeDescriptor(RULE_PATH, "text", ruleBytes, "text/markdown"),
    ];
    return {
        canonical: {
            kind: "Rule",
            typeData: {
                schemaVersion: 2,
                name: "retained-historical-opencode-rule",
                description: "Historical Version reopen only",
                activation: { mode: "always" },
            },
        },
        canonicalFiles: [
            canonicalText("RULE.md", BODY, "11111111-1111-4111-8111-111111111111", "entry"),
            canonicalBinary(FRAGMENT_PATH, FRAGMENT, "22222222-2222-4222-8222-222222222222", "application/jsonc"),
        ],
        representation: {
            schemaVersion: 1,
            dialectId: OPENCODE_NATIVE_DIALECTS.instructionsRule,
            dialectContractFingerprint: ZERO,
            canonicalContentFingerprint: ZERO,
            representationFingerprint: ZERO,
            files: nativeFiles,
        },
        nativeFiles: [
            { relativePath: "opencode.jsonc", bytes: new Uint8Array(FRAGMENT) },
            { relativePath: RULE_PATH, bytes: ruleBytes },
        ],
    };
}

function nativeDescriptor(relativePath: string, contentKind: "text" | "binary", bytes: Uint8Array, mediaType: string) {
    return {
        relativePath,
        contentKind,
        mediaType,
        contentHash: sha256(bytes),
        byteSize: bytes.byteLength,
        executable: false,
    };
}

function canonicalText(logicalPath: string, text: string, fileId: string, role: "entry" | "resource"): AssetVersionFileContentV2 {
    const bytes = new TextEncoder().encode(text);
    return {
        contentKind: "text",
        text,
        file: {
            fileId,
            logicalPath,
            role,
            contentHash: sha256(bytes),
            contentKind: "text",
            mediaType: "text/markdown",
            byteSize: bytes.byteLength,
            executable: false,
            references: [],
        },
    };
}

function canonicalBinary(logicalPath: string, source: Uint8Array, fileId: string, mediaType: string): AssetVersionFileContentV2 {
    const bytes = new Uint8Array(source);
    return {
        contentKind: "binary",
        bytes,
        file: {
            fileId,
            logicalPath,
            role: "resource",
            contentHash: sha256(bytes),
            contentKind: "binary",
            mediaType,
            byteSize: bytes.byteLength,
            executable: false,
            references: [],
        },
    };
}

function sha256(bytes: Uint8Array): Sha256Digest {
    return ("sha256:" + crypto.createHash("sha256").update(bytes).digest("hex")) as Sha256Digest;
}
