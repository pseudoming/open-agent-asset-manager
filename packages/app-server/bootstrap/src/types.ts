export interface HostPlatformContext {
    readonly platform: "win32" | "darwin" | "linux" | "wsl";
    readonly platformInstanceId: string;
    readonly accessRootPath: string;
}

export interface ProductionHostLaunchOptions {
    readonly oaamRoot: string;
    readonly databasePath?: string;
    readonly platformContexts: readonly HostPlatformContext[];
    readonly desktopPreferences?: {
        read(): Promise<Uint8Array | undefined>;
        applyRestored(bytes: Uint8Array, restoreTransactionPath: string): Promise<void>;
    };
    readonly restoreRequiresHostReplacement?: () => void;
}
