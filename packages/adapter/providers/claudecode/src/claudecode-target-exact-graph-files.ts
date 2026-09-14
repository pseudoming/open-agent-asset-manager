/** File-level helpers shared by Claude exact-graph target variants. */

import type { NativeProjectExactGraphRebaseInput, PosixRelativePath, RenderNativeRepresentationFileInput } from "@oaam/core";
import { sha256SourceBytes } from "@oaam/adapter-framework";
import { validateClaudeCodeNativeDialect } from "./claudecode-source-read";

export function nativeDescriptor(file: RenderNativeRepresentationFileInput) {
    const {
        text: _text,
        bytes: _bytes,
        ...descriptor
    } = file as RenderNativeRepresentationFileInput & {
        text?: string;
        bytes?: Uint8Array;
    };
    return descriptor;
}

export function validatesRebasedGraph(
    input: NativeProjectExactGraphRebaseInput,
    nativeFiles: RenderNativeRepresentationFileInput[],
): boolean {
    const descriptors = nativeFiles.map(nativeDescriptor);
    return validateClaudeCodeNativeDialect({
        canonical: input.targetCanonical,
        canonicalFiles: input.targetFiles,
        representation: { ...input.parent.representation, files: descriptors },
        nativeFiles: nativeFiles.map((file) => ({
            relativePath: file.relativePath,
            bytes: file.contentKind === "text" ? new TextEncoder().encode(file.text) : new Uint8Array(file.bytes),
        })),
    });
}

export function textNativeFile(relativePath: PosixRelativePath, text: string, mediaType: string, executable: boolean) {
    const bytes = new TextEncoder().encode(text);
    return {
        relativePath,
        contentKind: "text" as const,
        mediaType,
        executable,
        contentHash: sha256SourceBytes(bytes),
        byteSize: bytes.byteLength,
        text,
    };
}

export function binaryNativeFile(relativePath: PosixRelativePath, source: Uint8Array, mediaType: string, executable: boolean) {
    const bytes = new Uint8Array(source);
    return {
        relativePath,
        contentKind: "binary" as const,
        mediaType,
        executable,
        contentHash: sha256SourceBytes(bytes),
        byteSize: bytes.byteLength,
        bytes,
    };
}

export function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
