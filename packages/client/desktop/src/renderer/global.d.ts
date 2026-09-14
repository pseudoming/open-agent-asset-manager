import type { OaamDesktopBridge } from "../bridge/desktop-bridge";

declare global {
    interface Window {
        readonly oaamDesktop: OaamDesktopBridge;
    }
}
