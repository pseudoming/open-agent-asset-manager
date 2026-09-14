/** Immutable in-memory probe facts scoped to one Host review operation. */

import type { ProbeResult } from "@oaam/core";

export class HostProbeOperationSnapshots {
    readonly #snapshots = new Map<string, ReadonlyMap<string, ProbeResult[]>>();

    public record(probeToken: string, rows: readonly { readonly rowId: string }[], results: readonly ProbeResult[]): void {
        if (rows.length !== results.length) throw new TypeError("Host probe operation rows and results disagree");
        const frozenResults = results.map((result) => deepFreezeRecord(result));
        const byContext = new Map<string, ProbeResult[]>();
        for (const result of frozenResults) {
            const context = result.observation.platformContext;
            const key = `${context.platform}\0${context.platformInstanceId}\0${context.accessRootPath}`;
            const group = byContext.get(key) ?? [];
            group.push(result);
            byContext.set(key, group);
        }
        const frozenGroups = new Map(
            [...byContext].map(([key, group]) => [key, Object.freeze(group) as unknown as ProbeResult[]] as const),
        );
        this.#snapshots.set(
            probeToken,
            new Map(
                rows.map((row, index) => {
                    const result = frozenResults[index] as ProbeResult;
                    const context = result.observation.platformContext;
                    const key = `${context.platform}\0${context.platformInstanceId}\0${context.accessRootPath}`;
                    return [row.rowId, frozenGroups.get(key) as ProbeResult[]] as const;
                }),
            ),
        );
    }

    public resolve(probeToken: string, resultRowId: string): ProbeResult[] | undefined {
        return this.#snapshots.get(probeToken)?.get(resultRowId);
    }

    public invalidate(probeToken: string): void {
        this.#snapshots.delete(probeToken);
    }
}

function deepFreezeRecord<T>(value: T): T {
    if (Array.isArray(value)) {
        for (const entry of value) deepFreezeRecord(entry);
        return Object.freeze(value) as T;
    }
    if (typeof value === "object" && value !== null) {
        for (const entry of Object.values(value)) deepFreezeRecord(entry);
        return Object.freeze(value) as T;
    }
    return value;
}
