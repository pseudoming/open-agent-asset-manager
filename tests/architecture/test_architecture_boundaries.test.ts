import * as fs from "node:fs";
import * as path from "node:path";
import { PROTOCOL_OPERATION_NAMES } from "@oaam/app-server-protocol";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import { validateAdapterProviderRegistration } from "../../packages/core/src/adapters/adapter-contract-validator";
import { BUILTIN_ADAPTER_PROVIDERS } from "../conformance/adapter-conformance-fixtures";
import { resolveWorkspaceGraph } from "../repository/workspace-graph.mjs";
import {
    CONCRETE_PROVIDER_IMPORTS,
    CORE_SRC_DIR,
    checkForbiddenImports,
    collectModuleSpecifiers,
    FORBIDDEN_ADAPTER_IMPORTS,
    FORBIDDEN_APP_SERVER_BOOTSTRAP_IMPORTS,
    FORBIDDEN_APP_SERVER_HOST_IMPORTS,
    FORBIDDEN_CLIENT_DESKTOP_BROWSER_IMPORTS,
    FORBIDDEN_CLIENT_DESKTOP_MAIN_IMPORTS,
    FORBIDDEN_CLIENT_DESKTOP_PRELOAD_IMPORTS,
    FORBIDDEN_CLIENT_FRAMEWORK_IMPORTS,
    FORBIDDEN_CLIENT_HEADLESS_IMPORTS,
    FORBIDDEN_CORE_IMPORTS,
    FORBIDDEN_PROTOCOL_IMPORTS,
    FORBIDDEN_SHARED_IMPORTS,
    ROOT_DIR,
    readFileContent,
    resolveArchitectureSourceRoots,
    walkAllFiles,
    walkDir,
} from "./architecture-test-fixtures";

const ARCHITECTURE_SOURCE_ROOTS = resolveArchitectureSourceRoots();

function sourceRootsFor(layer: (typeof ARCHITECTURE_SOURCE_ROOTS)[number]["layer"]): string[] {
    return ARCHITECTURE_SOURCE_ROOTS.filter((entry) => entry.layer === layer).map((entry) => entry.sourceRoot);
}

function onlySourceRoot(layer: (typeof ARCHITECTURE_SOURCE_ROOTS)[number]["layer"]): string {
    const roots = sourceRootsFor(layer);
    if (roots.length !== 1) {
        throw new Error(`expected exactly one ${layer} source root, found ${roots.length}`);
    }
    return roots[0];
}

describe("architecture: every live workspace has one reviewed layer", () => {
    it("derives architecture source roots from the live workspace graph", () => {
        expect(ARCHITECTURE_SOURCE_ROOTS.length).toBeGreaterThan(0);
        expect(new Set(ARCHITECTURE_SOURCE_ROOTS.map((entry) => entry.sourceRoot)).size).toBe(ARCHITECTURE_SOURCE_ROOTS.length);
    });
});

describe("architecture: built-in providers satisfy the frozen static contract", () => {
    it("register independently with exact Cartesian rows and canonical fingerprints", () => {
        for (const provider of BUILTIN_ADAPTER_PROVIDERS) {
            expect(validateAdapterProviderRegistration(provider, [])).toEqual([]);
        }
    });

    it("own globally distinct agent-runtime IDs without a fixed built-in count", () => {
        const diagnostics = BUILTIN_ADAPTER_PROVIDERS.flatMap((provider, index) =>
            validateAdapterProviderRegistration(provider, BUILTIN_ADAPTER_PROVIDERS.slice(0, index)),
        );
        expect(diagnostics).toEqual([]);
        const agentRuntimeIds = BUILTIN_ADAPTER_PROVIDERS.flatMap((provider) =>
            provider.agentRuntimes.map((entry) => entry.agentRuntimeId),
        );
        expect(new Set(agentRuntimeIds).size).toBe(agentRuntimeIds.length);
    });
});

describe("architecture: core must not import adapter or client", () => {
    const coreFiles = walkDir(CORE_SRC_DIR);

    it("core src should have TypeScript files", () => {
        expect(coreFiles.length).toBeGreaterThan(0);
    });

    it("no core file imports adapter/client packages (import statement)", () => {
        const violations = checkForbiddenImports(coreFiles, FORBIDDEN_CORE_IMPORTS);
        expect(violations).toEqual([]);
    });
});

describe("architecture: core tests must not import concrete adapters", () => {
    const coreTestFiles = walkDir(path.resolve(ROOT_DIR, "packages/core/tests"));
    const adapterPatterns = [
        /@oaam\/adapter-/,
        /(?:^|\/)adapter\/(?:antigravity|claudecode|codex|opencode|zcode)(?:\/|$)/,
        /adapter-(?:antigravity|claudecode|codex|opencode|zcode)/,
    ];

    it("keeps cross-provider conformance under the repository-level test boundary", () => {
        const violations = checkForbiddenImports(coreTestFiles, adapterPatterns);
        expect(violations).toEqual([]);
    });
});

describe("architecture: core may import shared (allowed direction)", () => {
    it("core importing shared should not be flagged as violation", () => {
        expect(FORBIDDEN_CORE_IMPORTS.some((p) => p.test("@oaam/shared/filesystem"))).toBe(false);
        expect(FORBIDDEN_CORE_IMPORTS.some((p) => p.test("@oaam/shared/paths"))).toBe(false);
    });
});

describe("architecture: Shared owns Host-visible physical path mechanics", () => {
    const sharedOwner = path.resolve(ROOT_DIR, "packages/shared/src/paths/physical-access-paths.ts");
    const retiredCoreOwner = path.resolve(CORE_SRC_DIR, "foundation/physical-access-paths.ts");
    const frameworkManifest = JSON.parse(
        fs.readFileSync(path.resolve(ROOT_DIR, "packages/adapter/framework/package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };

    it("keeps the one implementation in Shared and removes the former Core owner", () => {
        expect(fs.existsSync(sharedOwner)).toBe(true);
        expect(fs.existsSync(retiredCoreOwner)).toBe(false);
        const implementations = ARCHITECTURE_SOURCE_ROOTS.flatMap((entry) => walkDir(entry.sourceRoot))
            .filter(
                (file) => file.endsWith(".ts") && readFileContent(file).includes("function getCanonicalPhysicalAccessPathKind"),
            )
            .map((file) => path.relative(ROOT_DIR, file).split(path.sep).join("/"));
        expect(implementations).toEqual(["packages/shared/src/paths/physical-access-paths.ts"]);
    });

    it("makes Framework consume Shared directly instead of a Core re-export", () => {
        const probePaths = path.resolve(ROOT_DIR, "packages/adapter/framework/src/probe-paths.ts");
        const probePathSource = readFileContent(probePaths);
        expect(collectModuleSpecifiers(probePaths)).toContain("@oaam/shared/paths");
        expect(probePathSource).toContain("return canonicalPhysicalAccessPath(value);");
        expect(probePathSource).not.toContain('.normalize("NFC")');
        expect(frameworkManifest.dependencies?.["@oaam/shared"]).toBe("^0.1.0");
        expect(readFileContent(path.resolve(CORE_SRC_DIR, "index.ts"))).not.toContain("getCanonicalPhysicalAccessPathKind");
    });

    it("keeps physical platform grammar out of Core while preserving reviewed logical POSIX paths", () => {
        const grammarUsers = new Map<"win32" | "posix", string[]>([
            ["win32", []],
            ["posix", []],
        ]);
        for (const file of walkDir(CORE_SRC_DIR)) {
            const used = collectNodePathGrammarUses(file);
            for (const grammar of used)
                grammarUsers.get(grammar)?.push(path.relative(CORE_SRC_DIR, file).split(path.sep).join("/"));
        }
        expect(grammarUsers.get("win32")).toEqual([]);
        expect(grammarUsers.get("posix")?.sort()).toEqual(["foundation/physical-path-locks.ts", "foundation/validators.ts"]);
    });
});

function collectNodePathGrammarUses(file: string): Set<"win32" | "posix"> {
    const source = ts.createSourceFile(file, readFileContent(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const namespaceAliases = new Set<string>();
    const used = new Set<"win32" | "posix">();
    for (const statement of source.statements) {
        if (
            !ts.isImportDeclaration(statement) ||
            !ts.isStringLiteralLike(statement.moduleSpecifier) ||
            statement.moduleSpecifier.text !== "node:path"
        ) {
            continue;
        }
        const bindings = statement.importClause?.namedBindings;
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) namespaceAliases.add(bindings.name.text);
        if (bindings !== undefined && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
                const imported = (element.propertyName ?? element.name).text;
                if (imported === "win32" || imported === "posix") used.add(imported);
            }
        }
    }
    const visit = (node: ts.Node): void => {
        if (
            ts.isPropertyAccessExpression(node) &&
            ts.isIdentifier(node.expression) &&
            namespaceAliases.has(node.expression.text)
        ) {
            if (node.name.text === "win32" || node.name.text === "posix") used.add(node.name.text);
        }
        if (
            ts.isElementAccessExpression(node) &&
            ts.isIdentifier(node.expression) &&
            namespaceAliases.has(node.expression.text) &&
            ts.isStringLiteralLike(node.argumentExpression) &&
            (node.argumentExpression.text === "win32" || node.argumentExpression.text === "posix")
        ) {
            used.add(node.argumentExpression.text);
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return used;
}

describe("architecture: privileged Core filesystem mechanics have exact owners", () => {
    const coreFiles = walkDir(CORE_SRC_DIR);
    const databaseOwner = path.join(CORE_SRC_DIR, "persistence/db.ts");
    const runtimeTargetOwner = path.join(CORE_SRC_DIR, "deployment/deployment-target-io.ts");

    function directFsCalls(file: string): string[] {
        return [...readFileContent(file).matchAll(/\bfs\.([A-Za-z][A-Za-z0-9]*)\s*\(/gu)]
            .map((match) => match[1])
            .filter((name): name is string => name !== undefined)
            .sort();
    }

    it("keeps runtime targets on the target-built Shared filesystem and node:fs only for immutable schema loading", () => {
        expect(
            coreFiles
                .filter((file) =>
                    collectModuleSpecifiers(file).some(
                        (specifier) => specifier === "node:fs" || specifier === "node:fs/promises",
                    ),
                )
                .map((file) => path.relative(CORE_SRC_DIR, file).split(path.sep).join("/"))
                .sort(),
        ).toEqual(["persistence/db.ts"]);
        expect(directFsCalls(databaseOwner)).toEqual(["readFileSync"]);
        expect(directFsCalls(runtimeTargetOwner)).toEqual([]);
        const targetSource = readFileContent(runtimeTargetOwner);
        for (const mechanism of [
            "readRegularFileNoFollow",
            "durableReplaceFile",
            "durableRemoveRegularFile",
            "inspectFilesystemFailure",
        ]) {
            expect(targetSource).toContain(mechanism);
        }
        expect(targetSource).not.toContain("WINDOWS_RUNTIME_TARGET_MUTATION_NOT_ACTIVATED");
    });

    it("keeps logical Platform out of the physical target I/O context and target operation selectors", () => {
        const targetIoSource = ts.createSourceFile(
            runtimeTargetOwner,
            readFileContent(runtimeTargetOwner),
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        );
        const contextProperties: string[] = [];
        const factoryParameters: string[] = [];
        for (const statement of targetIoSource.statements) {
            if (ts.isInterfaceDeclaration(statement) && statement.name.text === "TargetIoContext") {
                for (const member of statement.members) {
                    if (ts.isPropertySignature(member) && member.name !== undefined) {
                        contextProperties.push(member.name.getText(targetIoSource));
                    }
                }
            }
            if (ts.isFunctionDeclaration(statement) && statement.name?.text === "createTargetIo") {
                factoryParameters.push(...statement.parameters.map((parameter) => parameter.name.getText(targetIoSource)));
            }
        }
        expect(contextProperties).toEqual(["targetRootPath"]);
        expect(factoryParameters).toEqual(["targetRootPath"]);

        const targetOperationFiles = [
            runtimeTargetOwner,
            path.join(CORE_SRC_DIR, "deployment/deployment-target-cas.ts"),
            path.join(CORE_SRC_DIR, "deployment/deployment-target-replacement.ts"),
            path.join(CORE_SRC_DIR, "deployment/deployment-target-verify.ts"),
            path.join(CORE_SRC_DIR, "deployment/deployment-recovery.ts"),
        ];
        const physicalSelectors: string[] = [];
        for (const file of targetOperationFiles) {
            const source = ts.createSourceFile(file, readFileContent(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
            const visit = (node: ts.Node): void => {
                if (
                    ts.isPropertyAccessExpression(node) &&
                    ts.isIdentifier(node.expression) &&
                    node.expression.text === "ctx" &&
                    node.name.text === "platform"
                ) {
                    physicalSelectors.push(path.relative(CORE_SRC_DIR, file));
                }
                ts.forEachChild(node, visit);
            };
            visit(source);
        }
        expect(physicalSelectors).toEqual([]);
    });

    it("routes every classified internal authority owner through Shared", () => {
        for (const relativePath of [
            "catalog/staging-commit.ts",
            "deployment/deployment-journal.ts",
            "deployment/deployment-payload-store.ts",
            "foundation/authority-locks.ts",
            "foundation/physical-path-locks.ts",
            "persistence/db.ts",
            "reverse/reverse-accept-marker-fields.ts",
        ]) {
            expect(collectModuleSpecifiers(path.join(CORE_SRC_DIR, relativePath)), relativePath).toContain(
                "@oaam/shared/filesystem",
            );
        }
    });
});

describe("architecture: core must have zero UI dependency", () => {
    const coreFiles = walkDir(CORE_SRC_DIR);

    it("no core file imports UI frameworks", () => {
        const uiPatterns = [/electron/, /react/, /vue/, /@angular/, /svelte/];
        const violations = checkForbiddenImports(coreFiles, uiPatterns);
        expect(violations).toEqual([]);
    });
});

describe("architecture: core must have zero runtime dependency", () => {
    const coreFiles = walkDir(CORE_SRC_DIR);

    it("no core file imports adapter packages", () => {
        const runtimePatterns = [
            /@oaam\/adapter-/,
            /adapter-antigravity/,
            /adapter-opencode/,
            /adapter-claudecode/,
            /adapter-codex/,
            /adapter-cursor/,
            /adapter-zcode/,
        ];
        const violations = checkForbiddenImports(coreFiles, runtimePatterns);
        expect(violations).toEqual([]);
    });
});

describe("architecture: core public barrels separate canonical types from reviewed runtime exports", () => {
    const indexPath = path.join(CORE_SRC_DIR, "index.ts");
    const typesPath = path.join(CORE_SRC_DIR, "types.ts");

    it("index.ts should exist", () => {
        expect(fs.existsSync(indexPath)).toBe(true);
    });

    it("keeps types.ts type-only and index.ts free of inline implementation", () => {
        const indexContent = readFileContent(indexPath);
        const typesContent = readFileContent(typesPath);
        expect(indexContent).toMatch(/export type/);
        expect(indexContent).not.toMatch(/export class\s+/);
        expect(indexContent).not.toMatch(/export function\s+/);
        expect(indexContent).not.toMatch(/export const\s+/);
        expect(indexContent).not.toMatch(/export interface\s+CoreImpl/);
        expect(typesContent.split("\n").filter((line) => /^\s*export\s+(?!type\b|interface\b)/.test(line))).toEqual([]);
    });
});

describe("architecture: Client Framework imports only the browser-safe Protocol", () => {
    const clientFiles = walkDir(onlySourceRoot("client_framework"));

    it("imports no Host, Core, Adapter, Node, Electron, or UI package", () => {
        expect(clientFiles.length).toBeGreaterThan(0);
        expect(checkForbiddenImports(clientFiles, FORBIDDEN_CLIENT_FRAMEWORK_IMPORTS)).toEqual([]);
    });

    it("allows only the Protocol workspace dependency", () => {
        expect(FORBIDDEN_CLIENT_FRAMEWORK_IMPORTS.some((pattern) => pattern.test("@oaam/app-server-protocol"))).toBe(false);
        for (const forbidden of ["@oaam/core", "@oaam/shared/filesystem", "@oaam/app-server-host", "@oaam/unknown"]) {
            expect(
                FORBIDDEN_CLIENT_FRAMEWORK_IMPORTS.some((pattern) => pattern.test(forbidden)),
                forbidden,
            ).toBe(true);
        }
    });
});

describe("architecture: technical Headless uses only Bootstrap, Host and Client communication boundaries", () => {
    const headlessFiles = walkDir(onlySourceRoot("client_headless"));

    it("imports no Core, Provider, Adapter Framework, Electron, or UI package", () => {
        expect(headlessFiles.length).toBeGreaterThan(0);
        expect(checkForbiddenImports(headlessFiles, FORBIDDEN_CLIENT_HEADLESS_IMPORTS)).toEqual([]);
    });

    it("declares exactly the four reviewed internal delivery dependencies", () => {
        const workspace = resolveWorkspaceGraph(ROOT_DIR).packages.find((entry) => entry.name === "@oaam/client-headless");
        expect(workspace?.internalDeliveryDependencyNames).toEqual([
            "@oaam/app-server-bootstrap",
            "@oaam/app-server-host",
            "@oaam/app-server-protocol",
            "@oaam/client-framework",
        ]);
    });
});

describe("architecture: Desktop keeps browser, preload and privileged process boundaries separate", () => {
    const desktopRoot = onlySourceRoot("client_desktop");
    const browserFiles = ["bridge", "renderer"].flatMap((directory) => walkDir(path.join(desktopRoot, directory)));
    const preloadFiles = walkDir(path.join(desktopRoot, "preload"));
    const privilegedFiles = ["host", "main", "process"].flatMap((directory) => walkDir(path.join(desktopRoot, directory)));

    it("keeps renderer-side code browser-safe and behind Protocol plus Client Framework", () => {
        expect(browserFiles.length).toBeGreaterThan(0);
        expect(checkForbiddenImports(browserFiles, FORBIDDEN_CLIENT_DESKTOP_BROWSER_IMPORTS)).toEqual([]);
    });

    it("keeps preload finite and free of OAAM, Node and React business imports", () => {
        expect(preloadFiles.length).toBeGreaterThan(0);
        expect(checkForbiddenImports(preloadFiles, FORBIDDEN_CLIENT_DESKTOP_PRELOAD_IMPORTS)).toEqual([]);
    });

    it("keeps privileged Desktop code out of Core, Provider, Framework and React", () => {
        expect(privilegedFiles.length).toBeGreaterThan(0);
        expect(checkForbiddenImports(privilegedFiles, FORBIDDEN_CLIENT_DESKTOP_MAIN_IMPORTS)).toEqual([]);
    });

    it("declares only the five reviewed OAAM delivery dependencies", () => {
        const workspace = resolveWorkspaceGraph(ROOT_DIR).packages.find((entry) => entry.name === "@oaam/client-desktop");
        expect(workspace?.internalDeliveryDependencyNames).toEqual([
            "@oaam/app-server-bootstrap",
            "@oaam/app-server-host",
            "@oaam/app-server-protocol",
            "@oaam/client-framework",
            "@oaam/shared",
        ]);
    });

    it("routes presentation persistence through Shared instead of direct Node filesystem mutation", () => {
        const preferencesStore = path.join(desktopRoot, "main", "desktop-preferences-store.ts");
        expect(collectModuleSpecifiers(preferencesStore)).toContain("@oaam/shared/filesystem");
        expect(collectModuleSpecifiers(preferencesStore)).not.toContain("node:fs");
    });

    it("routes Windows-to-WSL environment mechanics through the finite Shared paths entry", () => {
        const desktopMain = path.join(desktopRoot, "main", "index.ts");
        expect(collectModuleSpecifiers(desktopMain)).toContain("@oaam/shared/paths");
        expect(collectModuleSpecifiers(desktopMain)).not.toContain("node:fs");
    });

    it("keeps each finite Desktop IPC channel literal in the bridge owner only", () => {
        const bridgeOwner = path.join(desktopRoot, "bridge", "desktop-bridge.ts");
        const sourceFiles = [...browserFiles, ...preloadFiles, ...privilegedFiles];
        const channelLiterals = [
            "oaam:desktop-protocol-port",
            "oaam:desktop-protocol-port-ready",
            "oaam:desktop-packaged-onboarding-proof-port",
            "oaam:desktop-packaged-onboarding-proof-port-ready",
            "oaam:desktop-host-retry",
            "oaam:desktop-host-startup-get",
            "oaam:desktop-host-startup-changed",
            "oaam:desktop-project-root-pick",
            "oaam:desktop-presentation-get",
            "oaam:desktop-presentation-replace",
            "oaam:desktop-presentation-changed",
        ];
        for (const channel of channelLiterals) {
            const owners = sourceFiles
                .filter((file) => fs.readFileSync(file, "utf8").includes(`"${channel}"`))
                .map((file) => path.relative(ROOT_DIR, file));
            expect(owners, channel).toEqual([path.relative(ROOT_DIR, bridgeOwner)]);
        }
    });

    it("keeps the renderer CSP free of inline script and style permission", () => {
        const html = fs.readFileSync(path.join(desktopRoot, "renderer", "index.html"), "utf8");
        expect(html).toContain("script-src 'self'");
        expect(html).toContain("style-src 'self'");
        expect(html).toContain('<link rel="stylesheet" href="./styles.css" />');
        expect(html).not.toContain("'unsafe-inline'");
        expect(html).not.toContain("'unsafe-eval'");
        expect(html).not.toContain("<style>");
    });
});

describe("architecture: Desktop renderer topology keeps journey state out of shared composition", () => {
    const desktopRoot = onlySourceRoot("client_desktop");
    const rendererRoot = path.join(desktopRoot, "renderer");
    const featuresRoot = path.join(rendererRoot, "features");
    const uiRoot = path.join(rendererRoot, "ui");

    function relativeImportTarget(file: string, specifier: string): string | undefined {
        return specifier.startsWith(".") ? path.resolve(path.dirname(file), specifier) : undefined;
    }

    function isInside(parent: string, candidate: string): boolean {
        const relative = path.relative(parent, candidate);
        return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
    }

    it("requires the five reviewed responsibility roots and rejects generic dumping-ground directories", () => {
        expect(
            ["app", "pages", "features", "ui", "client"].map((directory) => ({
                directory,
                exists: fs.statSync(path.join(rendererRoot, directory)).isDirectory(),
            })),
        ).toEqual([
            { directory: "app", exists: true },
            { directory: "pages", exists: true },
            { directory: "features", exists: true },
            { directory: "ui", exists: true },
            { directory: "client", exists: true },
        ]);
        expect(["components", "common", "misc"].filter((directory) => fs.existsSync(path.join(rendererRoot, directory)))).toEqual(
            [],
        );
        expect(fs.existsSync(path.join(desktopRoot, "client"))).toBe(false);
    });

    it("keeps ui primitives independent from OAAM and journey-owned renderer modules", () => {
        const violations = walkDir(uiRoot).flatMap((file) =>
            collectModuleSpecifiers(file)
                .filter((specifier) => {
                    if (specifier.startsWith("@oaam/")) return true;
                    const target = relativeImportTarget(file, specifier);
                    return target !== undefined && !isInside(uiRoot, target);
                })
                .map((specifier) => `${path.relative(ROOT_DIR, file)} -> ${specifier}`),
        );
        expect(violations).toEqual([]);
    });

    it("allows callers outside a feature to import only its reviewed public entrypoints", () => {
        const reviewedSubpathEntrypoints = new Map([
            ["catalog-search", new Set(["model", "overlay"])],
            ["discovery", new Set(["presentation"])],
            ["project-library", new Set(["model", "proof"])],
        ]);
        const violations = walkDir(rendererRoot).flatMap((file) => {
            const fileRelativeToFeatures = path.relative(featuresRoot, file);
            const owningFeature =
                !fileRelativeToFeatures.startsWith("..") && !path.isAbsolute(fileRelativeToFeatures)
                    ? fileRelativeToFeatures.split(path.sep)[0]
                    : undefined;
            return collectModuleSpecifiers(file).flatMap((specifier) => {
                const target = relativeImportTarget(file, specifier);
                if (target === undefined || !isInside(featuresRoot, target)) return [];
                const [targetFeature, ...targetRemainder] = path.relative(featuresRoot, target).split(path.sep);
                if (targetFeature === owningFeature || targetRemainder.length === 0) return [];
                if (
                    targetRemainder.length === 1 &&
                    reviewedSubpathEntrypoints.get(targetFeature)?.has(targetRemainder[0] ?? "") === true
                ) {
                    return [];
                }
                return [`${path.relative(ROOT_DIR, file)} -> ${specifier}`];
            });
        });
        expect(violations).toEqual([]);
        expect(
            [...reviewedSubpathEntrypoints].flatMap(([feature, entrypoints]) =>
                [...entrypoints].filter((entrypoint) => !fs.existsSync(path.join(featuresRoot, feature, `${entrypoint}.ts`))),
            ),
        ).toEqual([]);
    });

    it("keeps App and pages free of direct Protocol operation dispatch", () => {
        const compositionFiles = [path.join(rendererRoot, "app", "App.tsx"), ...walkDir(path.join(rendererRoot, "pages"))];
        const violations = compositionFiles.flatMap((file) => {
            const content = readFileContent(file);
            const operationLiterals = PROTOCOL_OPERATION_NAMES.filter(
                (operation) => content.includes(`"${operation}"`) || content.includes(`'${operation}'`),
            );
            const directDispatch = /\.(?:request|start)\s*\(/u.test(content);
            const featureStateMachine = path.basename(file) === "App.tsx" && /\bnew\s+\w+Controller\s*\(/u.test(content);
            return operationLiterals.length === 0 && !directDispatch && !featureStateMachine
                ? []
                : [
                      `${path.relative(ROOT_DIR, file)}: operations=${operationLiterals.join(",")}; directDispatch=${directDispatch}; featureStateMachine=${featureStateMachine}`,
                  ];
        });
        expect(violations).toEqual([]);
    });
});

describe("architecture: App Server Protocol is browser-safe and workspace-independent", () => {
    const protocolFiles = walkDir(onlySourceRoot("app_server_protocol"));

    it("imports no OAAM workspace, Node, Electron, or UI framework", () => {
        expect(protocolFiles.length).toBeGreaterThan(0);
        expect(checkForbiddenImports(protocolFiles, FORBIDDEN_PROTOCOL_IMPORTS)).toEqual([]);
    });
});

describe("architecture: Production Host remains provider-neutral", () => {
    const hostRoot = onlySourceRoot("app_server_host");
    const hostFiles = walkDir(hostRoot);

    it("imports no concrete Provider, Bootstrap, Client, Adapter Framework, Electron, or UI package", () => {
        expect(hostFiles.length).toBeGreaterThan(0);
        expect(checkForbiddenImports(hostFiles, FORBIDDEN_APP_SERVER_HOST_IMPORTS)).toEqual([]);
    });

    it("declares Shared as the only physical-filesystem mechanics dependency", () => {
        const workspace = resolveWorkspaceGraph(ROOT_DIR).packages.find((entry) => entry.name === "@oaam/app-server-host");
        expect(workspace?.internalDeliveryDependencyNames).toEqual(["@oaam/app-server-protocol", "@oaam/core", "@oaam/shared"]);
        for (const owner of ["host-runtime.ts", "review-record-store.ts"]) {
            const file = path.join(hostRoot, owner);
            expect(collectModuleSpecifiers(file)).not.toContain("node:fs");
        }
        expect(collectModuleSpecifiers(path.join(hostRoot, "review-record-store.ts"))).toContain("@oaam/shared/filesystem");
    });
});

describe("architecture: App Server Bootstrap is the one exact production composition root", () => {
    const bootstrapRoot = onlySourceRoot("app_server_bootstrap");
    const bootstrapFiles = walkDir(bootstrapRoot);
    const compositionPath = path.join(bootstrapRoot, "production-bootstrap.ts");
    const inventoryPath = path.join(bootstrapRoot, "builtin-providers.ts");

    it("imports only Core, Host and the reviewed built-in Providers", () => {
        expect(bootstrapFiles.length).toBeGreaterThan(0);
        expect(checkForbiddenImports(bootstrapFiles, FORBIDDEN_APP_SERVER_BOOTSTRAP_IMPORTS)).toEqual([]);
    });

    it("declares the exact composition dependency closure", () => {
        const workspace = resolveWorkspaceGraph(ROOT_DIR).packages.find((entry) => entry.name === "@oaam/app-server-bootstrap");
        expect(workspace?.internalDeliveryDependencyNames).toEqual([
            "@oaam/adapter-antigravity",
            "@oaam/adapter-claudecode",
            "@oaam/adapter-codex",
            "@oaam/adapter-cursor",
            "@oaam/adapter-opencode",
            "@oaam/adapter-zcode",
            "@oaam/app-server-host",
            "@oaam/core",
        ]);
    });

    it("shares one exact built-in Provider inventory between ordinary and restricted composition", () => {
        expect(fs.existsSync(compositionPath)).toBe(true);
        expect(fs.existsSync(inventoryPath)).toBe(true);
        expect(collectModuleSpecifiers(compositionPath)).toContain("./builtin-providers");
        expect(
            collectModuleSpecifiers(inventoryPath)
                .filter((specifier) => CONCRETE_PROVIDER_IMPORTS.includes(specifier))
                .sort(),
        ).toEqual([...CONCRETE_PROVIDER_IMPORTS].sort());
        const otherFiles = resolveArchitectureSourceRoots()
            .flatMap((root) => walkDir(root.sourceRoot))
            .filter((file) => file !== inventoryPath);
        expect(
            checkForbiddenImports(
                otherFiles,
                CONCRETE_PROVIDER_IMPORTS.map((name) => new RegExp(`^${name}(?:$|/)`, "u")),
            ),
        ).toEqual([]);
    });
});

describe("architecture: adapter must not import client (prepared for future)", () => {
    for (const adapterDir of sourceRootsFor("adapter")) {
        const dirName = path.relative(ROOT_DIR, adapterDir);
        it(`${dirName}: no adapter file imports client packages`, () => {
            const adapterFiles = walkDir(adapterDir);
            if (adapterFiles.length === 0) {
                expect(adapterFiles).toEqual([]);
                return;
            }
            const violations = checkForbiddenImports(adapterFiles, FORBIDDEN_ADAPTER_IMPORTS);
            expect(violations).toEqual([]);
        });
    }
});

describe("architecture: adapter-framework composes Core contracts without owning a family", () => {
    const adapterKitFiles = walkDir(onlySourceRoot("adapter_framework"));

    it("has TypeScript sources and imports no concrete adapter or client", () => {
        expect(adapterKitFiles.length).toBeGreaterThan(0);
        expect(checkForbiddenImports(adapterKitFiles, FORBIDDEN_ADAPTER_IMPORTS)).toEqual([]);
    });

    it("is not imported by Core", () => {
        expect(checkForbiddenImports(walkDir(CORE_SRC_DIR), [/@oaam\/adapter-framework/])).toEqual([]);
    });
});

describe("architecture: adapter may import core (allowed direction)", () => {
    it("adapter importing core should not be flagged as violation", () => {
        // 这个测试验证 FORBIDDEN_ADAPTER_IMPORTS 不包含 @oaam/core
        // 如果误加了,adapter 会无法 import core,架构崩
        expect(FORBIDDEN_ADAPTER_IMPORTS.some((p) => p.test("@oaam/core"))).toBe(false);
    });

    it("adapter may import shared (allowed direction)", () => {
        expect(FORBIDDEN_ADAPTER_IMPORTS.some((p) => p.test("@oaam/shared/filesystem"))).toBe(false);
        expect(FORBIDDEN_ADAPTER_IMPORTS.some((p) => p.test("@oaam/shared/paths"))).toBe(false);
    });
});

describe("architecture: shared must not import adapter or client", () => {
    for (const sharedDir of sourceRootsFor("shared")) {
        const dirName = path.relative(ROOT_DIR, sharedDir);
        it(`${dirName}: no shared file imports adapter/client/core packages`, () => {
            const sharedFiles = walkDir(sharedDir);
            if (sharedFiles.length === 0) {
                expect(sharedFiles).toEqual([]);
                return;
            }
            const violations = checkForbiddenImports(sharedFiles, FORBIDDEN_SHARED_IMPORTS);
            expect(violations).toEqual([]);
        });
    }

    it("@oaam/core IS in FORBIDDEN_SHARED_IMPORTS (shared→core forbidden, Step 4 closed the debt)", () => {
        // Positive guard: confirm @oaam/core IS in FORBIDDEN_SHARED_IMPORTS now
        // (Step 4 closed the shared→core TEMPORARY DEBT). If this fails, someone
        // removed the rule — shared must not import core (ARCHITECTURE.md L87).
        expect(FORBIDDEN_SHARED_IMPORTS.some((p) => p.test("@oaam/core"))).toBe(true);
    });
});

describe("architecture: source files must be TypeScript", () => {
    for (const srcDir of ARCHITECTURE_SOURCE_ROOTS.map((entry) => entry.sourceRoot)) {
        const dirName = path.relative(ROOT_DIR, srcDir);
        it(`${dirName}: no JavaScript source files`, () => {
            const files = walkAllFiles(srcDir);
            const jsFiles = files.filter((file) => /\.(?:cjs|js|jsx|mjs)$/u.test(file));
            expect(jsFiles).toEqual([]);
        });
    }
});

describe("architecture: createTargetIoForTest is test-only (no production import)", () => {
    const PRODUCER = path.join(CORE_SRC_DIR, "deployment/deployment-target-io.ts");
    const coreFiles = walkDir(CORE_SRC_DIR).filter((f) => f !== PRODUCER);
    const violators = coreFiles.filter((f) => readFileContent(f).includes("createTargetIoForTest"));
    it("no core/src file (except deployment-target-io.ts) imports createTargetIoForTest", () => {
        const rel = violators.map((f) => path.relative(ROOT_DIR, f));
        expect(rel, `createTargetIoForTest must not be imported by production code; found in: ${rel.join(", ")}`).toEqual([]);
    });
});

describe("architecture: executeDeploymentForTest is test-only (no production import)", () => {
    const PRODUCER = path.join(CORE_SRC_DIR, "deployment/deployment-executor.ts");
    const coreFiles = walkDir(CORE_SRC_DIR).filter((f) => f !== PRODUCER);
    const violators = coreFiles.filter((f) => readFileContent(f).includes("executeDeploymentForTest"));
    it("no core/src file (except deployment-executor.ts) references executeDeploymentForTest", () => {
        const rel = violators.map((f) => path.relative(ROOT_DIR, f));
        expect(rel, `executeDeploymentForTest must not be used by production code; found in: ${rel.join(", ")}`).toEqual([]);
    });
});

describe("architecture: recoverDeploymentForTest is test-only (no production import)", () => {
    const PRODUCER = path.join(CORE_SRC_DIR, "deployment/deployment-recovery.ts");
    const coreFiles = walkDir(CORE_SRC_DIR).filter((f) => f !== PRODUCER);
    const violators = coreFiles.filter((f) => readFileContent(f).includes("recoverDeploymentForTest"));
    it("no core/src file (except deployment-recovery.ts) references recoverDeploymentForTest", () => {
        const rel = violators.map((f) => path.relative(ROOT_DIR, f));
        expect(rel, `recoverDeploymentForTest must not be used by production code; found in: ${rel.join(", ")}`).toEqual([]);
    });
});

describe("architecture: unfreezeRegistry/clearRegistry are test-only", () => {
    const PRODUCER = path.join(CORE_SRC_DIR, "orchestration/adapter-registry.ts");
    const coreFiles = walkDir(CORE_SRC_DIR).filter((f) => f !== PRODUCER);
    const violators = coreFiles.filter(
        (f) => readFileContent(f).includes("unfreezeRegistry") || readFileContent(f).includes("clearRegistry"),
    );
    it("no core/src file (except adapter-registry.ts) references unfreezeRegistry or clearRegistry", () => {
        const rel = violators.map((f) => path.relative(ROOT_DIR, f));
        expect(rel, `test-only mutators must not be used by production code; found in: ${rel.join(", ")}`).toEqual([]);
    });
});

describe("architecture: acquireAllLocksForTest is test-only (no production import)", () => {
    const PRODUCER = path.join(CORE_SRC_DIR, "foundation", "physical-path-locks.ts");
    const coreFiles = walkDir(CORE_SRC_DIR).filter((f) => f !== PRODUCER);
    const violators = coreFiles.filter((f) => readFileContent(f).includes("acquireAllLocksForTest"));
    it("no core/src file (except foundation/physical-path-locks.ts) references acquireAllLocksForTest", () => {
        const rel = violators.map((f) => path.relative(ROOT_DIR, f));
        expect(rel, `acquireAllLocksForTest must not be used by production code; found in: ${rel.join(", ")}`).toEqual([]);
    });
});

describe("architecture: createAssetSpecRegistryForTest is test-only", () => {
    const PRODUCER = path.join(CORE_SRC_DIR, "specs", "registry.ts");
    const coreFiles = walkDir(CORE_SRC_DIR).filter((f) => f !== PRODUCER);
    const violators = coreFiles.filter((f) => readFileContent(f).includes("createAssetSpecRegistryForTest"));
    it("no core/src file (except specs/registry.ts) references the construction seam", () => {
        const rel = violators.map((f) => path.relative(ROOT_DIR, f));
        expect(rel, `createAssetSpecRegistryForTest must not be used by production code; found in: ${rel.join(", ")}`).toEqual(
            [],
        );
    });
});

describe("architecture: P3 authority fault seams are test-only", () => {
    const seams = [
        { name: "publishInitialAssetVersionForTest", owner: "catalog/version-authority.ts" },
        { name: "publishAssetVersionForTest", owner: "catalog/version-authority.ts" },
        {
            name: "publishImportedInitialAssetVersionForTest",
            owner: "catalog/version-authority.ts",
        },
        { name: "publishImportedAssetVersionForTest", owner: "catalog/version-authority.ts" },
        {
            name: "publishReverseAcceptedAssetVersionForTest",
            owner: "catalog/version-authority.ts",
        },
        { name: "writePayloadForTest", owner: "catalog/payload-store.ts" },
        { name: "writePayloadBytesForTest", owner: "catalog/payload-store.ts" },
    ] as const;

    for (const seam of seams) {
        it(`${seam.name} is referenced only by its owner module under core/src`, () => {
            const owner = path.join(CORE_SRC_DIR, seam.owner);
            const violators = walkDir(CORE_SRC_DIR).filter((file) => file !== owner && readFileContent(file).includes(seam.name));
            const rel = violators.map((file) => path.relative(ROOT_DIR, file));
            expect(rel, `${seam.name} must not be used by production code; found in: ${rel.join(", ")}`).toEqual([]);
        });
    }
});

describe("architecture: P3 Asset and Version authority mutation stays centralized", () => {
    const boundaries = [
        {
            name: "writeAssetManifest",
            owners: ["catalog/asset-manifest.ts", "catalog/asset-manifest-authority.ts", "catalog/version-authority.ts"],
        },
        {
            name: "commitNewAsset",
            owners: ["catalog/staging-commit.ts", "catalog/version-authority.ts"],
        },
        {
            name: "commitNewVersion",
            owners: ["catalog/staging-commit.ts", "catalog/version-authority.ts"],
        },
        {
            name: "createStagingVersionDir",
            owners: ["catalog/staging-commit.ts", "catalog/version-authority.ts"],
        },
        {
            name: "writePayload",
            owners: ["catalog/payload-store.ts", "catalog/version-authority.ts", "deployment/deployment-payload-store.ts"],
        },
        {
            name: "writePayloadBytes",
            owners: ["catalog/payload-store.ts", "catalog/version-authority.ts", "deployment/deployment-payload-store.ts"],
        },
    ] as const;

    for (const boundary of boundaries) {
        it(`${boundary.name} has no production consumer outside the Asset/Version authority`, () => {
            const allowed = new Set(boundary.owners.map((owner) => path.join(CORE_SRC_DIR, owner)));
            const violators = walkDir(CORE_SRC_DIR).filter(
                (file) => !allowed.has(file) && readFileContent(file).includes(boundary.name),
            );
            const rel = violators.map((file) => path.relative(ROOT_DIR, file));
            expect(rel, `${boundary.name} escaped the P3 authority boundary; found in: ${rel.join(", ")}`).toEqual([]);
        });
    }
});

describe("architecture: P4 authority race seams are test-only", () => {
    const owner = path.join(CORE_SRC_DIR, "catalog", "promotion-grant-store.ts");
    for (const seam of ["createPromotionGrantAuthorityForTest", "listPromotionGrantAuthoritiesForTest"]) {
        it(`${seam} is referenced only by its owner module under core/src`, () => {
            const violators = walkDir(CORE_SRC_DIR).filter((file) => file !== owner && readFileContent(file).includes(seam));
            const rel = violators.map((file) => path.relative(ROOT_DIR, file));
            expect(rel, `${seam} escaped into production code: ${rel.join(", ")}`).toEqual([]);
        });
    }
});

describe("architecture: Deployment payload publication seam is test-only", () => {
    const owner = path.join(CORE_SRC_DIR, "deployment/deployment-payload-store.ts");
    it("publishDeploymentPayloadsForTest is referenced only by its owner under core/src", () => {
        const violators = walkDir(CORE_SRC_DIR).filter(
            (file) => file !== owner && readFileContent(file).includes("publishDeploymentPayloadsForTest"),
        );
        const rel = violators.map((file) => path.relative(ROOT_DIR, file));
        expect(rel, `Deployment payload test seam escaped into production: ${rel.join(", ")}`).toEqual([]);
    });
});

describe("architecture: locked recovery mutation seam is test-only", () => {
    const owner = path.join(CORE_SRC_DIR, "deployment/deployment-recovery.ts");
    it("recoverDeploymentWithLocksForTest is referenced only by its owner under core/src", () => {
        const violators = walkDir(CORE_SRC_DIR).filter(
            (file) => file !== owner && readFileContent(file).includes("recoverDeploymentWithLocksForTest"),
        );
        const rel = violators.map((file) => path.relative(ROOT_DIR, file));
        expect(rel, `locked recovery test seam escaped into production: ${rel.join(", ")}`).toEqual([]);
    });
});

describe("architecture: adapter read authority seams are test-only", () => {
    const seams = [
        { name: "createAdapterReadOperationForTest", owners: ["adapters/adapter-read-access.ts"] },
        {
            name: "executeAdapterReadWithAuthorityForTest",
            owners: ["source-import/source-contract-validator.ts", "source-import/source-read-execution.ts"],
        },
        { name: "readAssetsFromAdapterForTest", owners: ["orchestration/adapter-registry.ts"] },
    ];
    for (const seam of seams) {
        it(`${seam.name} is referenced only by its owners under core/src`, () => {
            const owners = new Set(seam.owners.map((owner) => path.join(CORE_SRC_DIR, owner)));
            const violators = walkDir(CORE_SRC_DIR).filter(
                (file) => !owners.has(file) && readFileContent(file).includes(seam.name),
            );
            const rel = violators.map((file) => path.relative(ROOT_DIR, file));
            expect(rel, `${seam.name} escaped into production: ${rel.join(", ")}`).toEqual([]);
        });
    }
});

describe("architecture: authority lock fault seam is test-only", () => {
    for (const seam of ["tryAcquireAuthorityLocksForTest", "tryAcquireAuthorityLockLeaseForTest"]) {
        it(`${seam} is referenced only by its owner under core/src`, () => {
            const owner = path.join(CORE_SRC_DIR, "foundation", "authority-locks.ts");
            const violators = walkDir(CORE_SRC_DIR).filter((file) => file !== owner && readFileContent(file).includes(seam));
            const rel = violators.map((file) => path.relative(ROOT_DIR, file));
            expect(rel, `${seam} escaped into production: ${rel.join(", ")}`).toEqual([]);
        });
    }

    it("held-authority render selection is consumed only by its owner and CoreService", () => {
        const symbol = "resolveCoreRenderSelectionWithAuthorityLeases";
        const allowed = new Set([
            path.join(CORE_SRC_DIR, "render/render-selection.ts"),
            path.join(CORE_SRC_DIR, "orchestration/core-service.ts"),
        ]);
        const violators = walkDir(CORE_SRC_DIR).filter((file) => !allowed.has(file) && readFileContent(file).includes(symbol));
        const rel = violators.map((file) => path.relative(ROOT_DIR, file));
        expect(rel, `${symbol} escaped its reviewed consumers: ${rel.join(", ")}`).toEqual([]);
    });
});

describe("architecture: compiled deployment plans open only inside reviewed Core owners", () => {
    it("openValidatedCompiledDeploymentPlan has no production consumer outside executor and no-write reverse commit", () => {
        const symbol = "openValidatedCompiledDeploymentPlan";
        const allowed = new Set([
            path.join(CORE_SRC_DIR, "render/render-compiler.ts"),
            path.join(CORE_SRC_DIR, "deployment/deployment-executor.ts"),
            path.join(CORE_SRC_DIR, "orchestration/deployment-lifecycle-execution.ts"),
        ]);
        const violators = walkDir(CORE_SRC_DIR).filter((file) => !allowed.has(file) && readFileContent(file).includes(symbol));
        const rel = violators.map((file) => path.relative(ROOT_DIR, file));
        expect(rel, `${symbol} escaped the reviewed compiler handoff: ${rel.join(", ")}`).toEqual([]);
    });

    it("pre-write preview projection has one reviewed orchestration consumer", () => {
        const symbol = "projectValidatedCompiledDeploymentPreviewInput";
        const allowed = new Set([
            path.join(CORE_SRC_DIR, "render/render-compiler.ts"),
            path.join(CORE_SRC_DIR, "orchestration/deployment-render-service.ts"),
        ]);
        const violators = walkDir(CORE_SRC_DIR).filter((file) => !allowed.has(file) && readFileContent(file).includes(symbol));
        const rel = violators.map((file) => path.relative(ROOT_DIR, file));
        expect(rel, `${symbol} escaped its reviewed pre-write preview consumer: ${rel.join(", ")}`).toEqual([]);
    });
});

describe("architecture: reverse lifecycle entries have one reviewed consumer", () => {
    for (const entry of [
        {
            symbol: "inspectDeploymentRuntimeAuthorityForReverseResolver",
            owner: "orchestration/deployment-inspection-service.ts",
            consumer: "orchestration/deployment-lifecycle-projection.ts",
        },
        {
            symbol: "reprojectObservedReverseRenderOperation",
            owner: "orchestration/deployment-render-service.ts",
            consumer: "orchestration/deployment-lifecycle-projection.ts",
        },
        {
            symbol: "resolveCoreRenderSelectionForStagedVersion",
            owner: "render/render-selection.ts",
            consumer: "orchestration/deployment-lifecycle-execution.ts",
        },
    ]) {
        it(`${entry.symbol} is consumed only by the deployment lifecycle`, () => {
            const allowed = new Set([entry.owner, entry.consumer].map((name) => path.join(CORE_SRC_DIR, name)));
            const violators = walkDir(CORE_SRC_DIR).filter(
                (file) => !allowed.has(file) && readFileContent(file).includes(entry.symbol),
            );
            const rel = violators.map((file) => path.relative(ROOT_DIR, file));
            expect(rel, `${entry.symbol} escaped its lock owner: ${rel.join(", ")}`).toEqual([]);
        });
    }
});
