import { createRoot } from "react-dom/client";
import type { OaamDesktopBridge } from "../../../../packages/client/desktop/src/bridge/desktop-bridge";
import { App } from "../../../../packages/client/desktop/src/renderer/app/App";
import { RendererFailureBoundary } from "../../../../packages/client/desktop/src/renderer/app/RendererFailureBoundary";
import type { DesktopSession } from "../../../../packages/client/desktop/src/renderer/client";
import { DesktopPresentationProvider } from "../../../../packages/client/desktop/src/renderer/presentation";
import "../../../../packages/client/desktop/src/renderer/ui/tokens.css";
import "../../../../packages/client/desktop/src/renderer/ui/primitives.css";
import "../../../../packages/client/desktop/src/renderer/styles.css";
import "../../../../packages/client/desktop/src/renderer/project-library.css";
import "../../../../packages/client/desktop/src/renderer/asset-library-navigation.css";
import "../../../../packages/client/desktop/src/renderer/source-library.css";
import "../../../../packages/client/desktop/src/renderer/catalog-search.css";
import "../../../../packages/client/desktop/src/renderer/asset-lifecycle.css";
import "../../../../packages/client/desktop/src/renderer/diagnostics.css";
import "../../../../packages/client/desktop/src/renderer/shell/window-chrome.css";

export function renderActualDesktop(root: HTMLElement, bridge: OaamDesktopBridge, session: DesktopSession): void {
    createRoot(root).render(
        <DesktopPresentationProvider bridge={bridge}>
            <RendererFailureBoundary onRecover={() => bridge.performWindowAction("reload_interface")}>
                <App session={session} />
            </RendererFailureBoundary>
        </DesktopPresentationProvider>,
    );
}
