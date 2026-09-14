/** Reusable Provider entry checks against actual materialized output and independent source authority. */

import type { AdapterProvider, CanonicalRenderEntryValidationInput, RenderMaterializationInput } from "@oaam/core";
import { expect } from "vitest";

/** Deliberately mutable copies are used only for rejection controls; source authority stays untouched. */
type MutableEntryInput = {
    -readonly [Key in keyof CanonicalRenderEntryValidationInput]: Key extends "nativeEntry"
        ? { -readonly [Part in keyof CanonicalRenderEntryValidationInput[Key]]: CanonicalRenderEntryValidationInput[Key][Part] }
        : CanonicalRenderEntryValidationInput[Key];
};

export function assertCanonicalEntryControls(
    provider: AdapterProvider,
    request: RenderMaterializationInput,
    result: Awaited<ReturnType<AdapterProvider["materializeRender"]>>,
): void {
    if (result.materializationState !== "materialized") throw new Error("canonical output did not materialize");
    const unit = request.selection.outputUnits[0];
    const renderer = request.selection.outputUnitRenderers[0];
    const asset = request.deployment.assets[0];
    const group = request.dialectInputs[0];
    const token = group?.inputs.find((input) => input.inputKind === "canonical_materialization");
    const declaration = provider.renderContractDeclarations.find(
        (item) =>
            item.outputContractId === unit?.outputContractId &&
            item.materializationProfileId === renderer?.materializationProfileId,
    );
    const validator = provider.canonicalMaterializationValidators?.find(
        (item) =>
            item.outputContractId === unit?.outputContractId &&
            item.materializationProfileId === renderer?.materializationProfileId,
    );
    const canonicalEntry = asset?.version.files.find((file) => file.file.role === "entry");
    const semantic = request.requiredSemantics.find(
        (item) => item.subject.subjectKind === "file" && item.subject.fileId === canonicalEntry?.file.fileId,
    );
    const entries = result.materializedUnits
        .flatMap((item) => item.files)
        .filter((file) => semantic !== undefined && file.semanticRefFingerprints.includes(semantic.semanticRefFingerprint));
    const entry = entries[0];
    if (!asset || !group || !token || !declaration || !validator || !canonicalEntry || !entry || entries.length !== 1)
        throw new Error("canonical checker lost its exact source, output or registered binding");
    expect(validator.materializer).toEqual(token.materializer);
    const input: CanonicalRenderEntryValidationInput = structuredClone({
        canonical: asset.version.canonical,
        canonicalEntry:
            canonicalEntry.contentKind === "text"
                ? { contentKind: "text", text: canonicalEntry.text }
                : { contentKind: "binary", bytes: canonicalEntry.bytes },
        nativeEntry: { relativePath: entry.relativePath, content: entry.content },
        targetVersion: group.targetVersion,
        targetScope: declaration.declarationKind.startsWith("native_global_") ? "global" : "project",
        nativeDialectId: token.nativeDialectId,
        ...(token.nativePreservationSeed === undefined ? {} : { nativePreservationSeed: token.nativePreservationSeed }),
    });
    const original = structuredClone(input);
    expect(validator.validateEntry(input), `${provider.adapterId}: actual canonical output`).toBe(true);
    expect(input).toEqual(original);
    if (input.canonical.kind === "Skill" && input.nativePreservationSeed === undefined) {
        const foreign = structuredClone(input);
        if (foreign.canonical.kind !== "Skill") throw new Error("Skill source kind changed");
        // Seed-free entry conversion accepts a foreign description-only source.
        // Source-bound cases use actual import conformance; relabeling a seed is not valid source authority.
        foreign.canonical.typeData.entryDialectId = "claudecode-skill-markdown-v1";
        foreign.canonical.typeData.whenToUse = "";
        expect(validator.validateEntry(foreign), `${provider.adapterId}: foreign description-only source`).toBe(true);
    }
    const mutations: Array<[string, (value: MutableEntryInput) => void]> = [
        [
            "foreign target path",
            (value) => {
                value.nativeEntry.relativePath += ".outside";
            },
        ],
        [
            "wrong target dialect",
            (value) => {
                value.nativeDialectId = "unrelated-target-dialect";
            },
        ],
        [
            "different target scope",
            (value) => {
                value.targetScope = value.targetScope === "project" ? "global" : "project";
            },
        ],
        [
            "binary declaration",
            (value) => {
                value.nativeEntry.content = { contentKind: "binary", bytes: Uint8Array.of(1) };
            },
        ],
        [
            "binary source entry",
            (value) => {
                value.canonicalEntry = { contentKind: "binary", bytes: Uint8Array.of(1) };
            },
        ],
        [
            "wrong source kind",
            (value) => {
                value.canonical = { kind: "Guidance", typeData: {} } as never;
            },
        ],
        [
            "changed source body",
            (value) => {
                if (value.canonicalEntry.contentKind === "text") value.canonicalEntry.text += "changed source body\n";
            },
        ],
        [
            "changed target body",
            (value) => {
                if (value.nativeEntry.content.contentKind === "text") value.nativeEntry.content.text += "changed target body\n";
            },
        ],
    ];
    if (input.nativeEntry.content.contentKind === "text" && input.nativeEntry.content.text.startsWith("---\n")) {
        mutations.push(
            [
                "undeclared metadata",
                (value) => {
                    if (value.nativeEntry.content.contentKind === "text")
                        value.nativeEntry.content.text = value.nativeEntry.content.text.replace(
                            "---\n",
                            "---\nunknown-field: added\n",
                        );
                },
            ],
            [
                "unclosed metadata",
                (value) => {
                    value.nativeEntry.content = { contentKind: "text", text: "---\nname: broken\n" };
                },
            ],
            [
                "changed metadata value",
                (value) => {
                    if (value.nativeEntry.content.contentKind === "text")
                        value.nativeEntry.content.text = value.nativeEntry.content.text.replace(
                            /^(name|description):.*$/m,
                            '$1: "different-valid-string"',
                        );
                },
            ],
            [
                "wrong metadata type",
                (value) => {
                    if (value.nativeEntry.content.contentKind === "text")
                        value.nativeEntry.content.text = value.nativeEntry.content.text.replace(
                            /^(name|description):.*$/m,
                            "$1: []",
                        );
                },
            ],
        );
    }
    if (input.canonical.kind === "Skill")
        mutations.push([
            "empty source name",
            (value) => {
                if (value.canonical.kind === "Skill") value.canonical.typeData.name = "";
            },
        ]);
    for (const [label, mutate] of mutations) {
        const invalid = structuredClone(input);
        mutate(invalid);
        expect(invalid, `${provider.adapterId}: ${label} must alter the input`).not.toEqual(input);
        expect(validator.validateEntry(invalid), `${provider.adapterId}: ${label}`).toBe(false);
    }
    expect(input).toEqual(original);
}
