import type { PlatformContext } from "../types";

export function sameProbePlatformContext(left: PlatformContext, right: PlatformContext): boolean {
    return (
        left.platform === right.platform &&
        left.platformInstanceId === right.platformInstanceId &&
        left.accessRootPath === right.accessRootPath
    );
}
