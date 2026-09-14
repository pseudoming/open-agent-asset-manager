/** Runtime-neutral deterministic text ordering with explicit comparison semantics. */

/**
 * Compare the UTF-8 byte encodings of two strings. This is the authority for
 * persisted/runtime-facing closure order where the existing contract is byte
 * order rather than JavaScript string order.
 */
export function compareUtf8Bytes(left: string, right: string): number {
    return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/**
 * Compare JavaScript strings by UTF-16 code units without locale influence.
 * This remains distinct from UTF-8 byte ordering for canonical JSON and the
 * fingerprints that already consume that exact ordering.
 */
export function compareCodeUnitText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
