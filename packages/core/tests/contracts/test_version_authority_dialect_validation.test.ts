import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { readAssetManifest } from "../../src/catalog/asset-manifest";
import { binaryPayloadStats } from "../../src/catalog/payload-store";
import {
    createVersionDialectRegistry,
    EMPTY_VERSION_DIALECT_REGISTRY,
    publishAssetVersion,
    publishInitialAssetVersion,
    readVersionAuthority,
    type VersionAuthorityClosureV1,
} from "../../src/catalog/version-authority";
import { computePortableEntryDialectContractFingerprint, computeVersionFingerprint } from "../../src/foundation/fingerprint";
import {
    makeNativeDialectContract,
    makePortableEntryDialectContract,
    makeRestorationDialectContract,
} from "../source-import/fixtures/dialect-contracts";
import { ASSET_ID, makeAsset, makeTextFile, makeVersionClosure, VERSION_ID, VERSION_ID_2 } from "../catalog/fixtures/version-v2";
import { assetsRoot, makeDialectVersion, root } from "../catalog/fixtures/version-authority-test-fixtures";

describe("AssetVersion V2 dialect validation authority", () => {
    it("requires exact registered native/restoration contracts and preserves raw bytes", () => {
        const { version, nativeBytes, restorationBytes } = makeDialectVersion();

        expect(() =>
            publishInitialAssetVersion({
                assetsRoot,
                transactionId: "txn-unknown",
                asset: makeAsset(),
                version,
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            }),
        ).toThrow(/native dialect contract rejected/);

        let nativeValidated = 0;
        let restorationValidated = 0;
        const registry = createVersionDialectRegistry(
            [
                makeNativeDialectContract("Guidance", "fixture-native-v1", ({ nativeFiles }) => {
                    nativeValidated++;
                    return Buffer.from(nativeFiles[0].bytes).equals(nativeBytes);
                }),
            ],
            [
                makeRestorationDialectContract("Guidance", "fixture-restoration-v1", (bytes) => {
                    restorationValidated++;
                    return Buffer.from(bytes).equals(restorationBytes);
                }),
            ],
            [],
            [],
        );
        publishInitialAssetVersion({
            assetsRoot: path.join(root, "valid-dialect"),
            transactionId: "txn-valid",
            asset: makeAsset(),
            version,
            dialectRegistry: registry,
        });
        const reopened = readVersionAuthority(path.join(root, "valid-dialect"), ASSET_ID, VERSION_ID, registry);
        expect(Buffer.from(reopened?.nativePayloads[0].files[0].bytes ?? [])).toEqual(nativeBytes);
        expect(nativeValidated).toBeGreaterThanOrEqual(2);
        expect(restorationValidated).toBeGreaterThanOrEqual(2);
    });

    it("rejects duplicate dialect registry rows and mismatched payload membership", () => {
        const contract = makeNativeDialectContract("Guidance", "fixture-x-v1");
        expect(() => createVersionDialectRegistry([contract, contract], [], [], [])).toThrow(/duplicate native/);
        const restoration = makeRestorationDialectContract("Guidance", "fixture-r-v1");
        expect(() => createVersionDialectRegistry([], [restoration, restoration], [], [])).toThrow(/duplicate restoration/);
        expect(EMPTY_VERSION_DIALECT_REGISTRY.getNative("Guidance", "none")).toBeNull();
        expect(EMPTY_VERSION_DIALECT_REGISTRY.getRestoration("Guidance", "none")).toBeNull();

        const version = makeVersionClosure();
        version.nativePayloads = [{ dialectId: "ghost", files: [] }];
        expect(() =>
            publishInitialAssetVersion({
                assetsRoot,
                transactionId: "txn-membership",
                asset: makeAsset(),
                version,
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            }),
        ).toThrow(/does not match manifest membership/);
    });

    it("rejects an invalid or already-existing initial Asset", () => {
        const invalid = makeAsset();
        invalid.displayName = "";
        expect(() =>
            publishInitialAssetVersion({
                assetsRoot,
                transactionId: "txn-invalid-asset",
                asset: invalid,
                version: makeVersionClosure(),
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            }),
        ).toThrow(/displayName/);
        publishInitialAssetVersion({
            assetsRoot,
            transactionId: "txn-first",
            asset: makeAsset(),
            version: makeVersionClosure(),
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        });
        expect(() =>
            publishInitialAssetVersion({
                assetsRoot,
                transactionId: "txn-duplicate",
                asset: makeAsset(),
                version: makeVersionClosure(),
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            }),
        ).toThrow(/already exists/);
    });

    it("checks every initial Asset/Version identity invariant before staging", () => {
        const cases: Array<{
            name: string;
            asset: ReturnType<typeof makeAsset>;
            version: VersionAuthorityClosureV1;
        }> = [
            ["kind", makeAsset(), makeVersionClosure()],
            ["asset-id", makeAsset(), makeVersionClosure({ assetId: "ffffffff-ffff-4fff-8fff-ffffffffffff" })],
            ["revision", makeAsset(), makeVersionClosure({ revision: 2 })],
            ["change", makeAsset(), makeVersionClosure({ changeKind: "edit" })],
            ["count", makeAsset([VERSION_ID, VERSION_ID_2]), makeVersionClosure()],
            ["member", makeAsset([VERSION_ID_2]), makeVersionClosure()],
        ].map(([name, asset, version]) => ({
            name: name as string,
            asset: asset as ReturnType<typeof makeAsset>,
            version: version as VersionAuthorityClosureV1,
        }));
        (cases[0].asset as { kind: string }).kind = "Skill";
        for (const item of cases) {
            expect(() =>
                publishInitialAssetVersion({
                    assetsRoot: path.join(root, `initial-${item.name}`),
                    transactionId: `txn-${item.name}`,
                    asset: item.asset,
                    version: item.version,
                    dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
                }),
            ).toThrow(/inconsistent/);
        }
    });

    it("rejects a later Version when the Asset is missing, deleted, duplicated, or the kind changes", () => {
        const second = makeVersionClosure({
            versionId: VERSION_ID_2,
            revision: 2,
            sourceVersionId: VERSION_ID,
            changeKind: "edit",
        });
        expect(() =>
            publishAssetVersion({
                assetsRoot,
                transactionId: "txn-missing",
                version: second,
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            }),
        ).toThrow(/active Asset not found/);
        publishInitialAssetVersion({
            assetsRoot,
            transactionId: "txn-first",
            asset: makeAsset(),
            version: makeVersionClosure(),
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        });
        const deleted = readAssetManifest(assetsRoot, ASSET_ID);
        if (deleted === null) throw new Error("fixture Asset missing");
        const assetPath = path.join(assetsRoot, ASSET_ID, "asset.json");
        fs.writeFileSync(assetPath, JSON.stringify({ ...deleted, deleted: true }, null, 2));
        expect(() =>
            publishAssetVersion({
                assetsRoot,
                transactionId: "txn-deleted",
                version: second,
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            }),
        ).toThrow(/active Asset not found/);
        fs.writeFileSync(assetPath, JSON.stringify(deleted, null, 2));

        const duplicate = makeVersionClosure({
            versionId: VERSION_ID,
            revision: 2,
            sourceVersionId: VERSION_ID,
            changeKind: "edit",
        });
        expect(() =>
            publishAssetVersion({
                assetsRoot,
                transactionId: "txn-duplicate-version",
                version: duplicate,
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            }),
        ).toThrow(/does not belong/);
        const wrongKind = structuredClone(second);
        (wrongKind.manifest as unknown as { kind: string }).kind = "Rule";
        expect(() =>
            publishAssetVersion({
                assetsRoot,
                transactionId: "txn-kind",
                version: wrongKind,
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            }),
        ).toThrow(/does not belong/);
        const createAgain = makeVersionClosure({
            versionId: VERSION_ID_2,
            revision: 2,
            sourceVersionId: VERSION_ID,
            changeKind: "create",
        });
        expect(() =>
            publishAssetVersion({
                assetsRoot,
                transactionId: "txn-create-again",
                version: createAgain,
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            }),
        ).toThrow(/non-create changeKind/);
    });

    it("rejects malformed manifests and payload bytes that contradict their descriptors", () => {
        const malformed = makeVersionClosure();
        malformed.manifest.fingerprint = `sha256:${"9".repeat(64)}`;
        expect(() =>
            publishInitialAssetVersion({
                assetsRoot,
                transactionId: "txn-malformed",
                asset: makeAsset(),
                version: malformed,
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            }),
        ).toThrow(/fingerprint mismatch/);

        const wrongBytes = makeVersionClosure();
        if (wrongBytes.files[0].contentKind !== "text") throw new Error("fixture must be text");
        wrongBytes.files[0].text = "different";
        expect(() =>
            publishInitialAssetVersion({
                assetsRoot: path.join(root, "wrong-bytes"),
                transactionId: "txn-wrong-bytes",
                asset: makeAsset(),
                version: wrongBytes,
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            }),
        ).toThrow(/payload descriptor mismatch/);

        const nonFinalText = makeVersionClosure({ files: [makeTextFile("a\r\n", "AGENTS.md")] });
        expect(() =>
            publishInitialAssetVersion({
                assetsRoot: path.join(root, "non-final-text"),
                transactionId: "txn-non-final-text",
                asset: makeAsset(),
                version: nonFinalText,
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            }),
        ).toThrow(/reopened Version closure differs/);
    });

    it("round-trips binary incomplete fragments", () => {
        const bytes = new Uint8Array([0, 255]);
        const stats = binaryPayloadStats(bytes);
        const binary = {
            contentKind: "binary" as const,
            bytes,
            file: {
                fileId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
                logicalPath: "fragment.bin",
                role: "resource" as const,
                contentHash: stats.contentHash,
                contentKind: "binary" as const,
                mediaType: "application/octet-stream",
                byteSize: stats.byteSize,
                executable: false,
                references: [],
            },
        };
        const version = makeVersionClosure({ files: [binary] });
        version.manifest.status = "incomplete";
        publishInitialAssetVersion({
            assetsRoot,
            transactionId: "txn-binary",
            asset: makeAsset(),
            version,
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        });
        expect(readVersionAuthority(assetsRoot, ASSET_ID, VERSION_ID, EMPTY_VERSION_DIALECT_REGISTRY)?.files[0].contentKind).toBe(
            "binary",
        );
    });

    it("distinguishes missing, fingerprint-mismatched, and validator-rejected dialect contracts", () => {
        const { version } = makeDialectVersion();
        const nativeWrongFingerprint = createVersionDialectRegistry(
            [makeNativeDialectContract("Guidance", "fixture-native-v1", () => true, `sha256:${"f".repeat(64)}`)],
            [],
            [],
            [],
        );
        expect(() =>
            publishInitialAssetVersion({
                assetsRoot,
                transactionId: "txn-native-fingerprint",
                asset: makeAsset(),
                version,
                dialectRegistry: nativeWrongFingerprint,
            }),
        ).toThrow(/native dialect contract rejected/);
        const nativeRejected = createVersionDialectRegistry(
            [makeNativeDialectContract("Guidance", "fixture-native-v1", () => false)],
            [],
            [],
            [],
        );
        expect(() =>
            publishInitialAssetVersion({
                assetsRoot: path.join(root, "native-rejected"),
                transactionId: "txn-native-rejected",
                asset: makeAsset(),
                version,
                dialectRegistry: nativeRejected,
            }),
        ).toThrow(/native dialect contract rejected/);

        const withoutNative = structuredClone(version);
        withoutNative.manifest.nativeRepresentations = [];
        withoutNative.nativePayloads = [];
        withoutNative.manifest.fingerprint = computeVersionFingerprint(
            withoutNative.manifest.versionCanonicalContentFingerprint,
            [],
            withoutNative.manifest.dialectRestorationPayloads,
            withoutNative.manifest.portableDialectContracts,
        );
        expect(() =>
            publishInitialAssetVersion({
                assetsRoot: path.join(root, "restoration-missing"),
                transactionId: "txn-restoration-missing",
                asset: makeAsset(),
                version: withoutNative,
                dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
            }),
        ).toThrow(/restoration dialect contract rejected/);
        for (const [name, contract] of [
            [
                "wrong-fingerprint",
                makeRestorationDialectContract("Guidance", "fixture-restoration-v1", () => true, `sha256:${"e".repeat(64)}`),
            ],
            ["validator-false", makeRestorationDialectContract("Guidance", "fixture-restoration-v1", () => false)],
        ] as const) {
            const registry = createVersionDialectRegistry([], [contract], [], []);
            expect(() =>
                publishInitialAssetVersion({
                    assetsRoot: path.join(root, name),
                    transactionId: `txn-${name}`,
                    asset: makeAsset(),
                    version: withoutNative,
                    dialectRegistry: registry,
                }),
            ).toThrow(/restoration dialect contract rejected/);
        }
    });

    it("keeps historical portable entry contracts exact and fails closed on drift", () => {
        const v1 = makePortableEntryDialectContract(
            "Workflow",
            "workflow_instruction",
            "fixture-workflow-entry-v1",
            (input) =>
                input.use.logicalPath === "review.md" &&
                input.canonical.kind === "Workflow" &&
                input.canonicalFiles.some(
                    (file) => file.file.logicalPath === "review.md" && file.file.role === "entry" && file.contentKind === "text",
                ),
        );
        const v2 = makePortableEntryDialectContract("Workflow", "workflow_instruction", "fixture-workflow-entry-v2");
        const ref = {
            field: "workflow_instruction" as const,
            dialectId: v1.definition.dialectId,
            dialectContractFingerprint: computePortableEntryDialectContractFingerprint(v1.definition),
        };
        const version = makeVersionClosure({
            canonical: workflowCanonical(v1.definition.dialectId),
            files: [makeTextFile("Review carefully.\n", "review.md")],
            portableDialectContracts: [ref],
        });
        const asset = makeAsset([VERSION_ID], {
            kind: "Workflow",
            displayName: "Review workflow",
        });
        const bothVersions = createVersionDialectRegistry([], [], [v1, v2], []);
        publishInitialAssetVersion({
            assetsRoot: path.join(root, "portable-history"),
            transactionId: "txn-portable-history",
            asset,
            version,
            dialectRegistry: bothVersions,
        });
        expect(
            readVersionAuthority(path.join(root, "portable-history"), ASSET_ID, VERSION_ID, bothVersions)?.manifest
                .portableDialectContracts,
        ).toEqual([ref]);
        expect(() =>
            readVersionAuthority(
                path.join(root, "portable-history"),
                ASSET_ID,
                VERSION_ID,
                createVersionDialectRegistry([], [], [v2], []),
            ),
        ).toThrow(/portable entry dialect contract rejected/);

        const mismatched = makePortableEntryDialectContract(
            "Workflow",
            "workflow_instruction",
            "fixture-workflow-entry-v1",
            () => true,
            ["FIXTURE_CLI"],
            `sha256:${"f".repeat(64)}`,
        );
        expect(() =>
            readVersionAuthority(
                path.join(root, "portable-history"),
                ASSET_ID,
                VERSION_ID,
                createVersionDialectRegistry([], [], [mismatched], []),
            ),
        ).toThrow(/portable dialect contract refs do not match/);
        expect(() =>
            readVersionAuthority(
                path.join(root, "portable-history"),
                ASSET_ID,
                VERSION_ID,
                createVersionDialectRegistry(
                    [],
                    [],
                    [
                        makePortableEntryDialectContract(
                            "Workflow",
                            "workflow_instruction",
                            "fixture-workflow-entry-v1",
                            () => false,
                        ),
                    ],
                    [],
                ),
            ),
        ).toThrow(/portable entry dialect contract rejected/);
    });

    it("publishes and reopens an incomplete Version without weakening its portable dialect identity", () => {
        const contract = makePortableEntryDialectContract(
            "Workflow",
            "workflow_instruction",
            "fixture-incomplete-workflow-entry-v1",
            (input) =>
                input.canonical.kind === "Workflow" && input.versionStatus === "incomplete" && input.use.logicalPath === "",
        );
        const ref = {
            field: "workflow_instruction" as const,
            dialectId: contract.definition.dialectId,
            dialectContractFingerprint: computePortableEntryDialectContractFingerprint(contract.definition),
        };
        const version = makeVersionClosure({
            canonical: workflowCanonical(contract.definition.dialectId),
            files: [],
            status: "incomplete",
            portableDialectContracts: [ref],
        });
        const asset = makeAsset([VERSION_ID], {
            kind: "Workflow",
            displayName: "Incomplete workflow",
        });
        const registry = createVersionDialectRegistry([], [], [contract], []);
        const incompleteRoot = path.join(root, "portable-incomplete");

        publishInitialAssetVersion({
            assetsRoot: incompleteRoot,
            transactionId: "txn-portable-incomplete",
            asset,
            version,
            dialectRegistry: registry,
        });
        expect(readVersionAuthority(incompleteRoot, ASSET_ID, VERSION_ID, registry)?.manifest).toEqual(
            expect.objectContaining({ status: "incomplete", portableDialectContracts: [ref] }),
        );
    });

    it("rejects native path membership and native/restoration bytes that contradict descriptors", () => {
        const fixture = makeDialectVersion();
        const registry = createVersionDialectRegistry(
            [makeNativeDialectContract("Guidance", "fixture-native-v1")],
            [makeRestorationDialectContract("Guidance", "fixture-restoration-v1")],
            [],
            [],
        );
        const wrongPath = structuredClone(fixture.version);
        wrongPath.nativePayloads[0].files[0].relativePath = "other.md";
        expect(() =>
            publishInitialAssetVersion({
                assetsRoot,
                transactionId: "txn-native-path",
                asset: makeAsset(),
                version: wrongPath,
                dialectRegistry: registry,
            }),
        ).toThrow(/native payload paths/);

        const wrongNative = structuredClone(fixture.version);
        wrongNative.nativePayloads[0].files[0].bytes = Buffer.from("different native");
        expect(() =>
            publishInitialAssetVersion({
                assetsRoot: path.join(root, "wrong-native"),
                transactionId: "txn-wrong-native",
                asset: makeAsset(),
                version: wrongNative,
                dialectRegistry: registry,
            }),
        ).toThrow(/native payload descriptor mismatch/);

        const wrongRestoration = structuredClone(fixture.version);
        wrongRestoration.restorationPayloads[0].bytes = Buffer.from("different restoration");
        expect(() =>
            publishInitialAssetVersion({
                assetsRoot: path.join(root, "wrong-restoration"),
                transactionId: "txn-wrong-restoration",
                asset: makeAsset(),
                version: wrongRestoration,
                dialectRegistry: registry,
            }),
        ).toThrow(/restoration payload descriptor mismatch/);
    });

    it("returns null for missing Asset or non-member Version", () => {
        expect(readVersionAuthority(assetsRoot, ASSET_ID, VERSION_ID, EMPTY_VERSION_DIALECT_REGISTRY)).toBeNull();
        publishInitialAssetVersion({
            assetsRoot,
            transactionId: "txn-1",
            asset: makeAsset(),
            version: makeVersionClosure(),
            dialectRegistry: EMPTY_VERSION_DIALECT_REGISTRY,
        });
        expect(
            readVersionAuthority(assetsRoot, ASSET_ID, "ffffffff-ffff-4fff-8fff-ffffffffffff", EMPTY_VERSION_DIALECT_REGISTRY),
        ).toBeNull();
    });
});

function workflowCanonical(instructionDialectId: string) {
    return {
        kind: "Workflow" as const,
        typeData: {
            schemaVersion: 2 as const,
            name: "review",
            description: "Review changes",
            implementation: {
                kind: "instructions" as const,
                instructionDialectId,
                execution: {
                    mode: "caller" as const,
                    agent: { mode: "agent_runtime_default" as const },
                    model: { mode: "inherit" as const },
                    effort: { mode: "inherit" as const },
                    shell: { mode: "none" as const },
                },
                toolPolicy: {
                    preapproved: [],
                    denied: [],
                    otherwise: "inherit_agent_runtime_policy" as const,
                },
            },
            invocation: {
                commandNames: ["review"],
                userInvocable: true,
                agentInvocable: false,
                argumentHint: "",
                argumentNames: [],
            },
        },
    };
}
