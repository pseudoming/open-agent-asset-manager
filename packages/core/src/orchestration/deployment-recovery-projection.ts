/** Compose the ordinary Deployment view with durable reverse-accept recovery facts. */

import type { readDeploymentView } from "../deployment/deployment-view";
import type { ReverseAcceptMarkerStore, ReverseAcceptReservationScanResult } from "../reverse/reverse-accept-marker";
import type { DeploymentStatus, DeploymentView } from "../types";

type DeploymentViewReader = typeof readDeploymentView;

interface DeploymentRecoveryProjectionConfiguration {
    transactionsRoot: string;
    markerStore: ReverseAcceptMarkerStore;
    readBaseView: DeploymentViewReader;
    scanReservations(transactionsRoot: string, markerStore: ReverseAcceptMarkerStore): ReverseAcceptReservationScanResult;
}

/**
 * Bind the reverse reservation authority to every ordinary Core Deployment read.
 *
 * The durable marker remains the sole recovery fact. This reader only projects one
 * of the already-public action hints; it does not persist a second status or expose
 * marker identities through the public contract.
 */
export function createDeploymentRecoveryViewReader(
    configuration: DeploymentRecoveryProjectionConfiguration,
): DeploymentViewReader {
    return (input) => {
        if (input.transactionsRoot !== configuration.transactionsRoot) {
            throw new Error("Deployment recovery projection received a foreign transactions root");
        }
        const view = configuration.readBaseView(input);
        if (view === null) return null;
        let reservations: ReverseAcceptReservationScanResult;
        try {
            reservations = configuration.scanReservations(configuration.transactionsRoot, configuration.markerStore);
        } catch {
            // An unreadable or internally contradictory reservation inventory is
            // equivalent to the scanner's global freeze. A normal Deployment view
            // remains available, but ordinary mutation must fail closed.
            reservations = {
                globalFreeze: true,
                activePreparations: [],
            };
        }
        return projectDeploymentReverseRecovery(view, reservations);
    };
}

export function projectDeploymentReverseRecovery(
    view: DeploymentView,
    reservations: ReverseAcceptReservationScanResult,
): DeploymentView {
    if (view.deleted) return view;
    if (reservations.globalFreeze) {
        return withStatus(view, {
            stage: "blocked",
            reason: "blocked_needs_support",
            diagnostics: [],
            observationWarnings: [],
            actionHints: ["contact_support"],
        });
    }
    const exactRecovery = reservations.activePreparations.some((identity) => identity.deploymentId === view.deploymentId);
    if (!exactRecovery || view.derivedStatus.actionHints.includes("contact_support")) {
        return view;
    }
    return withStatus(view, {
        stage: "blocked",
        reason: "blocked_by_recovery_state_unavailable",
        diagnostics: [],
        observationWarnings: [],
        actionHints: ["recover"],
    });
}

function withStatus(view: DeploymentView, derivedStatus: DeploymentStatus): DeploymentView {
    return {
        ...view,
        derivedStatus,
    };
}
