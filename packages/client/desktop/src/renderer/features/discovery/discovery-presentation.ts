import { type DesktopDisplayText, type DesktopMessageId, localizedText, technicalText } from "../../presentation";
import type { DesktopIconName, WorkbenchBadgeTone } from "../../ui";
import type {
    AdapterProviderView,
    DiscoverySourceClaimKind,
    DiscoverySourceStatus,
    EnvironmentListView,
} from "./discovery-model";

export interface DiscoveryToolPresentation {
    readonly label: DesktopDisplayText;
    readonly technicalIdentity: string;
    readonly known: boolean;
}

export interface DiscoverySourceRelationshipPresentation {
    readonly labelId: DesktopMessageId;
    readonly descriptionId: DesktopMessageId;
    readonly icon: DesktopIconName;
    readonly tone: WorkbenchBadgeTone;
}

type DiscoveryEnvironmentIdentity = EnvironmentListView["environments"][number]["environment"];

export function presentDiscoveryPath(path: string, environment: DiscoveryEnvironmentIdentity): string {
    if (environment.platform !== "wsl") return path;
    const match = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(?:\\(.*))?$/iu.exec(path);
    if (match?.[1]?.toLocaleLowerCase("en-US") !== environment.platformInstanceId.toLocaleLowerCase("en-US")) return path;
    const suffix = match[2];
    return suffix === undefined || suffix.length === 0 ? "/" : `/${suffix.replaceAll("\\", "/")}`;
}

export function presentDiscoveryTool(adapterId: string, providers: readonly AdapterProviderView[]): DiscoveryToolPresentation {
    const provider = providers.find((candidate) => candidate.adapterId === adapterId);
    const displayName = provider?.displayName.trim();
    return Object.freeze({
        label:
            displayName === undefined || displayName === ""
                ? localizedText("discovery.product.tool.unavailable")
                : technicalText(displayName),
        technicalIdentity: adapterId,
        known: provider !== undefined,
    });
}

export function presentDiscoveryAgentRuntime(
    agentRuntimeId: string,
    providers: readonly AdapterProviderView[],
): DiscoveryToolPresentation {
    const descriptor = providers
        .flatMap((provider) => provider.agentRuntimes)
        .find((candidate) => candidate.agentRuntimeId === agentRuntimeId);
    const displayName = descriptor?.displayName.trim();
    return Object.freeze({
        label:
            displayName === undefined || displayName === ""
                ? localizedText("discovery.product.tool.unavailable")
                : technicalText(displayName),
        technicalIdentity: agentRuntimeId,
        known: descriptor !== undefined,
    });
}

export function presentDiscoveryEnvironment(environment: DiscoveryEnvironmentIdentity): DesktopDisplayText {
    switch (environment.platform) {
        case "win32":
            return localizedText("discovery.product.environment.windows");
        case "wsl":
            return localizedText("discovery.product.environment.wsl", {
                distribution: technicalText(environment.platformInstanceId),
            });
        case "darwin":
            return localizedText("discovery.product.environment.mac");
        case "linux":
            return localizedText("discovery.product.environment.linux");
    }
}

export function discoverySourceStatusMessage(status: DiscoverySourceStatus): DesktopMessageId {
    switch (status) {
        case "current":
            return "discovery.ui.status.current";
        case "new":
            return "discovery.ui.status.new";
        case "moved":
            return "discovery.ui.status.moved";
        case "missing":
            return "discovery.ui.status.missing";
        case "not_checked":
            return "discovery.ui.status.not_checked";
    }
}

export function discoverySourceStatusTone(status: DiscoverySourceStatus): WorkbenchBadgeTone {
    switch (status) {
        case "current":
            return "success";
        case "new":
            return "accent";
        case "moved":
            return "warning";
        case "missing":
            return "danger";
        case "not_checked":
            return "neutral";
    }
}

export function discoveryProbeStatusMessage(status: "complete" | "partial" | "failed"): DesktopMessageId {
    switch (status) {
        case "complete":
            return "discovery.product.scan.complete";
        case "partial":
            return "discovery.product.scan.partial";
        case "failed":
            return "discovery.product.scan.failed";
    }
}

export function discoveryProbeStatusTone(status: "complete" | "partial" | "failed"): WorkbenchBadgeTone {
    switch (status) {
        case "complete":
            return "success";
        case "partial":
            return "neutral";
        case "failed":
            return "warning";
    }
}

export function discoveryInstallationStatusMessage(
    status: "available" | "not_found" | "needs_permission" | "version_incompatible" | "unknown",
): DesktopMessageId {
    switch (status) {
        case "available":
            return "discovery.product.installation.available";
        case "not_found":
            return "discovery.product.installation.no_content";
        case "needs_permission":
            return "discovery.product.installation.permission";
        case "version_incompatible":
            return "discovery.product.installation.incompatible";
        case "unknown":
            return "discovery.product.installation.not_checked";
    }
}

export function discoveryInstallationStatusTone(
    status: "available" | "not_found" | "needs_permission" | "version_incompatible" | "unknown",
): WorkbenchBadgeTone {
    switch (status) {
        case "available":
            return "success";
        case "not_found":
        case "unknown":
            return "neutral";
        case "needs_permission":
        case "version_incompatible":
            return "warning";
    }
}

export function discoveryToolOutcomeMessage(
    probeStatus: "complete" | "partial" | "failed",
    installationStatus: "available" | "not_found" | "needs_permission" | "version_incompatible" | "unknown",
): DesktopMessageId {
    return probeStatus === "complete"
        ? discoveryInstallationStatusMessage(installationStatus)
        : discoveryProbeStatusMessage(probeStatus);
}

export function discoveryToolOutcomeTone(
    probeStatus: "complete" | "partial" | "failed",
    installationStatus: "available" | "not_found" | "needs_permission" | "version_incompatible" | "unknown",
): WorkbenchBadgeTone {
    return probeStatus === "complete"
        ? discoveryInstallationStatusTone(installationStatus)
        : discoveryProbeStatusTone(probeStatus);
}

export function presentDiscoverySourceRelationship(claimKind: DiscoverySourceClaimKind): DiscoverySourceRelationshipPresentation {
    switch (claimKind) {
        case "native":
            return Object.freeze({
                labelId: "discovery.product.relationship.native",
                descriptionId: "discovery.product.relationship.native_description",
                icon: "reveal",
                tone: "neutral",
            });
        case "compatible_shared":
            return Object.freeze({
                labelId: "discovery.product.relationship.compatible",
                descriptionId: "discovery.product.relationship.compatible_description",
                icon: "copy",
                tone: "accent",
            });
        case "ambiguous_private":
            return Object.freeze({
                labelId: "discovery.product.relationship.ambiguous",
                descriptionId: "discovery.product.relationship.ambiguous_description",
                icon: "warning",
                tone: "warning",
            });
        case "observed":
            return Object.freeze({
                labelId: "discovery.product.relationship.additional",
                descriptionId: "discovery.product.relationship.additional_description",
                icon: "info",
                tone: "neutral",
            });
    }
}
