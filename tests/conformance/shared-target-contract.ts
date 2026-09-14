import type { PhysicalFilesystemBackend } from "../../packages/shared/src/filesystem/physical-filesystem-backend";
import type { PathEnvironment } from "../../packages/shared/src/paths/path-environment";
import type * as unixLikeFilesystemSurface from "../../packages/shared/src/paths/unix-like/filesystem-target-entry";
import type * as unixLikePathSurface from "../../packages/shared/src/paths/unix-like/path-environment";
import type * as win32FilesystemSurface from "../../packages/shared/src/paths/win32/filesystem-target-entry";
import type * as win32PathSurface from "../../packages/shared/src/paths/win32/path-environment";

declare const unixLikeFilesystemTarget: typeof unixLikeFilesystemSurface;
declare const win32FilesystemTarget: typeof win32FilesystemSurface;
declare const unixLikePathTarget: typeof unixLikePathSurface;
declare const win32PathTarget: typeof win32PathSurface;

const checkedUnixLikeFilesystem: PhysicalFilesystemBackend = unixLikeFilesystemTarget;
const checkedWin32Filesystem: PhysicalFilesystemBackend = win32FilesystemTarget;
const checkedUnixLikePaths: PathEnvironment = unixLikePathTarget;
const checkedWin32Paths: PathEnvironment = win32PathTarget;

type SameKeys<Left, Right> =
    Exclude<keyof Left, keyof Right> extends never ? (Exclude<keyof Right, keyof Left> extends never ? true : false) : false;
type RequireTrue<Value extends true> = Value;
type FilesystemSurfaceKeysMatch = RequireTrue<SameKeys<typeof unixLikeFilesystemSurface, typeof win32FilesystemSurface>>;
type PathSurfaceKeysMatch = RequireTrue<SameKeys<typeof unixLikePathSurface, typeof win32PathSurface>>;

declare const filesystemWithoutInventory: Omit<PhysicalFilesystemBackend, "inventoryDirectoryNoFollow">;
// @ts-expect-error A physical backend may not omit a required operation.
const rejectedFilesystemBackend: PhysicalFilesystemBackend = filesystemWithoutInventory;

declare const pathEnvironmentWithoutResolveHome: Omit<PathEnvironment, "resolveHome">;
// @ts-expect-error A path environment may not omit a required operation.
const rejectedPathEnvironment: PathEnvironment = pathEnvironmentWithoutResolveHome;

void checkedUnixLikeFilesystem;
void checkedWin32Filesystem;
void checkedUnixLikePaths;
void checkedWin32Paths;
void rejectedFilesystemBackend;
void rejectedPathEnvironment;
void (null as unknown as FilesystemSurfaceKeysMatch);
void (null as unknown as PathSurfaceKeysMatch);
