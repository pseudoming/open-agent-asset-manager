/** Exact ZCode App project-keyed Memory Unit and ordered Catalog targets. */

import {
    adapterOperationDiagnostic as diagnostic,
    defineDialectComponentV1 as component,
    sha256SourceBytes,
} from "@oaam/adapter-framework";
import {
    type AdapterRenderAnalysisResult,
    type AgentRuntimeDescriptor,
    createNativeProjectExactFileProviderSupport,
    createVerifiedNativeProjectExactFileBuild,
    type NativeProjectExactFileProviderSupport,
    type PosixRelativePath,
    type RenderAnalysisInput,
} from "@oaam/core/adapter-spi";
import {
    parseZcodeMemoryIndex,
    parseZcodeMemoryTopic,
    parseZcodeMemoryTopicRestorationPayload,
} from "./zcode-source-read-memory";
import { ZCODE_NATIVE_DIALECTS } from "./zcode-source-read-model";
import { validateZcodeNativeDialect } from "./zcode-source-read-native";
import { appendZcodeBuildCompatibilityWarning, ZCODE_APP_TARGET_BUILD_COMPATIBILITY } from "./zcode-target-build-compatibility";
import { ZCODE_CURRENT_TARGET_BUILD, ZCODE_HISTORICAL_DECLARATION_FLOOR } from "./zcode-target-builds";

type ExactSupportInput = Parameters<typeof createNativeProjectExactFileProviderSupport>[0];
type ExactRebaseMaterializer = NonNullable<ExactSupportInput["rebaseMaterializer"]>;
type ExactRebaseInput = Parameters<ExactRebaseMaterializer["materialize"]>[0];
type ExactTextEntry = Extract<ExactRebaseInput["targetFiles"][number], { contentKind: "text" }>;

const REQUIRED_FACTS = {
    "oaam.project-binding": "registered",
    "oaam.target-kind": "directory",
} as const;

export const ZCODE_MEMORY_TARGET_COMPONENTS = {
    unitPath: component("zcode.project-memory-topic-exact-path-v1"),
    unitReverse: component(`${ZCODE_NATIVE_DIALECTS.memoryTopic}.native-to-canonical-parser`),
    unitRebase: component("zcode.project-memory-topic-parent-rebase-v1"),
    catalogPath: component("zcode.project-memory-catalog-exact-path-v1"),
    catalogReverse: component(`${ZCODE_NATIVE_DIALECTS.memoryCatalog}.native-to-canonical-parser`),
    catalogRebase: component("zcode.project-memory-catalog-parent-rebase-v1"),
} as const;

export interface ZcodeMemoryTargetSupports {
    unit: NativeProjectExactFileProviderSupport;
    catalog: NativeProjectExactFileProviderSupport;
}

export function createZcodeMemoryTargetSupports(input: {
    adapterVersion: string;
    agentRuntimes: readonly AgentRuntimeDescriptor[];
    targetContextSchemaId: string;
}): ZcodeMemoryTargetSupports {
    return {
        unit: createMemorySupport("unit", input),
        catalog: createMemorySupport("catalog", input),
    };
}

function createMemorySupport(
    role: "unit" | "catalog",
    input: { adapterVersion: string; agentRuntimes: readonly AgentRuntimeDescriptor[]; targetContextSchemaId: string },
): NativeProjectExactFileProviderSupport {
    const isCatalog = role === "catalog";
    const components = isCatalog
        ? {
              path: ZCODE_MEMORY_TARGET_COMPONENTS.catalogPath,
              reverse: ZCODE_MEMORY_TARGET_COMPONENTS.catalogReverse,
              rebase: ZCODE_MEMORY_TARGET_COMPONENTS.catalogRebase,
          }
        : {
              path: ZCODE_MEMORY_TARGET_COMPONENTS.unitPath,
              reverse: ZCODE_MEMORY_TARGET_COMPONENTS.unitReverse,
              rebase: ZCODE_MEMORY_TARGET_COMPONENTS.unitRebase,
          };
    const nativeDialectId = isCatalog ? ZCODE_NATIVE_DIALECTS.memoryCatalog : ZCODE_NATIVE_DIALECTS.memoryTopic;
    const materializationProfileId = isCatalog ? "zcode-app-project-memory-catalog-v1" : "zcode-app-project-memory-topic-v1";
    const buildSpecs = [
        ...(["wsl", "win32"] as const).map((platform) => ({
            versionText: ZCODE_CURRENT_TARGET_BUILD.versionText,
            buildIdentity: ZCODE_CURRENT_TARGET_BUILD.buildIdentity,
            platform,
            fixtureSuffix: "2026-08-08",
            loadMarker: isCatalog ? "OAAM_ZCODE_353_MEMORY_CATALOG_8F26D4" : "OAAM_ZCODE_353_MEMORY_TOPIC_4A79C2",
        })),
        {
            ...ZCODE_HISTORICAL_DECLARATION_FLOOR,
            fixtureSuffix: "historical-lifecycle-2026-08-17",
            loadMarker: isCatalog ? "OAAM_ZCODE_HISTORICAL_MEMORY_CATALOG_3_1_8" : "OAAM_ZCODE_HISTORICAL_MEMORY_TOPIC_3_1_8",
        },
    ] as const;
    const verifiedBuilds = buildSpecs.map((buildSpec) =>
        createVerifiedNativeProjectExactFileBuild({
            agentRuntimeId: "ZCODE_APP",
            versionText: buildSpec.versionText,
            buildIdentity: buildSpec.buildIdentity,
            platform: buildSpec.platform,
            materializationProfileId,
            fixtureId: `zcode-app-${buildSpec.versionText}-${buildSpec.platform}-project-memory-${role}-${buildSpec.fixtureSuffix}`,
            assetKind: "Memory",
            nativeDialectId,
            projectPathValidator: components.path,
            reverseParser: components.reverse,
            rebaseMaterializer: components.rebase,
            restorationDialectIds: isCatalog ? [] : [ZCODE_NATIVE_DIALECTS.memoryTopic],
            parentRebaseFixtureId: `zcode-app-${buildSpec.versionText}-${buildSpec.platform}-project-memory-${role}-parent-rebase-v1`,
            targetRelativePath: isCatalog ? "MEMORY.md" : "topics/oaam-phase56-memory.md",
            exactLoadMarker: buildSpec.loadMarker,
            reverseFixtureId: `zcode-app-${buildSpec.versionText}-${buildSpec.platform}-project-memory-${role}-reverse-v1`,
        }),
    );
    return createNativeProjectExactFileProviderSupport({
        adapterId: "ZCODE",
        adapterVersion: input.adapterVersion,
        agentRuntimes: input.agentRuntimes,
        agentRuntimeId: "ZCODE_APP",
        assetKind: "Memory",
        outputContractId: isCatalog ? "ZCODE_NATIVE_PROJECT_MEMORY_CATALOG_V1" : "ZCODE_NATIVE_PROJECT_MEMORY_TOPIC_V1",
        materializerCapabilityKey: isCatalog
            ? "zcode.project-memory-catalog-exact-file-v1"
            : "zcode.project-memory-topic-exact-file-v1",
        materializationProfileId,
        nativeDialectId,
        projectPathValidator: {
            ref: components.path,
            validate: (relativePath) => isMemoryPath(relativePath, role),
        },
        reverseParser: {
            ref: components.reverse,
            parse: (parseInput) => {
                if (isCatalog) return null;
                const applied = splitMemoryTopic(parseInput.appliedNativeText);
                const current = splitMemoryTopic(parseInput.currentNativeText);
                return applied === null ||
                    current === null ||
                    applied.prefix !== current.prefix ||
                    applied.suffix !== current.suffix
                    ? null
                    : { canonicalEntryText: current.body };
            },
        },
        ...(isCatalog
            ? {
                  memoryCatalog: {
                      parse: (catalogInput) => {
                          if (
                              catalogInput.nativeDialectId !== ZCODE_NATIVE_DIALECTS.memoryCatalog ||
                              catalogInput.relativePath !== "MEMORY.md"
                          ) {
                              return null;
                          }
                          const parsed = parseZcodeMemoryIndex(catalogInput.nativeText);
                          return parsed.diagnostics.length === 0
                              ? {
                                    members: parsed.members.map((member) => ({
                                        relativePath: member.rawTarget,
                                        routingTitle: member.routingTitle,
                                        routingHint: member.routingHint,
                                    })),
                                }
                              : null;
                      },
                      resolveMemberPath: (memberInput) => {
                          const group = memberInput.dialectInputs.find(
                              (candidate) =>
                                  candidate.targetVersion.assetId === memberInput.memberAsset.version.ref.assetId &&
                                  candidate.targetVersion.versionId === memberInput.targetAssetVersionId,
                          );
                          const natives = group?.inputs.filter(
                              (candidate) =>
                                  candidate.inputKind === "native_representation" &&
                                  candidate.representation.dialectId === ZCODE_NATIVE_DIALECTS.memoryTopic,
                          );
                          const file = natives?.[0]?.inputKind === "native_representation" ? natives[0].files[0] : undefined;
                          return natives?.length === 1 &&
                              natives[0]?.inputKind === "native_representation" &&
                              natives[0].files.length === 1 &&
                              file?.contentKind === "text" &&
                              isMemoryPath(file.relativePath, "unit")
                              ? file.relativePath
                              : null;
                      },
                  },
              }
            : {}),
        rebaseMaterializer: {
            ref: components.rebase,
            materialize: (rebaseInput) => materializeMemoryParent(role, rebaseInput),
        },
        restorationDialectIds: isCatalog ? [] : [ZCODE_NATIVE_DIALECTS.memoryTopic],
        target: { targetContextSchemaId: input.targetContextSchemaId, requiredFacts: REQUIRED_FACTS },
        buildCompatibility: ZCODE_APP_TARGET_BUILD_COMPATIBILITY,
        verifiedBuilds,
    });
}

function materializeMemoryParent(role: "unit" | "catalog", input: ExactRebaseInput): { nativeText: string } | null {
    if (role === "catalog") return materializeCatalogParent(input);
    const canonical = input.targetCanonical;
    const entry = input.targetFiles[0] as ExactTextEntry | undefined;
    const parent = splitMemoryTopic(input.parent.file.text);
    const restorationInput = input.restorationInputs[0];
    const restoration =
        input.restorationInputs.length === 1 &&
        restorationInput?.restoration.dialectId === ZCODE_NATIVE_DIALECTS.memoryTopic &&
        restorationInput.content.contentKind === "binary"
            ? parseZcodeMemoryTopicRestorationPayload(restorationInput.content.bytes)
            : null;
    if (
        canonical.kind !== "Memory" ||
        canonical.typeData.entityRole !== "unit" ||
        input.targetFiles.length !== 1 ||
        entry?.contentKind !== "text" ||
        entry.file.logicalPath !== "memory.md" ||
        entry.file.executable ||
        entry.text.trim() === "" ||
        parent === null ||
        restoration === null ||
        parent.parsed.classification !== restoration.classification ||
        parent.parsed.sessionId !== restoration.sessionId ||
        parent.parsed.source !== restoration.source ||
        parent.parsed.updatedAt !== restoration.updatedAt
    ) {
        return null;
    }
    const header = rewriteTopicHeader(
        parent.header,
        parent.parsed.name,
        parent.parsed.description,
        canonical.typeData.card.name,
        canonical.typeData.card.description,
    );
    if (header === null) return null;
    const nativeText = `${header}${parent.bodyLeading}${entry.text}${parent.suffix}`;
    return nativeTextMatchesTarget(input, nativeText) ? { nativeText } : null;
}

function materializeCatalogParent(input: ExactRebaseInput): { nativeText: string } | null {
    if (
        input.targetCanonical.kind !== "Memory" ||
        input.targetCanonical.typeData.entityRole !== "catalog" ||
        input.targetFiles.length !== 0 ||
        input.restorationInputs.length !== 0 ||
        input.parent.file.relativePath !== "MEMORY.md" ||
        input.memoryCatalogMembers.length !== input.targetCanonical.typeData.members.length
    ) {
        return null;
    }
    const nativeText = rewriteMemoryCatalog(input.parent.file.text, input.memoryCatalogMembers);
    return nativeText !== null && nativeTextMatchesTarget(input, nativeText) ? { nativeText } : null;
}

interface SplitMemoryTopic {
    parsed: NonNullable<ReturnType<typeof parseZcodeMemoryTopic>>;
    header: string;
    prefix: string;
    bodyLeading: string;
    body: string;
    suffix: string;
}

function splitMemoryTopic(text: string): SplitMemoryTopic | null {
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const parsed = parseZcodeMemoryTopic(normalized);
    if (parsed === null || parsed.body === "") return null;
    const firstClose = normalized.indexOf("\n---\n", 4);
    if (!normalized.startsWith("---\n") || firstClose < 0) return null;
    const bodyStart = firstClose + 5;
    const rawBody = normalized.slice(bodyStart);
    const trimmed = rawBody.trim();
    const trimmedStart = rawBody.indexOf(trimmed);
    if (trimmedStart < 0) return null;
    const trimmedEnd = trimmedStart + trimmed.length;
    const header = normalized.slice(0, bodyStart);
    const bodyLeading = rawBody.slice(0, trimmedStart);
    const suffix = rawBody.slice(trimmedEnd);
    return {
        parsed,
        header,
        prefix: `${header}${bodyLeading}`,
        bodyLeading,
        body: parsed.body,
        suffix,
    };
}

function rewriteTopicHeader(
    header: string,
    parentName: string,
    parentDescription: string,
    targetName: string,
    targetDescription: string,
): string | null {
    if (!header.startsWith("---\n") || !header.endsWith("---\n")) return null;
    const lines = header.slice(4, -4).split("\n");
    if (
        !replaceHeaderScalar(lines, "name", parentName, targetName, false) ||
        !replaceHeaderScalar(lines, "description", parentDescription, targetDescription, true)
    ) {
        return null;
    }
    return `---\n${lines.join("\n")}---\n`;
}

function replaceHeaderScalar(
    lines: string[],
    key: "name" | "description",
    parentValue: string,
    targetValue: string,
    allowInsert: boolean,
): boolean {
    if (targetValue.trim() === "" || targetValue.includes("\0") || targetValue.includes("\n") || targetValue.includes("\r")) {
        return false;
    }
    const indexes = lines.flatMap((line, index) => (new RegExp(`^${key}[\\t ]*:`).test(line) ? [index] : []));
    if (indexes.length > 1 || (indexes.length === 0 && !allowInsert)) return false;
    if (indexes.length === 0) {
        lines.push(`${key}: ${JSON.stringify(targetValue)}`);
        return true;
    }
    const index = indexes[0] as number;
    if (parentValue === targetValue) return true;
    // This bounded frontmatter reader does not own YAML inline-comment
    // semantics. Refuse a changed scalar that may carry such syntax instead
    // of silently erasing ZCode-private bytes during parent rebase.
    if ((lines[index] ?? "").includes("#")) return false;
    lines[index] = `${key}: ${JSON.stringify(targetValue)}`;
    return true;
}

function rewriteMemoryCatalog(parentText: string, members: ExactRebaseInput["memoryCatalogMembers"]): string | null {
    const parsedParent = parseZcodeMemoryIndex(parentText);
    if (parsedParent.diagnostics.length !== 0) return null;
    const hadTrailingNewline = parentText.endsWith("\n");
    const lines = parentText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    if (hadTrailingNewline) lines.pop();
    const oldSuffixes = new Map<string, string>();
    const memberIndexes: number[] = [];
    for (const [index, line] of lines.entries()) {
        const parsed = parseZcodeMemoryIndex(`${line}\n`);
        if (parsed.diagnostics.length !== 0 || parsed.members.length !== 1) continue;
        memberIndexes.push(index);
        const member = parsed.members[0] as { rawTarget: string };
        const suffixStart = line.lastIndexOf(" (type:");
        if (suffixStart >= 0 && line.endsWith(")")) oldSuffixes.set(member.rawTarget, line.slice(suffixStart));
    }
    const rendered = members.map((member) => {
        if (
            !safeCatalogText(member.routingTitle) ||
            !safeCatalogText(member.routingHint) ||
            !isMemoryPath(member.relativePath, "unit")
        ) {
            return null;
        }
        const suffix = oldSuffixes.get(member.relativePath) ?? "";
        return `- [${member.routingTitle}](${member.relativePath}) — ${member.routingHint}${suffix}`;
    });
    if (rendered.some((line) => line === null)) return null;
    const replacements = rendered as string[];
    if (memberIndexes.length === 0) {
        if (replacements.length > 0 && lines.length > 0 && lines.at(-1)?.trim() !== "") lines.push("");
        lines.push(...replacements);
    } else {
        const output: string[] = [];
        const indexes = new Set(memberIndexes);
        let replacementIndex = 0;
        for (const [index, line] of lines.entries()) {
            if (!indexes.has(index)) {
                output.push(line);
                continue;
            }
            if (replacementIndex < replacements.length) output.push(replacements[replacementIndex] as string);
            replacementIndex += 1;
            if (index === memberIndexes.at(-1) && replacementIndex < replacements.length) {
                output.push(...replacements.slice(replacementIndex));
                replacementIndex = replacements.length;
            }
        }
        lines.splice(0, lines.length, ...output);
    }
    const result = `${lines.join("\n")}${hadTrailingNewline ? "\n" : ""}`;
    const parsedResult = parseZcodeMemoryIndex(result);
    return parsedResult.diagnostics.length === 0 && parsedResult.members.length === members.length ? result : null;
}

function safeCatalogText(value: string): boolean {
    return !value.includes("\0") && !value.includes("\n") && !value.includes("\r") && !value.includes("]");
}

function isMemoryPath(relativePath: PosixRelativePath, role: "unit" | "catalog"): boolean {
    if (relativePath.includes("\0") || relativePath.includes("\\")) return false;
    if (role === "catalog") return relativePath === "MEMORY.md";
    const segments = relativePath.split("/");
    return (
        segments.length === 2 &&
        segments[0] === "topics" &&
        (segments[1] ?? "").endsWith(".md") &&
        segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")
    );
}

function nativeTextMatchesTarget(input: ExactRebaseInput, nativeText: string): boolean {
    const bytes = new TextEncoder().encode(nativeText);
    const { text: _text, ...parentDescriptor } = input.parent.file;
    const descriptor = {
        ...parentDescriptor,
        contentHash: sha256SourceBytes(bytes),
        byteSize: bytes.byteLength,
    };
    return validateZcodeNativeDialect({
        canonical: input.targetCanonical,
        canonicalFiles: input.targetFiles,
        representation: { ...input.parent.representation, files: [descriptor] },
        nativeFiles: [{ relativePath: input.parent.file.relativePath, bytes }],
    });
}

export async function analyzeZcodeMemoryTargets(
    input: RenderAnalysisInput,
    supports: ZcodeMemoryTargetSupports,
): Promise<AdapterRenderAnalysisResult> {
    const assetsByVersion = new Map(input.deployment.assets.map((asset) => [versionKey(asset.version.ref), asset]));
    const unitKeys = new Set(
        input.deployment.assets
            .filter(
                (asset) => asset.version.canonical.kind === "Memory" && asset.version.canonical.typeData.entityRole === "unit",
            )
            .map((asset) => versionKey(asset.version.ref)),
    );
    const catalogKeys = new Set(
        input.deployment.assets
            .filter(
                (asset) => asset.version.canonical.kind === "Memory" && asset.version.canonical.typeData.entityRole === "catalog",
            )
            .map((asset) => versionKey(asset.version.ref)),
    );
    const results: AdapterRenderAnalysisResult[] = [];
    if (unitKeys.size > 0) {
        const { targetFileSnapshots: _catalogSnapshots, ...unitDeployment } = input.deployment;
        const projected = {
            schemaVersion: 1 as const,
            deployment: {
                ...unitDeployment,
                assets: input.deployment.assets.filter((asset) => unitKeys.has(versionKey(asset.version.ref))),
            },
            requiredSemantics: input.requiredSemantics.filter((semantic) => unitKeys.has(versionKey(semantic.subject))),
            dialectInputs: input.dialectInputs.filter((entry) => unitKeys.has(versionKey(entry.targetVersion))),
        };
        results.push(
            appendZcodeBuildCompatibilityWarning(
                supports.unit.analyze(projected),
                projected,
                supports.unit.renderContractDeclaration,
            ),
        );
    }
    if (catalogKeys.size > 0) {
        const relatedKeys = new Set(catalogKeys);
        for (const key of catalogKeys) {
            const asset = assetsByVersion.get(key);
            if (asset?.version.canonical.kind !== "Memory" || asset.version.canonical.typeData.entityRole !== "catalog") continue;
            for (const member of asset.version.canonical.typeData.members) {
                const related = input.deployment.assets.find(
                    (candidate) => candidate.version.ref.versionId === member.targetAssetVersionId,
                );
                if (related !== undefined) relatedKeys.add(versionKey(related.version.ref));
            }
        }
        const projected = {
            schemaVersion: 1 as const,
            deployment: {
                ...input.deployment,
                assets: input.deployment.assets.filter((asset) => relatedKeys.has(versionKey(asset.version.ref))),
            },
            requiredSemantics: input.requiredSemantics.filter((semantic) => catalogKeys.has(versionKey(semantic.subject))),
            dialectInputs: input.dialectInputs.filter((entry) => relatedKeys.has(versionKey(entry.targetVersion))),
        };
        results.push(
            appendZcodeBuildCompatibilityWarning(
                supports.catalog.analyze(projected),
                projected,
                supports.catalog.renderContractDeclaration,
            ),
        );
    }
    const classified = new Set([...unitKeys, ...catalogKeys]);
    const unclassified = input.requiredSemantics.filter((semantic) => !classified.has(versionKey(semantic.subject)));
    if (unclassified.length > 0 || results.length === 0) {
        const unavailable = diagnostic(
            "render",
            "zcode_memory_native_variant_unavailable",
            "ZCode Memory target requires one exact project topic or ordered Catalog native lineage",
            "unsupported",
            "error",
        );
        results.push({
            status: "failed",
            outputUnits: [],
            semanticOptions: [],
            blockedSemanticRefs: unclassified.map((semantic) => ({
                semanticRefFingerprint: semantic.semanticRefFingerprint,
                reasonCode: unavailable.code,
                diagnostics: [unavailable],
            })),
            diagnostics: [unavailable],
        });
    }
    return mergeAnalysis(input, results);
}

function mergeAnalysis(input: RenderAnalysisInput, results: readonly AdapterRenderAnalysisResult[]): AdapterRenderAnalysisResult {
    const outputUnits = results.flatMap((result) => result.outputUnits);
    const semanticOptions = results.flatMap((result) => result.semanticOptions);
    const blockedSemanticRefs = results.flatMap((result) => result.blockedSemanticRefs);
    const diagnostics = results.flatMap((result) => result.diagnostics);
    const expected = input.requiredSemantics.map((semantic) => semantic.semanticRefFingerprint).sort(compareText);
    const actual = [
        ...semanticOptions.map((option) => option.semanticRefFingerprint),
        ...blockedSemanticRefs.map((blocked) => blocked.semanticRefFingerprint),
    ].sort(compareText);
    if (
        expected.length !== actual.length ||
        expected.some((fingerprint, index) => fingerprint !== actual[index]) ||
        new Set(actual).size !== actual.length ||
        new Set(outputUnits.map((unit) => unit.outputUnitFingerprint)).size !== outputUnits.length
    ) {
        const invalid = diagnostic(
            "render",
            "zcode_memory_variant_closure_invalid",
            "ZCode Memory target variants did not classify one exact semantic closure",
            "conflict",
            "error",
        );
        return {
            status: "failed",
            outputUnits: [],
            semanticOptions: [],
            blockedSemanticRefs: input.requiredSemantics.map((semantic) => ({
                semanticRefFingerprint: semantic.semanticRefFingerprint,
                reasonCode: invalid.code,
                diagnostics: [invalid],
            })),
            diagnostics: [invalid],
        };
    }
    outputUnits.sort((left, right) => compareText(left.outputUnitFingerprint, right.outputUnitFingerprint));
    semanticOptions.sort((left, right) =>
        compareText(
            `${left.semanticRefFingerprint}\0${left.optionFingerprint}`,
            `${right.semanticRefFingerprint}\0${right.optionFingerprint}`,
        ),
    );
    blockedSemanticRefs.sort((left, right) => compareText(left.semanticRefFingerprint, right.semanticRefFingerprint));
    return {
        status: blockedSemanticRefs.length === 0 ? "complete" : semanticOptions.length === 0 ? "failed" : "partial",
        outputUnits,
        semanticOptions,
        blockedSemanticRefs,
        diagnostics,
    };
}

function versionKey(ref: { assetId: string; versionId: string }): string {
    return `${ref.assetId}\0${ref.versionId}`;
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
