import * as path from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import { BUILTIN_ADAPTER_PROVIDERS } from "../conformance/adapter-conformance-fixtures";
import {
    CORE_SRC_DIR,
    collectAdapterFilesystemAuthorityViolations,
    collectAdapterProcessObservationAuthorityViolations,
    ROOT_DIR,
    readFileContent,
    walkDir,
} from "./architecture-test-fixtures";

describe("architecture: reverse-accept durability internals stay inside core", () => {
    const seams = [
        {
            name: "createReverseAcceptMarkerStoreForTest",
            owners: ["reverse/reverse-accept-marker.ts", "reverse/reverse-accept-marker-store.ts"],
        },
        {
            name: "validateReverseAcceptMarkerForTest",
            owners: ["reverse/reverse-accept-marker.ts", "reverse/reverse-accept-marker-builders.ts"],
        },
        {
            name: "validateClaimedRenderedTargetCommitIntentForTest",
            owners: ["reverse/reverse-accept-marker.ts", "reverse/reverse-accept-marker-builders.ts"],
        },
        {
            name: "validateAssetFilesystemCommitReceiptForTest",
            owners: ["reverse/reverse-accept-marker.ts", "reverse/reverse-accept-marker-builders.ts"],
        },
        {
            name: "requireIntentExtendsPreparedForTest",
            owners: ["reverse/reverse-accept-marker.ts", "reverse/reverse-accept-marker-builders.ts"],
        },
        {
            name: "createReverseAcceptServiceForTest",
            owners: ["reverse/reverse-accept-service.ts", "reverse/reverse-accept-service-runtime.ts"],
        },
        {
            name: "physicalKeysForCommitForTest",
            owners: ["reverse/reverse-accept-service.ts", "reverse/reverse-accept-service-runtime.ts"],
        },
        {
            name: "reconcileReverseAcceptPreparationForTest",
            owners: ["reverse/reverse-accept-reconcile.ts"],
        },
        {
            name: "readReverseAcceptReconcileFactsForTest",
            owners: ["reverse/reverse-accept-reconcile.ts"],
        },
    ] as const;

    for (const seam of seams) {
        it(`${seam.name} is referenced only by its owner module under core/src`, () => {
            const owners = new Set(seam.owners.map((owner) => path.join(CORE_SRC_DIR, owner)));
            const violators = walkDir(CORE_SRC_DIR).filter(
                (file) => !owners.has(file) && readFileContent(file).includes(seam.name),
            );
            const rel = violators.map((file) => path.relative(ROOT_DIR, file));
            expect(rel, `${seam.name} escaped into production: ${rel.join(", ")}`).toEqual([]);
        });
    }

    it("public type barrels do not export marker, locator, or recovery evidence", () => {
        const publicSurface = [
            readFileContent(path.join(CORE_SRC_DIR, "types.ts")),
            readFileContent(path.join(CORE_SRC_DIR, "index.ts")),
            readFileContent(path.join(CORE_SRC_DIR, "contracts", "core-service.ts")),
            readFileContent(path.join(CORE_SRC_DIR, "contracts", "reverse.ts")),
        ].join("\n");
        for (const internal of [
            "ReverseAcceptPreparationIdentityV1",
            "PreparedRenderedTargetAccept",
            "ReverseAcceptReservationLocatorV1",
            "ReverseAcceptMarkerStore",
            "ReverseAcceptMarkerReadResult",
            "ReverseAcceptVersionOriginDraftV1",
            "ReverseAcceptReservationRecoveryResult",
            "FreshReverseAcceptPreparationDraft",
            "ReverseAcceptServiceConfiguration",
            "DeploymentCommitReceiptV1",
            "CanonicalDeploymentPreCommitDatabaseStateV1",
            "DeploymentSuccessPostconditionV1",
            "PreparedDeploymentSuccessAuthorityV1",
            "CommitReverseAcceptSuccessCrashDurableInput",
            "CommitReverseAcceptSuccessCrashDurableResult",
            "FreshReverseAcceptCommitDraft",
            "ResolveFreshReverseAcceptCommitInput",
            "ReverseAcceptDeploymentAssetVersionTransitionV1",
            "CommitReverseAcceptVersionSelectionSuccessCrashDurableInput",
            "ReverseAcceptReconcileConfiguration",
            "ReverseAcceptReconcileResult",
            "ReverseAcceptRecoveryRequiredDetailsV1",
            "ReverseAcceptReservationScanResult",
            "reconcileReverseAcceptPreparation",
            "scanReverseAcceptReservations",
        ]) {
            expect(publicSurface).not.toContain(internal);
        }
    });

    it("reverse-accept service cannot write runtime targets or bypass marker authority", () => {
        const service = ["model", "runtime", "draft", "commit", "shared"]
            .map((owner) => readFileContent(path.join(CORE_SRC_DIR, `reverse/reverse-accept-service-${owner}.ts`)))
            .join("\n");
        for (const forbidden of [
            "deployment-target-io",
            "deployment-target-cas",
            "commitDeploymentSuccess",
            "assertCurrentDeploymentInputs",
            "fs.writeFile",
            "fs.unlink",
            "durableReplaceFile",
        ]) {
            expect(service).not.toContain(forbidden);
        }
        expect(service).toContain("computeDeploymentOperationKey");
        expect(service).toContain("acquireAllLocks");
        expect(service).toContain("tryAcquireAuthorityLockLease");
        expect(service).toContain("assetAuthorityLeaseProof");
        expect(service).toContain("settingsAuthorityLeaseProof");
        expect(service).toContain("prepareReverseAcceptDeploymentSuccessAuthority");
        expect(service).toContain("commitReverseAcceptVersionSelectionSuccessCrashDurable");
    });

    it("reverse-accept reconcile can re-read authorities but cannot write runtime targets", () => {
        const reconcile = readFileContent(path.join(CORE_SRC_DIR, "reverse/reverse-accept-reconcile.ts"));
        for (const forbidden of [
            "deployment-target-io",
            "deployment-target-cas",
            "commitDeploymentSuccess",
            "fs.writeFile",
            "fs.unlink",
            "durableReplaceFile",
        ]) {
            expect(reconcile).not.toContain(forbidden);
        }
        expect(reconcile).toContain("readDeploymentCommitReceipt");
        expect(reconcile).toContain("readDeploymentSuccessPostcondition");
        expect(reconcile).toContain("readAssetManifestAuthoritySet");
        expect(reconcile).toContain("confirmDurableRegularFileNoFollow");
        expect(reconcile).toContain("confirmDurableDirectoryNoFollow");
    });

    it("no reverse-accept module can import the runtime target writer pipeline", () => {
        const reverseModules = [
            "reverse/reverse-accept-marker.ts",
            "reverse/reverse-accept-service.ts",
            "reverse/reverse-accept-reconcile.ts",
        ];
        for (const moduleName of reverseModules) {
            const source = readFileContent(path.join(CORE_SRC_DIR, moduleName));
            for (const forbidden of [
                "deployment-executor",
                "deployment-target-io",
                "deployment-target-cas",
                "deployment-target-entries",
                "deployment-target-plan",
                "deployment-target-verify",
            ]) {
                expect(source, `${moduleName} imported ${forbidden}`).not.toContain(forbidden);
            }
        }
    });
});

function sourceStringFragments(file: string): string[] {
    const source = ts.createSourceFile(file, readFileContent(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const values: string[] = [];
    const visit = (node: ts.Node): void => {
        if (
            ts.isStringLiteral(node) ||
            ts.isNoSubstitutionTemplateLiteral(node) ||
            ts.isTemplateHead(node) ||
            ts.isTemplateMiddle(node) ||
            ts.isTemplateTail(node)
        ) {
            values.push(node.text);
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return values;
}

describe("architecture: reverse-accept DB authority seams stay private", () => {
    const privateSymbols = [
        {
            name: "runDedicatedFullTransactionForTest",
            owners: ["persistence/full-transaction-connection.ts", "deployment/deployment-state-authority-commit.ts"],
        },
        {
            name: "validateDedicatedFullConfigurationForTest",
            owners: ["persistence/full-transaction-connection.ts"],
        },
        {
            name: "commitReverseAcceptSuccessCrashDurableForTest",
            owners: ["deployment/deployment-state-authority.ts", "deployment/deployment-state-authority-commit.ts"],
        },
        {
            name: "commitReverseAcceptVersionSelectionSuccessCrashDurableForTest",
            owners: ["deployment/deployment-state-authority.ts", "deployment/deployment-state-authority-commit.ts"],
        },
        {
            name: "validateCanonicalDeploymentPreCommitDatabaseStateForTest",
            owners: ["deployment/deployment-state-authority.ts", "deployment/deployment-state-authority-validation.ts"],
        },
        {
            name: "validateDeploymentCommitReceiptReadbackForTest",
            owners: ["deployment/deployment-state-authority.ts", "deployment/deployment-state-authority-validation.ts"],
        },
        {
            name: "insertDeploymentCommitReceiptInCurrentTransaction",
            owners: ["deployment/deployment-commit-receipts.ts", "deployment/deployment-state-authority-commit.ts"],
        },
        {
            name: "readDeploymentCommitReceiptFromConnection",
            owners: [
                "deployment/deployment-commit-receipts.ts",
                "deployment/deployment-state-authority-commit.ts",
                "deployment/deployment-state-authority-validation.ts",
            ],
        },
    ] as const;

    for (const symbol of privateSymbols) {
        it(`${symbol.name} has only its declared core/src owners`, () => {
            const allowed = new Set(symbol.owners.map((owner) => path.join(CORE_SRC_DIR, owner)));
            const violators = walkDir(CORE_SRC_DIR).filter(
                (file) => !allowed.has(file) && readFileContent(file).includes(symbol.name),
            );
            const rel = violators.map((file) => path.relative(ROOT_DIR, file));
            expect(rel, `${symbol.name} escaped its authority owners: ${rel.join(", ")}`).toEqual([]);
        });
    }
});

describe("architecture: native Guidance observation seams are test-only", () => {
    const testOnlySymbols = [
        ["findVerifiedNativeProjectGuidanceBuildForTest", "native-project-guidance-observation.ts"],
        ["makeVerifiedNativeProjectGuidanceTargetContextForTest", "native-project-guidance-observation.ts"],
        ["resolveObservedNativeProjectGuidanceTargetContextForTest", "native-project-guidance-observation.ts"],
        ["nativeProjectGuidanceRegistryComponentsForTest", "native-project-guidance-behavior.ts"],
    ] as const;

    for (const [symbol, ownerName] of testOnlySymbols) {
        it(`${symbol} has no production consumer outside its owner`, () => {
            const owners = new Set([
                path.join(CORE_SRC_DIR, "render/native-project-guidance.ts"),
                path.join(CORE_SRC_DIR, "render", ownerName),
            ]);
            const violators = walkDir(CORE_SRC_DIR).filter((file) => !owners.has(file) && readFileContent(file).includes(symbol));
            expect(
                violators.map((file) => path.relative(ROOT_DIR, file)),
                `${symbol} must not escape its test-only owner`,
            ).toEqual([]);
        });
    }
});

describe("architecture: Core mutation-scope scan seam is test-only", () => {
    it("createCoreMutationScopeGateForTest is referenced only by its owner under core/src", () => {
        const symbol = "createCoreMutationScopeGateForTest";
        const owner = path.join(CORE_SRC_DIR, "orchestration/core-mutation-scope.ts");
        const violators = walkDir(CORE_SRC_DIR).filter((file) => file !== owner && readFileContent(file).includes(symbol));
        const rel = violators.map((file) => path.relative(ROOT_DIR, file));
        expect(rel, `${symbol} escaped into production: ${rel.join(", ")}`).toEqual([]);
    });
});

describe("architecture: CoreService dependency seam is test-only", () => {
    it("createCoreServiceForTest is referenced only by its owner under core/src", () => {
        const symbol = "createCoreServiceForTest";
        const owner = path.join(CORE_SRC_DIR, "orchestration/core-service.ts");
        const violators = walkDir(CORE_SRC_DIR).filter((file) => file !== owner && readFileContent(file).includes(symbol));
        const rel = violators.map((file) => path.relative(ROOT_DIR, file));
        expect(rel, `${symbol} escaped into production: ${rel.join(", ")}`).toEqual([]);
    });
});

describe("architecture: deployment authority helpers stay inside reviewed owners", () => {
    const reviewed: ReadonlyArray<{
        symbol: string;
        owners: readonly string[];
    }> = [
        {
            symbol: "loadRenderBaseAuthority",
            owners: [
                "orchestration/deployment-render-service.ts",
                "orchestration/deployment-inspection-service.ts",
                "orchestration/deployment-lifecycle-projection.ts",
            ],
        },
        {
            symbol: "prepareRenderOperation",
            owners: [
                "orchestration/deployment-render-service.ts",
                "orchestration/deployment-inspection-service.ts",
                "orchestration/deployment-lifecycle-projection.ts",
            ],
        },
        {
            symbol: "runAnalysis",
            owners: ["orchestration/deployment-render-service.ts", "orchestration/deployment-lifecycle-projection.ts"],
        },
        {
            symbol: "projectDeploymentSuccessAuthority",
            owners: [
                "deployment/deployment-success-projection.ts",
                "deployment/deployment-executor.ts",
                "orchestration/deployment-lifecycle-execution.ts",
            ],
        },
        {
            symbol: "applyRuntimeReplacementAuthority",
            owners: [
                "deployment/deployment-target-replacement.ts",
                "deployment/local-target-transaction.ts",
                "deployment/restricted-target-graph-operation.ts",
            ],
        },
        {
            symbol: "commitDeploymentObservation",
            owners: ["deployment/deployment-observation-state-ops.ts", "orchestration/deployment-inspection-service.ts"],
        },
    ];

    for (const entry of reviewed) {
        it(`${entry.symbol} has no production consumer outside its reviewed owners`, () => {
            const allowed = new Set(entry.owners.map((owner) => path.join(CORE_SRC_DIR, owner)));
            const violators = walkDir(CORE_SRC_DIR).filter(
                (file) => !allowed.has(file) && readFileContent(file).includes(entry.symbol),
            );
            const rel = violators.map((file) => path.relative(ROOT_DIR, file));
            expect(rel, `${entry.symbol} escaped its authority boundary: ${rel.join(", ")}`).toEqual([]);
        });
    }
});

describe("architecture: T5 inspection/lifecycle helper seams are test-only", () => {
    for (const [symbol, ownerName] of [
        ["deploymentInspectionInternalsForTest", "orchestration/deployment-inspection-service.ts"],
        ["deploymentLifecycleInternalsForTest", "orchestration/deployment-lifecycle-service.ts"],
        ["deploymentRenderServiceInternalsForTest", "orchestration/deployment-render-service.ts"],
        ["coreServiceInternalsForTest", "orchestration/core-service.ts"],
        ["adapterEnablementServiceInternalsForTest", "orchestration/adapter-enablement-service.ts"],
    ] as const) {
        it(`${symbol} is referenced only by its owner under core/src`, () => {
            const owner = path.join(CORE_SRC_DIR, ownerName);
            const implementation =
                symbol === "deploymentLifecycleInternalsForTest"
                    ? path.join(CORE_SRC_DIR, "orchestration/deployment-lifecycle-execution.ts")
                    : owner;
            const violators = walkDir(CORE_SRC_DIR).filter(
                (file) => file !== owner && file !== implementation && readFileContent(file).includes(symbol),
            );
            const rel = violators.map((file) => path.relative(ROOT_DIR, file));
            expect(rel, `${symbol} escaped into production: ${rel.join(", ")}`).toEqual([]);
        });
    }
});

describe("architecture: catalog action-time fault seams are test-only", () => {
    for (const [symbol, ownerName] of [
        ["createCoreProjectServiceForTest", "orchestration/core-project-service.ts"],
        ["createCoreAssetServiceForTest", "orchestration/core-asset-service.ts"],
        ["createCoreDeploymentCatalogServiceForTest", "orchestration/core-deployment-service.ts"],
    ] as const) {
        it(`${symbol} is referenced only by its owner under core/src`, () => {
            const owner = path.join(CORE_SRC_DIR, ownerName);
            const violators = walkDir(CORE_SRC_DIR).filter((file) => file !== owner && readFileContent(file).includes(symbol));
            const rel = violators.map((file) => path.relative(ROOT_DIR, file));
            expect(rel, `${symbol} escaped into production: ${rel.join(", ")}`).toEqual([]);
        });
    }
});

describe("architecture: public adapter contract remains plan-free and runtime exports are explicit", () => {
    const coreIndex = readFileContent(path.join(CORE_SRC_DIR, "index.ts"));
    const coreTypes = readFileContent(path.join(CORE_SRC_DIR, "types.ts"));
    const adapterFiles = walkDir(path.resolve(ROOT_DIR, "packages/adapter")).filter(
        (file) => file.includes(`${path.sep}src${path.sep}`) && !file.includes(`${path.sep}node_modules${path.sep}`),
    );
    const registry = readFileContent(path.join(CORE_SRC_DIR, "orchestration/adapter-registry.ts"));

    it("keeps types.ts type-only and limits index.ts to reviewed runtime helpers", () => {
        const typeBarrelExecutableExports = coreTypes
            .split("\n")
            .filter((line) => /^\s*export\s+(?!type\b|interface\b)/.test(line));
        expect(typeBarrelExecutableExports, "types.ts must remain type-only").toEqual([]);

        const namedRuntimeExports = [...coreIndex.matchAll(/export\s*\{([\s\S]*?)\}\s*from\s*["'][^"']+["'];/g)]
            .flatMap((match) => (match[1] ?? "").split(","))
            .map((name) => name.trim())
            .filter((name) => name.length > 0)
            .sort();
        expect(namedRuntimeExports).toEqual([
            "BUILTIN_ASSET_KINDS",
            "StateProfileRecoveryRequiredError",
            "createAdapterAssetSourceCapability",
            "createCoreService",
            "createNativeGlobalEncodedFileProviderSupport",
            "createNativeGlobalExactGraphProviderSupport",
            "createNativeGlobalGuidanceProviderSupport",
            "createNativeGlobalRuleProviderSupport",
            "createNativeProjectEncodedFileProviderSupport",
            "createNativeProjectExactFileProviderSupport",
            "createNativeProjectExactGraphProviderSupport",
            "createNativeProjectGuidanceProviderSupport",
            "createNativeProjectRuleProviderSupport",
            "createStateRestoreService",
            "createVerifiedNativeGlobalEncodedFileBuild",
            "createVerifiedNativeGlobalExactGraphBuild",
            "createVerifiedNativeGlobalGuidanceBuild",
            "createVerifiedNativeGlobalRuleBuild",
            "createVerifiedNativeProjectEncodedFileBuild",
            "createVerifiedNativeProjectExactFileBuild",
            "createVerifiedNativeProjectExactGraphBuild",
            "createVerifiedNativeProjectGuidanceBuild",
            "createVerifiedNativeProjectRuleBuild",
            "inferCanonicalMediaType",
            "jsoncDiffIsOneTopLevelPropertyValue",
            "readJsoncTopLevelPropertyValue",
            "rebindAdapterRenderAnalysisOptionFingerprints",
            "reconcileStateRestoreBeforeStartup",
            "replaceJsoncTopLevelPropertyValue",
            "resolveObservedNativeProjectGuidanceTargetContext",
            "resolveTargetBuildCompatibility",
        ]);
        expect(coreIndex).toContain("export type { CoreServiceConfiguration }");
        expect(coreIndex).not.toContain("CoreServiceTestConfiguration");
        expect(coreIndex).not.toContain("createCoreServiceForTest");
        const unreviewedExportForms = coreIndex.split("\n").filter((line) => /^\s*export\s+(?!type\b|\{)/.test(line));
        expect(unreviewedExportForms).toEqual([]);
    });

    it("derives concrete agent-runtime knowledge from providers and keeps it out of Core", () => {
        const forbidden = new Set<string>([".claude/", ".gemini/", ".opencode/"]);
        for (const provider of BUILTIN_ADAPTER_PROVIDERS) {
            forbidden.add(provider.adapterId);
            for (const descriptor of provider.agentRuntimes) {
                forbidden.add(descriptor.agentRuntimeId);
            }
            for (const schema of provider.targetContextSchemas) {
                forbidden.add(schema.targetContextSchemaId);
            }
            for (const declaration of provider.renderContractDeclarations) {
                forbidden.add(declaration.outputContractId);
                forbidden.add(declaration.materializationProfileId);
                if (declaration.declarationKind === "native_project_guidance_v1") {
                    forbidden.add(declaration.target.relativePath);
                } else if (declaration.declarationKind === "native_project_rule_v1") {
                    forbidden.add(declaration.target.relativeDirectory);
                }
                forbidden.add(declaration.target.targetContextSchemaId);
                for (const build of declaration.verifiedBuilds) {
                    forbidden.add(build.buildIdentity);
                    forbidden.add(build.materializationProfileId);
                    forbidden.add(build.fixtureSetFingerprint);
                }
            }
            for (const contract of [...provider.dialectContracts.native, ...provider.dialectContracts.restoration]) {
                forbidden.add(contract.definition.dialectId);
            }
        }
        const coreProduction = walkDir(CORE_SRC_DIR);
        const executableStrings = new Map(coreProduction.map((file) => [file, sourceStringFragments(file)]));
        for (const fragment of forbidden) {
            const violators = coreProduction.filter((file) =>
                executableStrings.get(file)?.some((value) => value.includes(fragment)),
            );
            expect(
                violators.map((file) => path.relative(ROOT_DIR, file)),
                `concrete agent-runtime knowledge escaped its adapter owner: ${fragment}`,
            ).toEqual([]);
        }
    });

    it("keeps source fingerprint and canonical media policy out of adapter families", () => {
        const forbidden = ["oaam.adapter.source-capability.v1", "function fingerprintSourceCapability", "function mediaTypeFor"];
        for (const fragment of forbidden) {
            const violators = adapterFiles.filter((file) => readFileContent(file).includes(fragment));
            expect(
                violators.map((file) => path.relative(ROOT_DIR, file)),
                `Core-owned adapter policy was copied into a family: ${fragment}`,
            ).toEqual([]);
        }
    });

    it("legacy AdapterCapabilities/entryKinds/plan DTOs are absent from production source", () => {
        const forbidden = [
            "AdapterCapabilities",
            "entryKinds",
            "DeploymentPlanInput",
            "TargetPlanResult",
            "dispatchPlan",
            "AssetTypeDataV1",
        ];
        const productionFiles = [...walkDir(CORE_SRC_DIR), ...adapterFiles];
        for (const symbol of forbidden) {
            const violators = productionFiles.filter((file) => readFileContent(file).includes(symbol));
            expect(
                violators.map((file) => path.relative(ROOT_DIR, file)),
                `${symbol} must not survive the atomic public-contract cutover`,
            ).toEqual([]);
        }
    });

    it("physical TargetPlan remains internal to core and never enters adapter source", () => {
        expect(coreIndex.includes("TargetPlan")).toBe(false);
        expect(coreTypes.includes("TargetPlan")).toBe(false);
        const adapterLeaks = adapterFiles.filter((file) => readFileContent(file).includes("TargetPlan"));
        expect(adapterLeaks.map((file) => path.relative(ROOT_DIR, file))).toEqual([]);
    });

    it("registry dispatches final lifecycle names and has no provider plan call", () => {
        expect(registry).toContain("dispatchAnalyzeRender");
        expect(registry).toContain("dispatchMaterializeRender");
        expect(registry).toContain("dispatchInspectRenderedTarget");
        expect(registry).not.toContain(".plan(");
    });

    it("only explicitly named adapter probe modules may inspect the filesystem directly", () => {
        const forbiddenImports = [/["'](?:node:)?fs(?:\/promises)?["']/, /["']@oaam\/shared\/filesystem["']/];
        const isProbeModule = (file: string) => /-probe(?:-[a-z0-9-]+)?\.ts$/.test(path.basename(file));
        expect(isProbeModule("antigravity-probe.ts")).toBe(true);
        expect(isProbeModule("antigravity-probe-projects.ts")).toBe(true);
        expect(isProbeModule("antigravity-source-read.ts")).toBe(false);
        expect(isProbeModule("antigravity-reader.ts")).toBe(false);
        const violations = adapterFiles.filter(
            (file) => !isProbeModule(file) && forbiddenImports.some((pattern) => pattern.test(readFileContent(file))),
        );
        expect(violations.map((file) => path.relative(ROOT_DIR, file))).toEqual([]);
    });

    it("probe whole-file reads and directory scans use the shared physical bound", () => {
        const probeModules = [
            "packages/adapter/providers/antigravity/src/antigravity-probe-installation.ts",
            "packages/adapter/providers/antigravity/src/antigravity-probe-projects.ts",
            "packages/adapter/providers/claudecode/src/claudecode-probe.ts",
            "packages/adapter/providers/codex/src/codex-probe-installation.ts",
        ];
        for (const relativePath of probeModules) {
            const source = readFileContent(path.join(ROOT_DIR, relativePath));
            expect(source, relativePath).not.toMatch(/\b(?:fs\.)?(?:readFileSync|readdirSync)\s*\(/);
            expect(source, relativePath).toMatch(/read(?:RegularFile|DirectoryEntries)Bounded/);
        }

        const sharedSources = walkDir(path.join(ROOT_DIR, "packages/shared/src"));
        const lowLevelUsers = sharedSources.filter((file) => readFileContent(file).includes("readOpenedDirectoryEntriesBounded"));
        expect(lowLevelUsers.map((file) => path.basename(file)).sort()).toEqual([
            "directory-member-observation.ts",
            "safe-filesystem.ts",
        ]);
    });

    it("filesystem failure and physical-sample facts have one shared owner", () => {
        const sharedSourceRoot = path.join(ROOT_DIR, "packages/shared/src");
        const factOwner = path.join(sharedSourceRoot, "filesystem/filesystem-facts.ts");
        const duplicateFactDeclaration = /function\s+(?:errnoCode|failureKindFor|safeError|sameIdentity|sameStableSample)\s*\(/;
        const duplicateOwners = walkDir(sharedSourceRoot).filter(
            (file) => file !== factOwner && duplicateFactDeclaration.test(readFileContent(file)),
        );
        expect(duplicateOwners.map((file) => path.relative(ROOT_DIR, file))).toEqual([]);
        for (const consumer of ["safe-filesystem.ts", "bounded-io.ts"]) {
            expect(readFileContent(path.join(sharedSourceRoot, "paths/unix-like", consumer)), consumer).toContain(
                'from "../../filesystem/filesystem-facts"',
            );
        }

        for (const providerConsumer of [
            "packages/adapter/providers/antigravity/src/antigravity-probe-foundation.ts",
            "packages/adapter/providers/claudecode/src/claudecode-probe.ts",
            "packages/adapter/providers/codex/src/codex-probe-foundation.ts",
            "packages/adapter/providers/codex/src/codex-probe-installation.ts",
            "packages/adapter/providers/opencode/src/opencode-probe.ts",
        ]) {
            const source = readFileContent(path.join(ROOT_DIR, providerConsumer));
            expect(source, providerConsumer).toContain("inspectFilesystemFailure");
            expect(source, providerConsumer).not.toMatch(/function\s+(?:isErrno|errorCode)\s*\(/);
        }
    });

    it("keeps every public Win32 Recycle Bin handoff outside the caller process", () => {
        const backend = readFileContent(path.join(ROOT_DIR, "packages/shared/src/paths/win32/filesystem-backend.ts"));
        expect(backend).toContain("recycleWorker(native");
        expect(backend).not.toContain(".removeRegularFile(");
        expect(backend).not.toContain(".removeDirectoryTree(");
    });

    it("OpenCode canonical absolute paths have one family-local owner", () => {
        const opencodeRoot = path.join(ROOT_DIR, "packages/adapter/providers/opencode/src");
        const pathOwner = path.join(opencodeRoot, "opencode-paths.ts");
        const duplicateOwners = walkDir(opencodeRoot).filter(
            (file) =>
                file !== pathOwner &&
                /function\s+(?:canonicalAbsolute|canonicalOpencodeAbsolutePath)\s*\(/.test(readFileContent(file)),
        );
        expect(duplicateOwners.map((file) => path.relative(ROOT_DIR, file))).toEqual([]);
        expect(readFileContent(pathOwner)).toContain("export function canonicalOpencodeAbsolutePath");
        expect(readFileContent(path.join(opencodeRoot, "opencode-probe.ts"))).toContain("canonicalOpencodeAbsolutePath");
    });

    it("portable path and relative-reference mechanics have one adapter-framework owner", () => {
        const ownerPath = path.join(ROOT_DIR, "packages/adapter/framework/src/source-text.ts");
        const owner = readFileContent(ownerPath);
        for (const symbol of ["portablePathWithoutExtension", "isPortablePathAtOrBelow", "normalizePortableRelativeReference"]) {
            expect(owner).toContain(`export function ${symbol}`);
        }

        const duplicatePathOwner =
            /export\s+function\s+(?:withoutExtension|isWithin)\s*\(|for\s*\(const\s+segment\s+of\s+rawTarget\.split\("\/"\)\)/;
        const violations = adapterFiles.filter((file) => file !== ownerPath && duplicatePathOwner.test(readFileContent(file)));
        expect(violations.map((file) => path.relative(ROOT_DIR, file))).toEqual([]);

        for (const family of ["antigravity", "claudecode", "opencode"]) {
            const foundation = readFileContent(
                path.join(ROOT_DIR, `packages/adapter/providers/${family}/src/${family}-source-read-foundation.ts`),
            );
            expect(foundation, family).toContain("portablePathWithoutExtension as withoutExtension");
            expect(foundation, family).toContain("isPortablePathAtOrBelow as isWithin");
            expect(foundation, family).toContain("normalizePortableRelativeReference");
        }
    });

    it("bounded frontmatter diagnostic projection has one adapter-framework owner", () => {
        const owner = readFileContent(path.join(ROOT_DIR, "packages/adapter/framework/src/source-frontmatter.ts"));
        expect(owner).toContain("export function projectBoundedFrontmatterDiagnostics");

        const duplicateProjection = /parsed\.diagnostics\.map|!parsed\.hasFrontmatter\s*\|\|\s*parsed\.closed/;
        const violations = adapterFiles.filter((file) => duplicateProjection.test(readFileContent(file)));
        expect(violations.map((file) => path.relative(ROOT_DIR, file))).toEqual([]);

        for (const relativePath of [
            "packages/adapter/providers/antigravity/src/antigravity-source-read-foundation.ts",
            "packages/adapter/providers/claudecode/src/claudecode-source-read-foundation.ts",
            "packages/adapter/providers/opencode/src/opencode-source-read-fields.ts",
        ]) {
            expect(readFileContent(path.join(ROOT_DIR, relativePath)), relativePath).toContain(
                "projectBoundedFrontmatterDiagnostics",
            );
        }
    });

    it("adapter production sources use only the reviewed static read-only filesystem surface", () => {
        const violations = adapterFiles.flatMap((file) => collectAdapterFilesystemAuthorityViolations(file));
        expect(violations).toEqual([]);
    });

    it("adapter production sources use local process observation only through Framework", () => {
        const violations = adapterFiles.flatMap((file) => collectAdapterProcessObservationAuthorityViolations(file));
        expect(violations).toEqual([]);
    });

    it("keeps Provider physical identity sampling inside explicit probe modules", () => {
        const owner = path.join(ROOT_DIR, "packages/adapter/framework/src/provider-probe-filesystem.ts");
        const barrel = path.join(ROOT_DIR, "packages/adapter/framework/src/index.ts");
        const helperNames = [
            "inspectProviderDirectoryNoFollow",
            "inspectProviderRegularFileNoFollow",
            "inventoryProviderDirectoryNoFollow",
            "readProviderRegularFileNoFollow",
            "readProviderRegularFileRangeNoFollow",
            "sameProviderPathIdentity",
            "sameProviderRegularFileIdentity",
            "snapshotProviderRegularFileNoFollow",
        ];
        const violations = adapterFiles.filter(
            (file) =>
                file !== owner &&
                file !== barrel &&
                helperNames.some((name) => readFileContent(file).includes(name)) &&
                !/-probe(?:-[a-z0-9-]+)?\.ts$/.test(path.basename(file)),
        );
        expect(violations.map((file) => path.relative(ROOT_DIR, file))).toEqual([]);
    });

    it("keeps Provider local process observation inside explicit probe modules", () => {
        const owner = path.join(ROOT_DIR, "packages/adapter/framework/src/provider-probe-process.ts");
        const barrel = path.join(ROOT_DIR, "packages/adapter/framework/src/index.ts");
        const violations = adapterFiles.filter(
            (file) =>
                file !== owner &&
                file !== barrel &&
                (readFileContent(file).includes("observeProviderLocalProcessBounded") ||
                    readFileContent(file).includes("observeProviderLocalProcessExecutableBounded") ||
                    readFileContent(file).includes("listProviderLocalProcessIdsBounded") ||
                    readFileContent(file).includes("invokeProviderLocalExecutableTreeBounded")) &&
                !/-probe(?:-[a-z0-9-]+)?\.ts$/.test(path.basename(file)),
        );
        expect(violations.map((file) => path.relative(ROOT_DIR, file))).toEqual([]);
        expect(readFileContent(barrel)).not.toContain("invokeProviderLocalExecutableTreeBoundedForTest");
        expect(
            adapterFiles
                .filter(
                    (file) => file !== owner && readFileContent(file).includes("invokeProviderLocalExecutableTreeBoundedForTest"),
                )
                .map((file) => path.relative(ROOT_DIR, file)),
        ).toEqual([]);
    });

    it("keeps exact-build OpenCode discovery primary and confines the compatibility database reader", () => {
        const root = path.join(ROOT_DIR, "packages/adapter/providers/opencode");
        const manifest = JSON.parse(readFileContent(path.join(root, "package.json"))) as {
            readonly dependencies?: Record<string, string>;
        };
        expect(manifest.dependencies?.["better-sqlite3"]).toBe("^12.11.1");
        const production = walkDir(path.join(root, "src"));
        const reader = path.join(root, "src/opencode-compatibility-project-reader.ts");
        const coordinator = path.join(root, "src/opencode-probe-compatibility-database.ts");
        expect(production).toContain(reader);
        expect(production).toContain(coordinator);
        expect(
            production
                .filter((file) => readFileContent(file).includes("better-sqlite3"))
                .map((file) => path.relative(ROOT_DIR, file).split(path.sep).join("/")),
        ).toEqual(["packages/adapter/providers/opencode/src/opencode-compatibility-project-reader.ts"]);
        expect(readFileContent(path.join(root, "src/opencode-probe-stopped-project-discovery.ts"))).toContain(
            "invokeProviderLocalExecutableTreeBounded",
        );
        expect(readFileContent(path.join(root, "src/opencode-probe-project-discovery.ts"))).toContain(
            "discoverOpenCodeCompatibilityDatabase",
        );
        for (const file of [reader, coordinator]) {
            expect(readFileContent(file), path.relative(ROOT_DIR, file)).not.toMatch(
                /\b(?:journal_mode|wal_checkpoint|checkpoint|vacuum|reindex|attach|detach)\b/i,
            );
        }
        expect(readFileContent(reader)).toContain("query_only = ON");
        expect(readFileContent(reader)).toContain("readonly: true");
        expect(readFileContent(reader)).toContain("fileMustExist: true");
        expect(readFileContent(coordinator)).toContain("opencode_compatibility_database_nonempty_wal");
    });

    it("CoreService composes the executor without importing physical target I/O", () => {
        const service = readFileContent(path.join(CORE_SRC_DIR, "orchestration/core-service.ts"));
        expect(service).toContain('from "../deployment/deployment-executor"');
        for (const forbidden of ["deployment-target-io", "deployment-target-cas", "deployment-target-verify"]) {
            expect(service).not.toContain(forbidden);
        }
    });

    it("physical target mutation primitives remain inside target I/O, CAS, publication, and recovery", () => {
        const allowed = new Set([
            "deployment/deployment-target-io.ts",
            "deployment/deployment-target-cas.ts",
            "deployment/deployment-publication.ts",
            "deployment/deployment-recovery.ts",
            "deployment/deployment-file-recovery.ts",
        ]);
        const violators = walkDir(CORE_SRC_DIR).filter(
            (file) =>
                /\bio(?:Write|Delete)\s*\(/.test(readFileContent(file)) &&
                !allowed.has(path.relative(CORE_SRC_DIR, file).split(path.sep).join("/")),
        );
        expect(violators.map((file) => path.relative(ROOT_DIR, file))).toEqual([]);
    });
});
