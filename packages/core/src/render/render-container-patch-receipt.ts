/** Pure validation of Provider-declared operation-local container-patch receipts. */

import type { MaterializedRenderFile } from "../contracts/render";
import type { AdapterProviderSummary } from "../types";

export interface JsoncTopLevelPropertyPatchDeclaration {
    propertyName: string;
    allowedContainerRelativePaths: readonly string[];
}

export function declaredJsoncTopLevelPropertyPatch(
    provider: AdapterProviderSummary,
    outputContractId: string,
    materializationProfileId: string,
): JsoncTopLevelPropertyPatchDeclaration | undefined {
    const declaration = provider.renderContractDeclarations.find(
        (candidate) =>
            (candidate.declarationKind === "native_project_exact_graph_v1" ||
                candidate.declarationKind === "native_global_exact_graph_v1") &&
            candidate.outputContractId === outputContractId &&
            candidate.materializationProfileId === materializationProfileId,
    );
    return declaration?.declarationKind === "native_project_exact_graph_v1" ||
        declaration?.declarationKind === "native_global_exact_graph_v1"
        ? declaration.jsoncTopLevelPropertyPatch
        : undefined;
}

export function isDeclaredJsoncContainerPatch(
    file: MaterializedRenderFile,
    patch: NonNullable<MaterializedRenderFile["containerPatch"]>,
    declaration: JsoncTopLevelPropertyPatchDeclaration | undefined,
): boolean {
    return (
        declaration !== undefined &&
        patch.patchKind === "jsonc_top_level_property_value" &&
        patch.propertyName === declaration.propertyName &&
        declaration.allowedContainerRelativePaths.includes(file.relativePath) &&
        file.content.contentKind === "binary" &&
        !file.executable &&
        file.sectionBindings.length === 0
    );
}

export function isExactJsoncContainerPatchClosure(
    declaration: JsoncTopLevelPropertyPatchDeclaration | undefined,
    patchCount: number,
): boolean {
    return declaration === undefined ? patchCount === 0 : patchCount === 1;
}
