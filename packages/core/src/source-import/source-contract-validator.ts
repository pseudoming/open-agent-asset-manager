/** Stable source-read authority facade. */

export type { AdapterReadAuthorityContext } from "./source-read-execution";
export {
    executeAdapterReadWithAuthority,
    executeAdapterReadWithAuthorityForTest,
} from "./source-read-execution";
export { computeReadAuthorityFingerprint } from "./source-read-preparation";
export {
    computeReadSnapshotFingerprint,
    validateAdapterReadResultSnapshot,
} from "./source-read-snapshot-validator";
