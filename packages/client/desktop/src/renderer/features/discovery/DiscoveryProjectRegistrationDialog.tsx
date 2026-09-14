import type { ProtocolDiagnosticV1 } from "@oaam/app-server-protocol";
import { useRef, useState } from "react";
import type { ObservedProjectRootRevealResult } from "../../../bridge/desktop-bridge";
import { ProtocolDiagnostics, useDesktopPresentation } from "../../presentation";
import { WorkbenchDialog, WorkbenchNotice } from "../../ui";
import type { DiscoveryProjectProposal } from "./discovery-model";

export interface DiscoveryProjectRegistrationDialogProps {
    readonly proposal: DiscoveryProjectProposal;
    readonly busy: boolean;
    readonly errorMessage?: string;
    readonly errorDiagnostics?: readonly ProtocolDiagnosticV1[];
    readonly onClose: () => void;
    readonly onRegister: (displayName: string) => void;
    readonly onReveal: () => Promise<ObservedProjectRootRevealResult>;
}

export function DiscoveryProjectRegistrationDialog({
    proposal,
    busy,
    errorMessage,
    errorDiagnostics = [],
    onClose,
    onRegister,
    onReveal,
}: DiscoveryProjectRegistrationDialogProps): React.JSX.Element {
    const { text } = useDesktopPresentation();
    const [displayName, setDisplayName] = useState(proposal.displayName);
    const [revealState, setRevealState] = useState<"idle" | "opening" | "failed">("idle");
    const nameInput = useRef<HTMLInputElement>(null);

    async function reveal(): Promise<void> {
        if (busy || revealState === "opening") return;
        setRevealState("opening");
        try {
            const result = await onReveal();
            setRevealState(result.status === "complete" ? "idle" : "failed");
        } catch {
            setRevealState("failed");
        }
    }

    const normalizedDisplayName = displayName.trim();
    return (
        <WorkbenchDialog
            data-oaam-interaction-entry="features.discovery.discovery_project_registration_dialog.001"
            className="discovery-project-registration-dialog"
            closeLabel={text("import_journey.projects.dialog.close")}
            dialogId="discovery_project_registration"
            dismissible={!busy}
            initialFocusRef={nameInput}
            title={text("import_journey.projects.dialog.title")}
            onClose={onClose}
        >
            <form
                data-oaam-interaction-entry="features.discovery.discovery_project_registration_dialog.002"
                className="discovery-project-registration-form"
                data-oaam-project-registration-key={proposal.key}
                onSubmit={(event) => {
                    event.preventDefault();
                    if (!busy && normalizedDisplayName !== "") onRegister(normalizedDisplayName);
                }}
            >
                <p>{text("import_journey.projects.dialog.copy")}</p>
                <label>
                    <span>{text("import_journey.projects.dialog.name")}</span>
                    <input
                        data-oaam-interaction-entry="features.discovery.discovery_project_registration_dialog.003"
                        ref={nameInput}
                        autoComplete="off"
                        disabled={busy}
                        maxLength={240}
                        type="text"
                        value={displayName}
                        onChange={(event) => setDisplayName(event.currentTarget.value)}
                    />
                </label>
                <div className="discovery-project-registration-path">
                    <span>{text("import_journey.projects.dialog.path")}</span>
                    <code>{proposal.rootPath}</code>
                    <button
                        data-oaam-interaction-entry="features.discovery.discovery_project_registration_dialog.004"
                        type="button"
                        className="library-secondary-button"
                        data-oaam-project-registration-action="reveal"
                        disabled={busy || revealState === "opening"}
                        onClick={() => void reveal()}
                    >
                        {text(
                            revealState === "opening"
                                ? "import_journey.projects.dialog.revealing"
                                : "import_journey.projects.dialog.reveal",
                        )}
                    </button>
                </div>
                {revealState === "failed" ? (
                    <WorkbenchNotice tone="danger" role="alert">
                        {text("import_journey.projects.dialog.reveal_failed")}
                    </WorkbenchNotice>
                ) : null}
                {errorDiagnostics.length > 0 ? (
                    <div role="alert">
                        <ProtocolDiagnostics diagnostics={errorDiagnostics} layout="grouped" />
                    </div>
                ) : errorMessage === undefined ? null : (
                    <WorkbenchNotice tone="danger" role="alert">
                        {errorMessage}
                    </WorkbenchNotice>
                )}
                <div className="discovery-project-registration-actions">
                    <button
                        data-oaam-interaction-entry="features.discovery.discovery_project_registration_dialog.005"
                        type="button"
                        className="library-secondary-button"
                        disabled={busy}
                        onClick={onClose}
                    >
                        {text("common.cancel")}
                    </button>
                    <button
                        data-oaam-interaction-entry="features.discovery.discovery_project_registration_dialog.006"
                        type="submit"
                        data-oaam-project-registration-action="register"
                        disabled={busy || normalizedDisplayName === ""}
                    >
                        {text(busy ? "import_journey.projects.adding" : "import_journey.projects.dialog.register")}
                    </button>
                </div>
            </form>
        </WorkbenchDialog>
    );
}
