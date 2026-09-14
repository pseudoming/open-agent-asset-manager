export interface DesktopEnvironmentIdentity {
    readonly platform: string;
    readonly platformInstanceId: string;
}

export function desktopEnvironmentKey(environment: DesktopEnvironmentIdentity): string {
    return `${environment.platform}\0${environment.platformInstanceId}`;
}
