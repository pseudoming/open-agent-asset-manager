/** Runtime-neutral deep-freeze mechanics with explicit observable traversal order. */

/** Freeze the parent before reading and recursively freezing its enumerable children. */
export function deepFreezeParentFirst<T>(value: T): T {
    if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreezeParentFirst(child);
    return value;
}

/** Read and recursively freeze enumerable children before freezing the parent. */
export function deepFreezeChildrenFirst<T>(value: T): T {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
        for (const child of Object.values(value as Record<string, unknown>)) {
            deepFreezeChildrenFirst(child);
        }
        Object.freeze(value);
    }
    return value;
}
