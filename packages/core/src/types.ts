/**
 * OAAM public type-only barrel.
 *
 * Every contract shape is owned by exactly one file under contracts/. This
 * module intentionally contains no parallel DTO definitions and no runtime
 * values.
 */

export type * from "./contracts/primitives";
export type * from "./contracts/common";
export type * from "./contracts/specs";
export type * from "./contracts/persistence";
export type * from "./contracts/dialect";
export type * from "./contracts/asset-version";
export type * from "./contracts/asset-version-archive";
export type * from "./contracts/asset-library";
export type * from "./contracts/catalog-search";
export type * from "./contracts/asset-version-comparison";
export type * from "./contracts/asset-lifecycle";
export type * from "./contracts/deployment-authority";
export type * from "./contracts/source-import";
export type * from "./contracts/target-build-compatibility";
export type * from "./contracts/render";
export type * from "./contracts/render-preview";
export type * from "./contracts/reverse";
export type * from "./contracts/adapter";
export type * from "./contracts/state-resilience";
export type * from "./contracts/project-lifecycle";
export type * from "./contracts/core-service";
