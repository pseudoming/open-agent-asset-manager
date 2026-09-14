import type {
    AdapterNativeProjectExactFileRenderDeclarationV1,
    NativeProjectExactFileAssetKind,
} from "../../../src/contracts/source-import";
import { sha256Bytes } from "../../../src/foundation/crypto-bytes";

export const BUILD_BYTES = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02]);
export const BUILD_IDENTITY = sha256Bytes(BUILD_BYTES);
export const TARGET_SCHEMA_ID = "FIXTURE_PROJECT_TARGET_V1";
export const REQUIRED_FACTS = { "fixture.channel": "stable" };

export function makeExactFileDeclaration(
    assetKind: NativeProjectExactFileAssetKind,
    requiredFacts: Record<string, string> = REQUIRED_FACTS,
): AdapterNativeProjectExactFileRenderDeclarationV1 {
    const materializationProfileId = `fixture-${assetKind.toLowerCase()}-exact-v1`;
    const component = (role: string) => ({
        componentId: `fixture.native-exact.${assetKind.toLowerCase()}.${role}`,
        componentVersion: 1,
        configFingerprint: sha256Bytes(new TextEncoder().encode(`${assetKind}:${role}`)),
    });
    return {
        schemaVersion: 1,
        declarationKind: "native_project_exact_file_v1",
        outputContractId: `FIXTURE_${assetKind.toUpperCase()}_EXACT_V1`,
        materializationProfileId,
        agentRuntimeId: "ANTIGRAVITY_CLI",
        assetKind,
        nativeDialectId: `fixture-${assetKind.toLowerCase()}-dialect-v1`,
        projectPathValidator: component("path"),
        reverseParser: component("reverse"),
        rebaseMaterializer: null,
        restorationDialectIds: [],
        target: { targetContextSchemaId: TARGET_SCHEMA_ID, requiredFacts },
        verifiedBuilds: [
            {
                agentRuntimeId: "ANTIGRAVITY_CLI",
                versionText: "9.9.10-exact",
                buildIdentity: BUILD_IDENTITY,
                platform: "wsl",
                materializationProfileId,
                fixtureSetFingerprint: sha256Bytes(new TextEncoder().encode(`fixture:${assetKind}`)),
            },
        ],
    };
}

export function compatibilityPolicy() {
    return {
        schemaVersion: 1 as const,
        versionOrdering: "numeric_dotted_core_v1" as const,
        unknownVersionPolicy: "allow_with_warning" as const,
        deniedBuilds: [],
    };
}

export function targetDiagnostic(code: string) {
    return {
        severity: "error" as const,
        code,
        message: code,
        path: "",
        traceId: "",
        operation: "probe" as const,
        causeKind: "verification_failed" as const,
        retryable: false,
        suggestedActions: [],
        rawSummary: "",
    };
}
