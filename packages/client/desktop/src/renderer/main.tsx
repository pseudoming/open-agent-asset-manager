import { createClientConnection } from "@oaam/client-framework";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { RendererFailureBoundary } from "./app/RendererFailureBoundary";
import { DesktopSession } from "./client";
import { installPackagedAssetLifecycleProofListener } from "./client/packaged-asset-lifecycle-proof";
import { installPackagedDiagnosticsProofListener } from "./client/packaged-diagnostics-proof";
import { installPackagedOnboardingProofListener } from "./client/packaged-onboarding-proof";
import { installPackagedOpenCodeProjectProofListener } from "./client/packaged-opencode-project-proof";
import { installPackagedProjectLifecycleProofListener } from "./client/packaged-project-lifecycle-proof";
import { installPackagedStateResilienceProofListener } from "./client/packaged-state-resilience-proof";
import { installPackagedZcodeTargetProofListener } from "./client/packaged-zcode-target-proof";
import { DesktopPresentationProvider } from "./presentation";
import "./ui/tokens.css";
import "./ui/primitives.css";
import "./project-library.css";
import "./asset-library-navigation.css";
import "./source-library.css";
import "./catalog-search.css";
import "./asset-lifecycle.css";
import "./diagnostics.css";
import "./shell/window-chrome.css";

const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("OAAM Desktop renderer root is missing");

const session = new DesktopSession(window.oaamDesktop, {
    createRequestId: () => globalThis.crypto.randomUUID(),
    createConnection: createClientConnection,
});
installPackagedOnboardingProofListener(window, createClientConnection, () => globalThis.crypto.randomUUID());
installPackagedOpenCodeProjectProofListener(window, createClientConnection, () => globalThis.crypto.randomUUID());
installPackagedZcodeTargetProofListener(window, createClientConnection, () => globalThis.crypto.randomUUID());
installPackagedStateResilienceProofListener(window, window.oaamDesktop, createClientConnection, () =>
    globalThis.crypto.randomUUID(),
);
installPackagedProjectLifecycleProofListener(window, createClientConnection, () => globalThis.crypto.randomUUID());
installPackagedAssetLifecycleProofListener(window, createClientConnection, () => globalThis.crypto.randomUUID());
installPackagedDiagnosticsProofListener(window, window.oaamDesktop, createClientConnection, () => globalThis.crypto.randomUUID());

createRoot(rootElement).render(
    <StrictMode>
        <DesktopPresentationProvider bridge={window.oaamDesktop}>
            <RendererFailureBoundary
                onDiagnostic={(input) => window.oaamDesktop.recordRendererDiagnostic(input)}
                onRecover={() => window.oaamDesktop.performWindowAction("reload_interface")}
            >
                <App session={session} />
            </RendererFailureBoundary>
        </DesktopPresentationProvider>
    </StrictMode>,
);
