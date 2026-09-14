/** Owned selected-WSL coordinates over real Unix source files; the wire itself crosses JSON in both directions. */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { createSelectedWslPathProjection } from "@oaam/shared/paths";
import { createRestrictedSourceChannel } from "../../../src/source-import/restricted-source-channel";
import { createRestrictedSourceService } from "../../../src/source-import/restricted-source-service";
import {
    RESTRICTED_SOURCE_MAX_FRAME_BYTES,
    type RestrictedSourceRequest,
    type RestrictedSourceResponse,
} from "../../../src/source-import/restricted-source-protocol";
import { prepareRead } from "../../../src/source-import/source-read-preparation";
import { sourceDiagnostic } from "../../../src/source-import/source-read-validation-helpers";
import type { SelectedWslSourceReadRequest } from "../../../src/orchestration/selected-wsl-source-execution";
import { authority, provider, root, sandbox, sourceFile, target, validRead } from "./source-contract-test-fixtures";

export function sourceWireFixture(
    options: {
        maximumResultBytes?: number;
        explicitAgentRuntimeSelection?: boolean;
        partial?: boolean;
        revalidate?: () => boolean;
        beforeRequest?: (request: RestrictedSourceRequest) => void;
        afterResponse?: (response: RestrictedSourceResponse, request: RestrictedSourceRequest) => void;
        beforeAbort?: () => void;
    } = {},
) {
    const hostRoot = `\\\\wsl.localhost\\read-test${sandbox.replaceAll("/", "\\")}`;
    const projection = createSelectedWslPathProjection("read-test", hostRoot);
    const platformContext = { platform: "wsl" as const, platformInstanceId: "read-test", accessRootPath: hostRoot };
    let providerCalls = 0;
    const malformedSourceFile = `${sandbox}/MALFORMED.md`;
    if (options.partial) fs.writeFileSync(malformedSourceFile, "fixture parser cannot classify this source\n");
    const selected = provider(async (input) => {
        providerCalls++;
        const result = await validRead()(input);
        if (options.partial) {
            const obligation = input.sourceReadObligations.find((item) => item.sourceRootId === "root-2");
            if (obligation === undefined) throw new Error("missing malformed-source obligation");
            const resolved = await input.readAccess.resolveRootEntry(obligation.sourceReadObligationId, obligation.sourceRootId);
            if (resolved.state !== "succeeded") throw new Error("malformed source did not resolve");
            const read = await input.readAccess.readFile(resolved.value.readEntryHandleId);
            if (
                read.state !== "succeeded" ||
                Buffer.from(read.value.bytes).toString("utf8") !== "fixture parser cannot classify this source\n"
            )
                throw new Error("malformed source fixture was not actually read");
            result.sourceParseReports.push({
                sourceRootId: obligation.sourceRootId,
                sourceReadObligationIds: [obligation.sourceReadObligationId],
                status: "malformed_source",
                observedReadEntryIds: [read.value.entry.observedReadEntryId],
                readEntryDispositions: [
                    {
                        readEntryDispositionId: "malformed-disposition",
                        sourceReadObligationId: obligation.sourceReadObligationId,
                        readEntryHandleId: resolved.value.readEntryHandleId,
                        disposition: "parsed",
                        readAccessOutcomeId: read.readAccessOutcomeId,
                        observedReadEntryIds: [read.value.entry.observedReadEntryId],
                        candidateIds: [],
                    },
                ],
                diagnostics: [
                    sourceDiagnostic("read.fixture_malformed_source", "fixture parser could not classify the observed source"),
                ],
            });
        }
        return result;
    });
    const selectedTarget = target([
        root("root-1", projection.toHost(sourceFile)),
        ...(options.partial ? [root("root-2", projection.toHost(malformedSourceFile))] : []),
    ]);
    if (selectedTarget.sourceSelector.selectorKind !== "probe_roots") throw new Error("expected source observation");
    selectedTarget.sourceSelector.observation.platformContext = platformContext;
    selectedTarget.sourceSelector.observation.observedAgentRuntimes[0]!.installationEvidence[0]!.path = projection.toHost(
        `${sandbox}/bin`,
    );
    if (options.explicitAgentRuntimeSelection) {
        const runtime = selected.agentRuntimes[0];
        if (runtime === undefined) throw new Error("Source runtime fixture is missing");
        selectedTarget.agentRuntimeIds = [runtime.agentRuntimeId];
    }
    const hostAuthority = authority();
    const prepared = prepareRead(selected, selectedTarget, hostAuthority);
    if ("diagnostics" in prepared) throw new Error(JSON.stringify(prepared.diagnostics));
    const configuration = {
        hostInstanceId: randomUUID(),
        sessionId: randomUUID(),
        platformContext,
        deadlineAt: Date.now() + 60_000,
        maximumResultBytes: options.maximumResultBytes ?? 256 * 1024 * 1024,
    };
    const service = createRestrictedSourceService({ ...configuration, providers: [selected] });
    const requests: RestrictedSourceRequest[] = [];
    let maximumObservedFrameBytes = 0;
    let aborts = 0;
    const channel = createRestrictedSourceChannel({
        ...configuration,
        async exchange(source) {
            const request = JSON.parse(JSON.stringify(source)) as RestrictedSourceRequest;
            options.beforeRequest?.(request);
            requests.push(request);
            const response = await service.handle(request);
            options.afterResponse?.(response, request);
            const encoded = JSON.stringify(response);
            maximumObservedFrameBytes = Math.max(maximumObservedFrameBytes, Buffer.byteLength(encoded, "utf8"));
            if (maximumObservedFrameBytes > RESTRICTED_SOURCE_MAX_FRAME_BYTES)
                throw new Error("fixture exceeded the real frame limit");
            return JSON.parse(encoded) as unknown;
        },
        async abort() {
            aborts++;
            options.beforeAbort?.();
            service.close();
            await service.settled();
        },
    });
    const readRequest: SelectedWslSourceReadRequest = {
        platformContext,
        target: selectedTarget,
        preparation: prepared,
        authority: hostAuthority,
        revalidateAuthority: options.revalidate ?? (() => true),
    };
    return {
        selected,
        service,
        channel,
        configuration,
        requests,
        readRequest,
        providerCalls: () => providerCalls,
        aborts: () => aborts,
        maximumObservedFrameBytes: () => maximumObservedFrameBytes,
    };
}
