/** Frozen Provider contributions to the existing canonical exact-graph validation path. */

import type { AdapterProviderStaticDeclarations } from "../contracts/adapter";
import type { AdapterCanonicalMaterializationValidatorV1 } from "../contracts/render";
import type { AdapterProviderSummary } from "../contracts/source-import";
import type { AdapterId } from "../contracts/primitives";
import { deepFreezeParentFirst } from "../foundation/deep-freeze";
import { stableStringify } from "../foundation/fingerprint";
import { hasExactKeys } from "../foundation/validators";

export type CanonicalMaterializationValidatorsByAdapter = ReadonlyMap<
    AdapterId,
    readonly AdapterCanonicalMaterializationValidatorV1[]
>;

export function snapshotCanonicalMaterializationValidators(
    validators: readonly AdapterCanonicalMaterializationValidatorV1[] | undefined,
): readonly AdapterCanonicalMaterializationValidatorV1[] {
    if (validators === undefined) return Object.freeze([]);
    if (!Array.isArray(validators)) throw new Error("canonical materialization validators must be an array");
    return Object.freeze(
        validators.map((validator) => {
            if (
                !hasExactKeys(validator, [
                    "outputContractId",
                    "materializationProfileId",
                    "materializer",
                    "validateEntry",
                    ...("assessLoss" in validator ? ["assessLoss"] : []),
                ]) ||
                typeof validator.validateEntry !== "function" ||
                ("assessLoss" in validator && typeof validator.assessLoss !== "function")
            ) {
                throw new Error("canonical materialization validator requires one component and an entry checker");
            }
            return Object.freeze({
                outputContractId: validator.outputContractId,
                materializationProfileId: validator.materializationProfileId,
                materializer: deepFreezeParentFirst(structuredClone(validator.materializer)),
                validateEntry: validator.validateEntry,
                ...(validator.assessLoss === undefined ? {} : { assessLoss: validator.assessLoss }),
            });
        }),
    );
}

export function canonicalMaterializationValidatorsForProviders(
    providers: readonly AdapterProviderStaticDeclarations[],
): CanonicalMaterializationValidatorsByAdapter {
    const result = new Map<AdapterId, readonly AdapterCanonicalMaterializationValidatorV1[]>();
    for (const provider of providers) {
        if (result.has(provider.adapterId)) throw new Error("canonical validator Provider is duplicated");
        result.set(provider.adapterId, provider.canonicalMaterializationValidators ?? []);
    }
    return result;
}

/** The declared component is the ownership authority; a callable alone creates no conversion capability. */
export function validateCanonicalMaterializationContributions(
    providers: readonly AdapterProviderSummary[],
    contributions: CanonicalMaterializationValidatorsByAdapter,
): void {
    const providerIds = new Set(providers.map((provider) => provider.adapterId));
    if ([...contributions.keys()].some((adapterId) => !providerIds.has(adapterId))) {
        throw new Error("canonical materialization validator has no Provider owner");
    }
    for (const provider of providers) {
        const expected = new Map(
            provider.renderContractDeclarations.flatMap((declaration) =>
                (declaration.declarationKind === "native_project_exact_graph_v1" ||
                    declaration.declarationKind === "native_global_exact_graph_v1") &&
                declaration.canonicalMaterialization !== undefined
                    ? [
                          [
                              contributionKey({
                                  ...declaration,
                                  materializer: declaration.canonicalMaterialization.materializer,
                              }),
                              declaration.canonicalMaterialization.assessesLoss === true,
                          ] as const,
                      ]
                    : [],
            ),
        );
        const seen = new Set<string>();
        for (const validator of contributions.get(provider.adapterId) ?? []) {
            const identity = contributionKey(validator);
            if (
                typeof validator.validateEntry !== "function" ||
                !expected.has(identity) ||
                seen.has(identity) ||
                (typeof validator.assessLoss === "function") !== expected.get(identity)
            ) {
                throw new Error("canonical materialization validator is invalid, undeclared or duplicated");
            }
            seen.add(identity);
        }
        if (seen.size !== expected.size) throw new Error("declared canonical materialization has no content validator");
    }
}

export function findCanonicalMaterializationValidator(
    contributions: CanonicalMaterializationValidatorsByAdapter,
    adapterId: AdapterId,
    binding: Pick<AdapterCanonicalMaterializationValidatorV1, "outputContractId" | "materializationProfileId" | "materializer">,
): AdapterCanonicalMaterializationValidatorV1 | undefined {
    const identity = contributionKey(binding);
    const matches = contributions.get(adapterId)?.filter((validator) => contributionKey(validator) === identity) ?? [];
    return matches.length === 1 ? matches[0] : undefined;
}

function contributionKey(
    binding: Pick<AdapterCanonicalMaterializationValidatorV1, "outputContractId" | "materializationProfileId" | "materializer">,
): string {
    return stableStringify([binding.outputContractId, binding.materializationProfileId, binding.materializer]);
}
