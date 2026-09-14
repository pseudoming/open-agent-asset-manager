/** Runtime-neutral native graph and byte-comparison mechanics for adapter dialect validators. */

import * as crypto from "node:crypto";
import type {
    AssetVersionFileContentV2,
    CandidateNativeRepresentationDirectoryInput,
    CandidateNativeRepresentationFileInput,
    FileReferenceV2,
    NativeDialectValidationInputV1,
    Sha256Digest,
    VersionFileInput,
} from "@oaam/core";
import { inferCanonicalMediaType } from "@oaam/core/adapter-spi";
import type { SourceDirectoryRecord, SourceFileRecord } from "./source-model";
import { compareCodeUnitText } from "./source-text";

export function buildSeparateNativeRepresentation<File extends SourceFileRecord>(
    dialectId: string,
    files: readonly File[],
): {
    representationSource: "separate_files";
    dialectId: string;
    files: CandidateNativeRepresentationFileInput[];
};
export function buildSeparateNativeRepresentation<File extends SourceFileRecord, Directory extends SourceDirectoryRecord>(
    dialectId: string,
    files: readonly File[],
    directories: readonly Directory[],
): {
    representationSource: "separate_file_graph";
    dialectId: string;
    directories: CandidateNativeRepresentationDirectoryInput[];
    files: CandidateNativeRepresentationFileInput[];
};
export function buildSeparateNativeRepresentation(
    dialectId: string,
    files: readonly SourceFileRecord[],
    directories?: readonly SourceDirectoryRecord[],
):
    | {
          representationSource: "separate_files";
          dialectId: string;
          files: CandidateNativeRepresentationFileInput[];
      }
    | {
          representationSource: "separate_file_graph";
          dialectId: string;
          directories: CandidateNativeRepresentationDirectoryInput[];
          files: CandidateNativeRepresentationFileInput[];
      } {
    const fileInputs = files
        .map(
            (file): CandidateNativeRepresentationFileInput => ({
                relativePath: file.relativePath as CandidateNativeRepresentationFileInput["relativePath"],
                contentKind: file.text === null ? ("binary" as const) : ("text" as const),
                mediaType: inferCanonicalMediaType(file.relativePath, file.text === null ? "binary" : "text"),
                bytes: new Uint8Array(file.bytes),
                executable: file.executable,
            }),
        )
        .sort((left, right) => compareCodeUnitText(left.relativePath, right.relativePath));
    if (directories === undefined) {
        return {
            representationSource: "separate_files" as const,
            dialectId,
            files: fileInputs,
        };
    }
    return {
        representationSource: "separate_file_graph" as const,
        dialectId,
        directories: directories
            .map(
                (directory): CandidateNativeRepresentationDirectoryInput => ({
                    relativePath: directory.relativePath as CandidateNativeRepresentationDirectoryInput["relativePath"],
                    observedReadEntryIds: [directory.observedReadEntryId],
                }),
            )
            .sort((left, right) => compareCodeUnitText(left.relativePath, right.relativePath)),
        files: fileInputs,
    };
}

export interface ComparableNativeFile {
    relativePath: string;
    contentKind: "text" | "binary";
    mediaType: string;
    bytes: number[];
    executable: boolean;
}

export interface ValidatedNativeSourceFileInput {
    relativePath: string;
    contentKind: "text" | "binary";
    bytes: Uint8Array;
    executable: boolean;
    index: number;
}

export interface NativeVersionFileProjectionPolicy {
    normalizeMediaType(mediaType: string): string;
    projectCandidateText(text: string): unknown;
    projectPersistedText(text: string): unknown;
    normalizeBinary(bytes: Uint8Array): unknown;
    projectReferences(references: readonly FileReferenceV2[]): unknown;
}

export interface CanonicalVersionFileProjection {
    logicalPath: string;
    role: VersionFileInput["role"];
    contentKind: "text" | "binary";
    mediaType: string;
    executable: boolean;
    references: unknown;
    content: unknown;
}

export function hydrateValidatedNativeSourceFiles<File extends SourceFileRecord>(
    input: NativeDialectValidationInputV1,
    buildFile: (input: ValidatedNativeSourceFileInput) => File,
): File[] | null {
    if (input.representation.schemaVersion !== 1 && input.representation.schemaVersion !== 2) return null;
    if (input.representation.schemaVersion === 2 && !("directories" in input.representation)) return null;
    const descriptors = new Map(input.representation.files.map((file) => [file.relativePath, file]));
    const payloads = new Map(input.nativeFiles.map((file) => [file.relativePath, file]));
    if (
        descriptors.size !== input.representation.files.length ||
        payloads.size !== input.nativeFiles.length ||
        descriptors.size !== payloads.size
    ) {
        return null;
    }
    const files: File[] = [];
    for (const [index, descriptor] of input.representation.files.entries()) {
        const payload = payloads.get(descriptor.relativePath);
        if (
            payload === undefined ||
            payload.bytes.byteLength !== descriptor.byteSize ||
            sha256SourceBytes(payload.bytes) !== descriptor.contentHash
        ) {
            return null;
        }
        files.push(
            buildFile({
                relativePath: descriptor.relativePath,
                contentKind: descriptor.contentKind,
                bytes: new Uint8Array(payload.bytes),
                executable: descriptor.executable,
                index,
            }),
        );
    }
    return files;
}

export function buildNativeAncestorDirectories<Directory>(
    paths: readonly string[],
    buildDirectory: (relativePath: string) => Directory,
): Directory[] {
    const parents = new Set<string>();
    for (const path of paths) {
        let parent = portableParent(path);
        while (parent !== "") {
            parents.add(parent);
            parent = portableParent(parent);
        }
    }
    return [...parents].sort(compareCodeUnitText).map(buildDirectory);
}

export function projectCandidateVersionFiles(
    files: readonly VersionFileInput[],
    policy: NativeVersionFileProjectionPolicy,
): CanonicalVersionFileProjection[] {
    return files.map((file) => projectCandidateVersionFile(file, policy)).sort(compareProjection);
}

export function projectPersistedVersionFiles(
    files: readonly AssetVersionFileContentV2[],
    policy: NativeVersionFileProjectionPolicy,
): CanonicalVersionFileProjection[] {
    return files.map((file) => projectPersistedVersionFile(file, policy)).sort(compareProjection);
}

export function comparableCandidateNativeFiles(
    files: readonly CandidateNativeRepresentationFileInput[],
    normalizeMediaType: (mediaType: string) => string,
): ComparableNativeFile[] {
    return files
        .map((file) => ({
            relativePath: file.relativePath,
            contentKind: file.contentKind,
            mediaType: normalizeMediaType(file.mediaType),
            bytes: [...file.bytes],
            executable: file.executable,
        }))
        .sort((left, right) => compareCodeUnitText(left.relativePath, right.relativePath));
}

export function comparablePersistedNativeFiles(
    input: NativeDialectValidationInputV1,
    normalizeMediaType: (mediaType: string) => string,
): ComparableNativeFile[] {
    const payloads = new Map(input.nativeFiles.map((file) => [file.relativePath, file.bytes]));
    return input.representation.files
        .map((file) => ({
            relativePath: file.relativePath,
            contentKind: file.contentKind,
            mediaType: normalizeMediaType(file.mediaType),
            bytes: [...(payloads.get(file.relativePath) ?? new Uint8Array())],
            executable: file.executable,
        }))
        .sort((left, right) => compareCodeUnitText(left.relativePath, right.relativePath));
}

export function sha256SourceBytes(bytes: Uint8Array): Sha256Digest {
    return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

export function zeroSha256Digest(): Sha256Digest {
    return `sha256:${"0".repeat(64)}`;
}

export function stableSourceValueEqual(left: unknown, right: unknown): boolean {
    return JSON.stringify(canonicalSourceValue(left)) === JSON.stringify(canonicalSourceValue(right));
}

function projectCandidateVersionFile(
    file: VersionFileInput,
    policy: NativeVersionFileProjectionPolicy,
): CanonicalVersionFileProjection {
    return {
        logicalPath: file.logicalPath,
        role: file.role,
        contentKind: file.contentKind,
        mediaType: policy.normalizeMediaType(file.mediaType),
        executable: file.executable,
        references: policy.projectReferences(file.references ?? []),
        content: file.contentKind === "text" ? policy.projectCandidateText(file.text) : policy.normalizeBinary(file.bytes),
    };
}

function projectPersistedVersionFile(
    content: AssetVersionFileContentV2,
    policy: NativeVersionFileProjectionPolicy,
): CanonicalVersionFileProjection {
    return {
        logicalPath: content.file.logicalPath,
        role: content.file.role,
        contentKind: content.contentKind,
        mediaType: policy.normalizeMediaType(content.file.mediaType),
        executable: content.file.executable,
        references: policy.projectReferences(content.file.references),
        content:
            content.contentKind === "text" ? policy.projectPersistedText(content.text) : policy.normalizeBinary(content.bytes),
    };
}

function compareProjection(left: CanonicalVersionFileProjection, right: CanonicalVersionFileProjection): number {
    return compareCodeUnitText(left.logicalPath, right.logicalPath);
}

function portableParent(path: string): string {
    const separator = path.lastIndexOf("/");
    return separator === -1 ? "" : path.slice(0, separator);
}

function canonicalSourceValue(value: unknown): unknown {
    if (value instanceof Uint8Array) return { $bytes: [...value] };
    if (Array.isArray(value)) return value.map(canonicalSourceValue);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(
        Object.entries(value)
            .sort(([left], [right]) => compareCodeUnitText(left, right))
            .map(([key, entry]) => [key, canonicalSourceValue(entry)]),
    );
}
