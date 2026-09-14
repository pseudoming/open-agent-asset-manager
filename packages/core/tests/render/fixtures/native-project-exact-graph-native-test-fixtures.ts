/** Native graph mechanics for the synthetic exact-graph Skill contract. */

import type { AdapterNativeDialectContractV1, AssetKindTypeDataV2, PosixRelativePath, Sha256Digest } from "../../../src/types";
import type { RenderAnalysisInput, RenderNativeRepresentationFileInput } from "../../../src/contracts/render";
import {
    computeNativeDialectContractFingerprint,
    computeVersionNativeRepresentationFingerprint,
} from "../../../src/foundation/fingerprint";
import { binaryPayloadStats, bytesForPayload, textPayloadStats } from "../../../src/catalog/payload-store";
import type {
    NativeProjectExactGraphCanonicalMaterializer,
    NativeProjectExactGraphRebaseInput,
    NativeProjectExactGraphRebaseMaterializer,
} from "../../../src/render/native-project-exact-graph";
import { ASSET_ID, VERSION_ID } from "../../catalog/fixtures/version-v2";

export const GRAPH_HASH = `sha256:${"6".repeat(64)}` as Sha256Digest;
export const GRAPH_DIALECT_ID = "fixture-skill-folder-v1";
export const GRAPH_PROFILE_ID = "fixture-cli-project-skill-graph-v1";
export const GRAPH_OUTPUT_CONTRACT_ID = "FIXTURE_NATIVE_PROJECT_SKILL_GRAPH_V1";
export const GRAPH_BOUNDARY = ".fixture/skills/review" as PosixRelativePath;
export const GRAPH_ENTRY_PATH = `${GRAPH_BOUNDARY}/SKILL.md` as PosixRelativePath;
export const GRAPH_TEXT_RESOURCE_PATH = `${GRAPH_BOUNDARY}/resources/marker.txt` as PosixRelativePath;
export const GRAPH_BINARY_RESOURCE_PATH = `${GRAPH_BOUNDARY}/resources/tool.bin` as PosixRelativePath;
export const GRAPH_ENTRY_TEXT = "# Review\nReview the current change and read resources/marker.txt.\n";
export const GRAPH_REBASED_ENTRY_TEXT = "# Review\nReview the foreign change and read resources/marker.txt.\n";
export const GRAPH_CHANGED_ENTRY_TEXT = "# Review\nReview the deployed change and read resources/marker.txt.\n";
export const GRAPH_TEXT_RESOURCE = "fixture-resource-v1\n";
export const GRAPH_CHANGED_TEXT_RESOURCE = "fixture-resource-v2\n";
export const GRAPH_BINARY_RESOURCE = Uint8Array.of(0, 1, 2, 127, 255);
export const GRAPH_CHANGED_BINARY_RESOURCE = Uint8Array.of(0, 1, 3, 127, 255);

const GRAPH_NATIVE_HEADER =
    "---\n# fixture-native-layout: keep\nname: review\ndescription: Review changes\nx-fixture-only: keep-me\n---\n";
export const GRAPH_NATIVE_ENTRY_TEXT = `${GRAPH_NATIVE_HEADER}${GRAPH_ENTRY_TEXT}`;
export const GRAPH_REBASED_NATIVE_ENTRY_TEXT =
    GRAPH_NATIVE_HEADER.replace("description: Review changes", "description: Review foreign changes") + GRAPH_REBASED_ENTRY_TEXT;
export const GRAPH_CHANGED_NATIVE_ENTRY_TEXT = `${GRAPH_NATIVE_HEADER}${GRAPH_CHANGED_ENTRY_TEXT}`;

export const GRAPH_VALIDATOR_REF = {
    componentId: "fixture.skill.project-graph",
    componentVersion: 1,
    configFingerprint: `sha256:${"1".repeat(64)}` as Sha256Digest,
};
export const GRAPH_PARSER_REF = {
    componentId: "fixture.skill.graph-parser",
    componentVersion: 1,
    configFingerprint: `sha256:${"2".repeat(64)}` as Sha256Digest,
};
export const GRAPH_REBASE_REF = {
    componentId: "fixture.skill.graph-rebase",
    componentVersion: 1,
    configFingerprint: `sha256:${"3".repeat(64)}` as Sha256Digest,
};
export const GRAPH_CANONICAL_REF = {
    componentId: "fixture.skill.graph-canonical-materializer",
    componentVersion: 1,
    configFingerprint: `sha256:${"4".repeat(64)}` as Sha256Digest,
};

export const graphCanonicalMaterializer: NativeProjectExactGraphCanonicalMaterializer = {
    ref: GRAPH_CANONICAL_REF,
    degradationKinds: ["target_runtime_missing_asset_kind"],
    reasonCode: "fixture_skill_reviewed_migration",
    diagnosticMessage: "The fixture Skill is written through a reviewed canonical migration",
    validateEntry(input) {
        return (
            input.canonical.kind === "Skill" &&
            input.canonical.typeData.name === "review" &&
            input.canonical.typeData.description === "Review changes" &&
            input.canonicalEntry.contentKind === "text" &&
            input.nativeEntry.content.contentKind === "text" &&
            input.nativeEntry.content.text === GRAPH_NATIVE_HEADER + input.canonicalEntry.text
        );
    },
    materialize(input) {
        if (
            input.assetKind !== "Skill" ||
            input.nativeDialectId !== GRAPH_DIALECT_ID ||
            input.targetCanonical.kind !== "Skill" ||
            input.targetFiles.length !== 3 ||
            input.restorationInputs.length !== 0
        ) {
            return null;
        }
        const group = makeGraphDialectInput(GRAPH_HASH, makeGraphNativeDialectContract());
        const native = group.inputs[0];
        return native?.inputKind === "native_representation" ? { nativeFiles: structuredClone(native.files) } : null;
    },
};

export function graphSkillCanonical(): Extract<AssetKindTypeDataV2, { kind: "Skill" }> {
    return {
        kind: "Skill",
        typeData: {
            schemaVersion: 2,
            name: "review",
            description: "Review changes",
            whenToUse: "Before accepting a change",
            entryDialectId: "fixture-skill-entry-v1",
            portableMetadata: { license: "", compatibility: "", metadata: {} },
            invocation: {
                pathCondition: { mode: "none" },
                user: { mode: "not_directly_invocable" },
                model: { mode: "model_decision" },
                argumentHint: "",
                argumentNames: [],
            },
            toolPolicy: { preapproved: [], denied: [], otherwise: "inherit_agent_runtime_policy" },
            execution: { mode: "caller", model: { mode: "inherit" }, effort: { mode: "inherit" } },
        },
    };
}

export function projectFixtureGraph(files: readonly RenderNativeRepresentationFileInput[]) {
    if (files.length < 2) return null;
    const boundaries = new Set(
        files.map((file) => {
            const match = /^(\.fixture\/skills\/[a-z0-9-]+)\/(?:SKILL\.md|resources\/.+)$/u.exec(file.relativePath);
            return match?.[1] ?? "";
        }),
    );
    const boundary = [...boundaries][0];
    if (
        boundaries.size !== 1 ||
        boundary === undefined ||
        boundary === "" ||
        files.filter((file) => file.relativePath === `${boundary}/SKILL.md`).length !== 1 ||
        new Set(files.map((file) => file.relativePath)).size !== files.length
    ) {
        return null;
    }
    const boundaryRelativePath = boundary as PosixRelativePath;
    const entryPath = `${boundary}/SKILL.md` as PosixRelativePath;
    return {
        graphIdentityRelativePath: entryPath,
        files: files.map((file) => ({
            nativeRelativePath: file.relativePath,
            canonicalLogicalPath: file.relativePath.slice(boundary.length + 1) as PosixRelativePath,
        })),
        managedDirectoryBoundaries: [boundaryRelativePath],
    };
}

export function parseChangedGraphFile(input: {
    assetKind: "Skill";
    nativeDialectId: string;
    relativePath: PosixRelativePath;
    appliedContent: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array };
    currentContent: { contentKind: "text"; text: string } | { contentKind: "binary"; bytes: Uint8Array };
}) {
    if (input.assetKind !== "Skill" || input.nativeDialectId !== GRAPH_DIALECT_ID) return null;
    if (input.relativePath === GRAPH_ENTRY_PATH) {
        if (input.appliedContent.contentKind !== "text" || input.currentContent.contentKind !== "text") return null;
        const applied = parseNativeEntry(input.appliedContent.text);
        const current = parseNativeEntry(input.currentContent.text);
        return applied === null || current === null || applied.header !== current.header
            ? null
            : { canonicalContent: { contentKind: "text" as const, text: current.body } };
    }
    if (
        !input.relativePath.startsWith(`${GRAPH_BOUNDARY}/resources/`) ||
        input.appliedContent.contentKind !== input.currentContent.contentKind
    ) {
        return null;
    }
    return input.currentContent.contentKind === "text"
        ? { canonicalContent: { contentKind: "text" as const, text: input.currentContent.text } }
        : { canonicalContent: { contentKind: "binary" as const, bytes: new Uint8Array(input.currentContent.bytes) } };
}

export const graphRebaseMaterializer: NativeProjectExactGraphRebaseMaterializer = {
    ref: GRAPH_REBASE_REF,
    materialize: rebaseGraph,
};

function rebaseGraph(input: NativeProjectExactGraphRebaseInput) {
    const projected = projectFixtureGraph(input.parent.files);
    if (
        input.assetKind !== "Skill" ||
        input.nativeDialectId !== GRAPH_DIALECT_ID ||
        input.targetCanonical.kind !== "Skill" ||
        projected?.graphIdentityRelativePath !== GRAPH_ENTRY_PATH
    ) {
        return null;
    }
    const parentByLogicalPath = new Map(
        input.parent.files.map((file) => [file.relativePath.slice(GRAPH_BOUNDARY.length + 1), file]),
    );
    if (
        parentByLogicalPath.size !== input.targetFiles.length ||
        input.targetFiles.some((file) => !parentByLogicalPath.has(file.file.logicalPath))
    ) {
        return null;
    }
    const nativeFiles: RenderNativeRepresentationFileInput[] = [];
    for (const target of input.targetFiles) {
        const parent = parentByLogicalPath.get(target.file.logicalPath);
        if (parent === undefined || parent.contentKind !== target.contentKind) return null;
        const relativePath = `${GRAPH_BOUNDARY}/${target.file.logicalPath}` as PosixRelativePath;
        if (target.file.role === "entry") {
            if (target.contentKind !== "text" || parent.contentKind !== "text") return null;
            const parsed = parseNativeEntry(parent.text);
            if (parsed === null) return null;
            const text =
                parsed.header
                    .replace(/^name: .*$/mu, `name: ${input.targetCanonical.typeData.name}`)
                    .replace(/^description: .*$/mu, `description: ${input.targetCanonical.typeData.description}`) + target.text;
            nativeFiles.push(textNativeFile(relativePath, text, target.file.mediaType, target.file.executable));
        } else if (target.contentKind === "text") {
            nativeFiles.push(textNativeFile(relativePath, target.text, target.file.mediaType, target.file.executable));
        } else {
            nativeFiles.push(binaryNativeFile(relativePath, target.bytes, target.file.mediaType, target.file.executable));
        }
    }
    return { nativeFiles: nativeFiles.sort((left, right) => comparePath(left.relativePath, right.relativePath)) };
}

export function makeGraphNativeDialectContract(dialectId = GRAPH_DIALECT_ID): AdapterNativeDialectContractV1 {
    const definition = {
        kind: "Skill" as const,
        dialectId,
        nativeFileGraphSchema: {
            componentId: "fixture.skill.graph-schema",
            componentVersion: 1,
            configFingerprint: GRAPH_HASH,
        },
        contentNormalization: {
            componentId: "fixture.skill.graph-normalization",
            componentVersion: 1,
            configFingerprint: GRAPH_HASH,
        },
        nativeToCanonicalParser: GRAPH_PARSER_REF,
        canonicalConsistencyValidator: {
            componentId: "fixture.skill.graph-consistency",
            componentVersion: 1,
            configFingerprint: GRAPH_HASH,
        },
        rebaseMaterializer: GRAPH_REBASE_REF,
        targetApplicabilityPredicate: null,
    };
    return {
        definition,
        validateSameContent(input) {
            if (
                input.canonical.kind !== "Skill" ||
                input.representation.dialectId !== dialectId ||
                input.canonicalFiles.length !== 3 ||
                input.nativeFiles.length !== 3 ||
                input.representation.files.length !== 3
            ) {
                return false;
            }
            const nativeBytes = new Map(input.nativeFiles.map((file) => [file.relativePath, file.bytes]));
            const descriptors = new Map(input.representation.files.map((file) => [file.relativePath, file]));
            for (const canonicalFile of input.canonicalFiles) {
                const nativePath = `${GRAPH_BOUNDARY}/${canonicalFile.file.logicalPath}` as PosixRelativePath;
                const bytes = nativeBytes.get(nativePath);
                const descriptor = descriptors.get(nativePath);
                if (bytes === undefined || descriptor === undefined) return false;
                const stats = binaryPayloadStats(bytes);
                if (
                    descriptor.contentHash !== stats.contentHash ||
                    descriptor.byteSize !== stats.byteSize ||
                    descriptor.contentKind !== canonicalFile.contentKind ||
                    descriptor.mediaType !== canonicalFile.file.mediaType ||
                    descriptor.executable !== canonicalFile.file.executable
                ) {
                    return false;
                }
                if (canonicalFile.file.role === "entry") {
                    if (canonicalFile.contentKind !== "text") return false;
                    const parsed = parseNativeEntry(Buffer.from(bytes).toString("utf8"));
                    if (
                        parsed === null ||
                        parsed.name !== input.canonical.typeData.name ||
                        parsed.description !== input.canonical.typeData.description ||
                        parsed.body !== canonicalFile.text
                    ) {
                        return false;
                    }
                } else {
                    const canonicalBytes = bytesForPayload(
                        canonicalFile.contentKind === "text" ? canonicalFile.text : canonicalFile.bytes,
                        canonicalFile.contentKind,
                    );
                    if (!Buffer.from(bytes).equals(Buffer.from(canonicalBytes))) return false;
                }
            }
            return true;
        },
    };
}

export function makeGraphDialectInput(
    canonicalContentFingerprint: Sha256Digest,
    contract: AdapterNativeDialectContractV1,
    options: {
        targetVersion?: { assetId: string; versionId: string };
        entryText?: string;
        textResource?: string;
        binaryResource?: Uint8Array;
        directories?: readonly PosixRelativePath[];
    } = {},
): RenderAnalysisInput["dialectInputs"][number] {
    const files = [
        textNativeFile(GRAPH_ENTRY_PATH, options.entryText ?? GRAPH_NATIVE_ENTRY_TEXT, "text/markdown", false),
        textNativeFile(GRAPH_TEXT_RESOURCE_PATH, options.textResource ?? GRAPH_TEXT_RESOURCE, "text/plain", false),
        binaryNativeFile(
            GRAPH_BINARY_RESOURCE_PATH,
            options.binaryResource ?? GRAPH_BINARY_RESOURCE,
            "application/octet-stream",
            false,
        ),
    ].sort((left, right) => comparePath(left.relativePath, right.relativePath));
    const descriptors = files.map((file) => {
        if (file.contentKind === "text") {
            const { text: _text, ...descriptor } = file;
            return descriptor;
        }
        const { bytes: _bytes, ...descriptor } = file;
        return descriptor;
    });
    const common = {
        dialectId: contract.definition.dialectId,
        dialectContractFingerprint: computeNativeDialectContractFingerprint(contract.definition),
        canonicalContentFingerprint,
        files: descriptors,
    };
    const preimage =
        options.directories === undefined
            ? { ...common, schemaVersion: 1 as const }
            : { ...common, schemaVersion: 2 as const, directories: [...options.directories] };
    const representation = {
        ...preimage,
        representationFingerprint: computeVersionNativeRepresentationFingerprint(preimage),
    };
    const { files: _files, ...metadata } = representation;
    return {
        targetVersion: options.targetVersion ?? { assetId: ASSET_ID, versionId: VERSION_ID },
        consumerAgentRuntimeIds: ["FIXTURE_CLI"],
        inputs: [{ inputKind: "native_representation", inputRole: "current_exact", representation: metadata, files }],
    };
}

function textNativeFile(relativePath: PosixRelativePath, text: string, mediaType: string, executable: boolean) {
    return { relativePath, contentKind: "text" as const, mediaType, executable, ...textPayloadStats(text), text };
}

function binaryNativeFile(relativePath: PosixRelativePath, bytes: Uint8Array, mediaType: string, executable: boolean) {
    const copy = new Uint8Array(bytes);
    return { relativePath, contentKind: "binary" as const, mediaType, executable, ...binaryPayloadStats(copy), bytes: copy };
}

function parseNativeEntry(text: string) {
    const match =
        /^(---\n# fixture-native-layout: keep\nname: ([^\n]+)\ndescription: ([^\n]+)\nx-fixture-only: keep-me\n---\n)([\s\S]+)$/u.exec(
            text,
        );
    return match === null
        ? null
        : { header: match[1] as string, name: match[2] as string, description: match[3] as string, body: match[4] as string };
}

function comparePath(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
