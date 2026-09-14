/** Core-owned adapter read execution and immutable authority projection. */

import type {
    AdapterAssetSourceCapability,
    AdapterProvider,
    AdapterProviderReadResult,
    AdapterReadResult,
    AdapterReadTarget,
    CoreResult,
    ManagedTargetReadGuard,
    Platform,
    Sha256Digest,
    SourceReadObligation,
    SourceRoot,
} from "../types";
import {
    createAdapterReadOperation,
    type AdapterReadOperation,
    type AdapterReadFinalValidation,
    type CreateAdapterReadOperationInput,
    type ReadAuthorityRevalidator,
} from "../adapters/adapter-read-access";
import { prepareRead } from "./source-read-preparation";
import { validateProviderReadResult } from "./source-read-provider-result-validator";
import { computeReadSnapshotFingerprint, validateAdapterReadResultSnapshot } from "./source-read-snapshot-validator";
import { aggregateReadStatus, deriveSourceReports, rewriteCandidateIds } from "./source-read-result";
import { failedResult, sourceDiagnostic } from "./source-read-validation-helpers";

export interface AdapterReadAuthorityContext {
    managedTargetGuards: ManagedTargetReadGuard[];
    reservationIdentityFingerprints: Sha256Digest[];
    transactionsRoot: string;
}

export interface PreparedRead {
    platform: Platform;
    roots: SourceRoot[];
    obligations: SourceReadObligation[];
    capabilities: AdapterAssetSourceCapability[];
    readAuthorityFingerprint: Sha256Digest;
}

/** Private operation ownership may await Host physical authority; AdapterReadAccess remains the existing SPI. */
export interface OwnedAdapterReadOperation extends Omit<AdapterReadOperation, "finalValidate"> {
    settle?(): Promise<void>;
    finalValidate(): AdapterReadFinalValidation | Promise<AdapterReadFinalValidation>;
}
export type AdapterReadOperationOwner = (input: CreateAdapterReadOperationInput) => OwnedAdapterReadOperation;

/** @internal Restricted source composition keeps the original preparation, Provider and result validation. */
export async function executeAdapterReadWithOperationOwner(
    provider: AdapterProvider,
    target: AdapterReadTarget,
    authority: AdapterReadAuthorityContext,
    createOperation: AdapterReadOperationOwner,
): Promise<CoreResult<AdapterReadResult>> {
    return executeAdapterReadCore(provider, target, authority, createOperation);
}

export async function executeAdapterReadWithAuthority(
    provider: AdapterProvider,
    target: AdapterReadTarget,
    authority: AdapterReadAuthorityContext,
    revalidateAuthority: ReadAuthorityRevalidator = () => true,
): Promise<CoreResult<AdapterReadResult>> {
    return executeAdapterReadCore(provider, target, authority, (input) => createAdapterReadOperation(input, revalidateAuthority));
}

/** Test-only port fault seam; architecture tests forbid production imports. */
export async function executeAdapterReadWithAuthorityForTest(
    provider: AdapterProvider,
    target: AdapterReadTarget,
    authority: AdapterReadAuthorityContext,
    createOperation: (
        input: CreateAdapterReadOperationInput,
        revalidateAuthority: ReadAuthorityRevalidator,
    ) => AdapterReadOperation,
    revalidateAuthority: ReadAuthorityRevalidator = () => true,
): Promise<CoreResult<AdapterReadResult>> {
    return executeAdapterReadCore(provider, target, authority, (input) => createOperation(input, revalidateAuthority));
}

async function executeAdapterReadCore(
    provider: AdapterProvider,
    sourceTarget: AdapterReadTarget,
    sourceAuthority: AdapterReadAuthorityContext,
    createOperation: AdapterReadOperationOwner,
): Promise<CoreResult<AdapterReadResult>> {
    const target = structuredClone(sourceTarget);
    const authority = structuredClone(sourceAuthority);
    const preparation = prepareRead(provider, target, authority);
    if ("diagnostics" in preparation) return failedResult(preparation.diagnostics);

    const operation = createOperation({
        platform: preparation.platform,
        sourceRoots: preparation.roots,
        sourceReadObligations: preparation.obligations,
        sourceCapabilities: preparation.capabilities,
        managedTargetGuards: authority.managedTargetGuards,
        readAuthorityFingerprint: preparation.readAuthorityFingerprint,
        transactionsRoot: authority.transactionsRoot,
    });

    let providerResult: AdapterProviderReadResult;
    try {
        providerResult = structuredClone(
            await provider.read({
                target: { sourceSelector: structuredClone(target.sourceSelector) },
                sourceReadObligations: structuredClone(preparation.obligations),
                managedTargetGuards: structuredClone(authority.managedTargetGuards),
                readAuthorityFingerprint: preparation.readAuthorityFingerprint,
                readAccess: Object.freeze({ ...operation.readAccess }),
            }),
        );
        await operation.settle?.();
    } catch (error) {
        await operation.settle?.();
        return failedResult([sourceDiagnostic("read.provider_threw", `provider read threw: ${String(error)}`)]);
    }

    const initialLedger = operation.snapshot();
    const providerDiagnostics = validateProviderReadResult(
        target,
        preparation,
        authority.managedTargetGuards,
        initialLedger,
        providerResult,
    );
    const finalValidation = await operation.finalValidate();
    const ledger = operation.snapshot();
    const validationDiagnostics = [...providerDiagnostics, ...finalValidation.diagnostics];
    const rewritten = rewriteCandidateIds(provider.adapterId, preparation.readAuthorityFingerprint, providerResult);
    const sourceReports = deriveSourceReports(
        preparation.roots,
        rewritten.sourceParseReports,
        ledger.outcomes,
        validationDiagnostics.length > 0,
    );
    const readSnapshotFingerprint = computeReadSnapshotFingerprint(
        target,
        preparation.readAuthorityFingerprint,
        preparation.obligations,
        ledger.entries,
        [],
        rewritten.sourceParseReports,
    );
    const result: AdapterReadResult = {
        status: aggregateReadStatus(sourceReports),
        readTarget: structuredClone(target),
        readAuthorityFingerprint: preparation.readAuthorityFingerprint,
        readSnapshotFingerprint,
        sourceRoots: preparation.roots,
        sourceReadObligations: preparation.obligations,
        readAccessOutcomes: ledger.outcomes,
        observedReadEntries: ledger.entries,
        externalAttestationReceipts: [],
        sourceParseReports: rewritten.sourceParseReports,
        candidates: rewritten.candidates,
        sourceReports,
        diagnostics: [
            ...providerResult.diagnostics,
            ...rewritten.sourceParseReports.flatMap((report) => report.diagnostics),
            ...validationDiagnostics,
        ],
    };
    const snapshotDiagnostics = validateAdapterReadResultSnapshot(result);
    if (snapshotDiagnostics.length > 0) {
        validationDiagnostics.push(...snapshotDiagnostics);
        result.sourceReports = deriveSourceReports(preparation.roots, rewritten.sourceParseReports, ledger.outcomes, true);
        result.status = aggregateReadStatus(result.sourceReports);
        result.diagnostics = [
            ...providerResult.diagnostics,
            ...rewritten.sourceParseReports.flatMap((report) => report.diagnostics),
            ...validationDiagnostics,
        ];
    }
    return { status: result.status, value: result, diagnostics: result.diagnostics };
}
