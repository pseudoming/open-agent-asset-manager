/** Trusted App Server composition after Core has selected roots and derived durable source authority. */
import type { ReadAuthorityRevalidator } from "../adapters/adapter-read-access";
import type { AdapterReadAuthorityContext, PreparedRead } from "../source-import/source-read-execution";
import type { AdapterReadResult, AdapterReadTarget, CoreResult, PlatformContext } from "../types";
import { getCanonicalPhysicalAccessPathKind } from "@oaam/shared/paths";
import { sameProbePlatformContext } from "../adapters/probe-context-identity";
import { dispatchReadAssetsWithAuthority } from "./adapter-registry";

export interface SelectedWslSourceReadRequest {
    readonly platformContext: PlatformContext;
    readonly target: AdapterReadTarget;
    readonly preparation: PreparedRead;
    readonly authority: AdapterReadAuthorityContext;
    readonly revalidateAuthority: ReadAuthorityRevalidator;
}
export interface SelectedWslSourceExecution {
    read(request: SelectedWslSourceReadRequest): Promise<CoreResult<AdapterReadResult>>;
}

/** Native reads keep their original dispatch. Only one exact selected Windows-coordinate WSL branch uses this port. */
export function bindSelectedWslSourceExecution(
    contexts: readonly PlatformContext[],
    execution: SelectedWslSourceExecution | undefined,
): typeof dispatchReadAssetsWithAuthority {
    const selected = structuredClone(contexts);
    return (target, authority, revalidateAuthority) => {
        const selector = target.sourceSelector;
        const context = selector.selectorKind === "probe_roots" ? selector.observation.platformContext : selector.platformContext;
        if (context.platform !== "wsl" || getCanonicalPhysicalAccessPathKind(context.accessRootPath) !== "win32")
            return dispatchReadAssetsWithAuthority(target, authority, revalidateAuthority);
        if (!selected.some((candidate) => sameProbePlatformContext(candidate, context)))
            throw new Error("restricted source context is outside this App Server's selected Environments");
        if (execution === undefined) throw new Error("selected WSL source execution is unavailable");
        return dispatchReadAssetsWithAuthority(target, authority, revalidateAuthority, (preparation) =>
            execution.read({
                platformContext: structuredClone(context),
                target: structuredClone(target),
                preparation,
                authority,
                revalidateAuthority,
            }),
        );
    };
}
