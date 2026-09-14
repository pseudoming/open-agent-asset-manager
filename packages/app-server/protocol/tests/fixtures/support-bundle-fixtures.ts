import { SHA_A } from "./protocol-fixture-primitives";

export const SUPPORT_BUNDLE_REVIEW = Object.freeze({
    schemaVersion: 1,
    supportBundleReviewToken: "support-review-token",
    mode: "standard",
    createdAt: 10,
    archiveByteLength: 4_096,
    archiveContentHash: SHA_A,
    entries: [
        { archivePath: "README.txt", category: "documentation", byteLength: 64 },
        { archivePath: "diagnostics/adapters.json", category: "adapter_capabilities", byteLength: 128 },
        { archivePath: "diagnostics/health.json", category: "health", byteLength: 128 },
        { archivePath: "diagnostics/ordinary-log.jsonl", category: "ordinary_log", byteLength: 512 },
        { archivePath: "diagnostics/product.json", category: "product", byteLength: 128 },
        { archivePath: "manifest.json", category: "manifest", byteLength: 256 },
    ],
    ordinaryLog: {
        retainedSegmentCount: 1,
        includedSegmentCount: 1,
        retainedBytes: 512,
        includedBytes: 512,
        truncated: false,
    },
});

export const SUPPORT_BUNDLE_ARTIFACT = Object.freeze({
    schemaVersion: 1,
    mode: "standard",
    createdAt: 10,
    archiveByteLength: 4_096,
    archiveContentHash: SHA_A,
    entryCount: 6,
});
