/** Real source-parser fixtures shared by historical validation and current conversion controls. */

import type { AdapterExtractedAssetCandidate, AssetVersionFileContentV2, NativeDialectValidationInputV1 } from "@oaam/core";
import { expect } from "vitest";
import { binaryPayloadStats, textPayloadStats } from "../../../../core/src/catalog/payload-store";
import {
    computeNativeDialectContractFingerprint,
    computeVersionCanonicalContentFingerprint,
    computeVersionNativeRepresentationFingerprint,
} from "../../../../core/src/foundation/fingerprint";
import { opencodeProvider } from "../src/opencode-provider";
import { appRawReadInput, fm, projectCapabilities, projectRoot, readProject } from "./opencode-source-test-fixtures";

export function validationInput(candidate: AdapterExtractedAssetCandidate): NativeDialectValidationInputV1 {
    if (candidate.kind !== "Skill" || candidate.nativeRepresentation.representationSource === "canonical_files")
        throw new Error("expected actual native Skill source");
    const canonical = { kind: "Skill" as const, typeData: structuredClone(candidate.typeData) };
    const canonicalFiles: AssetVersionFileContentV2[] = candidate.files.map((value, index) => {
        const { logicalPath, role, mediaType, executable } = value;
        const stats = value.contentKind === "text" ? textPayloadStats(value.text) : binaryPayloadStats(value.bytes);
        const file = {
            fileId: `11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`,
            logicalPath,
            role,
            mediaType,
            executable,
            contentKind: value.contentKind,
            ...stats,
            references: structuredClone(value.references ?? []),
        };
        return value.contentKind === "text"
            ? { file, contentKind: "text", text: value.text }
            : { file, contentKind: "binary", bytes: new Uint8Array(value.bytes) };
    });
    const source = candidate.nativeRepresentation;
    const contract = opencodeProvider.dialectContracts.native.find((x) => x.definition.dialectId === source.dialectId);
    if (contract === undefined) throw new Error("missing source contract");
    const common = {
        dialectId: source.dialectId,
        dialectContractFingerprint: computeNativeDialectContractFingerprint(contract.definition),
        canonicalContentFingerprint: computeVersionCanonicalContentFingerprint(
            canonical,
            canonicalFiles.map((file) => file.file),
        ),
        files: source.files.map(({ relativePath, contentKind, mediaType, executable, bytes }) => ({
            relativePath,
            contentKind,
            mediaType,
            executable,
            ...binaryPayloadStats(bytes),
        })),
    };
    const preimage =
        source.representationSource === "separate_file_graph"
            ? { ...common, schemaVersion: 2 as const, directories: source.directories.map((directory) => directory.relativePath) }
            : { ...common, schemaVersion: 1 as const };
    return {
        canonical,
        canonicalFiles,
        representation: { ...preimage, representationFingerprint: computeVersionNativeRepresentationFingerprint(preimage) },
        nativeFiles: source.files.map((file) => ({ relativePath: file.relativePath, bytes: new Uint8Array(file.bytes) })),
    };
}
export async function readBoth(slash: string) {
    const files = {
        ".opencode/skills/review/SKILL.md": fm(
            "name: review\ndescription: Review changes\nlicense: MIT\nmetadata:\n  owner: OAAM\n# retain author formatting\n" +
                slash,
            "Review [notes](notes.md).",
        ),
        ".opencode/skills/review/notes.md": "Preserved notes.\n",
        ".opencode/skills/review/marker.bin": Uint8Array.of(0, 255, 7),
        ".opencode/skills/review/run.py": { text: "print('review')\n", executable: true },
    };
    const cli = await readProject(["Skill"], files);
    const app = await opencodeProvider.read(
        appRawReadInput(projectRoot(), projectCapabilities(["Skill"], "OPENCODE_APP"), files),
    );
    expect(cli.candidates).toHaveLength(1);
    expect(app.candidates).toHaveLength(1);
    const current = cli.candidates[0]!,
        historical = app.candidates[0]!;
    expect(current.status).toBe("complete");
    expect(historical.status).toBe("complete");
    if (current.kind !== "Skill" || historical.kind !== "Skill") throw new Error("missing Skill");
    return { current, historical };
}
