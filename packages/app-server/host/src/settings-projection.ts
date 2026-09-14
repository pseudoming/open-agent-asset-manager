import type {
    AdapterEnablementSettingV1,
    AdapterProviderSummary,
    PlatformContext,
    PromotionGrantTarget,
    PromotionGrantV1,
    PromotionGrantViewV1,
    RestrictedSourcePromotionFullAccessSettingV1,
    Sha256Digest,
    UuidV4,
    WatchedScanIntentV1,
} from "@oaam/core";
import { projectDiagnostic, toProtocolSha256 } from "./core-outcome";

function nonEmpty<T>(values: readonly T[], label: string): [T, ...T[]] {
    if (values.length === 0) throw new Error(`${label} must not be empty`);
    return [values[0] as T, ...values.slice(1)];
}

export function projectEnvironment(context: PlatformContext) {
    return {
        environment: {
            platform: context.platform,
            platformInstanceId: context.platformInstanceId,
        },
        displayName: `${context.platform}:${context.platformInstanceId}`,
    };
}

export function projectAdapterProvider(provider: AdapterProviderSummary) {
    return {
        adapterId: provider.adapterId,
        displayName: provider.displayName,
        version: provider.version,
        enabled: provider.enabled,
        agentRuntimes: provider.agentRuntimes.map((agentRuntime) => ({
            agentRuntimeId: agentRuntime.agentRuntimeId,
            displayName: agentRuntime.displayName,
            entryClass: agentRuntime.entryClass,
        })),
        sourceCapabilities: provider.assetSourceCapabilities.map((capability) => ({
            sourceCapabilityFingerprint: toProtocolSha256(capability.sourceCapabilityFingerprint),
            agentRuntimeId: capability.agentRuntimeId,
            assetKind: capability.assetKind,
            entrySupportStatus: capability.entrySupportStatus,
            rootLocatorKind: capability.rootLocatorKind,
            rootRole: capability.rootRole,
            sourceDomain: capability.sourceDomain,
            sourcePathMechanism: capability.sourcePathMechanism,
            evidenceLevel: capability.evidenceLevel,
            readPolicy: capability.readPolicy,
            diagnostics: capability.diagnostics.map(projectDiagnostic),
        })),
        targetCapabilities: provider.assetTargetCapabilities.map((capability) =>
            capability.entrySupportStatus === "supported" || capability.entrySupportStatus === "docs_declared_unverified"
                ? {
                      agentRuntimeId: capability.agentRuntimeId,
                      assetKind: capability.assetKind,
                      entrySupportStatus: capability.entrySupportStatus,
                      renderStrategy: capability.renderStrategy,
                      reverseExtractPolicy: capability.reverseExtractPolicy,
                      diagnostics: capability.diagnostics.map(projectDiagnostic),
                  }
                : {
                      agentRuntimeId: capability.agentRuntimeId,
                      assetKind: capability.assetKind,
                      entrySupportStatus: capability.entrySupportStatus,
                      diagnostics: capability.diagnostics.map(projectDiagnostic),
                  },
        ),
    };
}

export function projectAdapterEnablement(setting: AdapterEnablementSettingV1) {
    return !("userActionEvidenceId" in setting)
        ? {
              configVersion: 1 as const,
              settingId: "adapter_enablement_v1" as const,
              revision: 0 as const,
              enabledAdapterIds: [] as [],
              updatedAt: 0 as const,
              settingFingerprint: toProtocolSha256(setting.settingFingerprint),
          }
        : {
              configVersion: 1 as const,
              settingId: "adapter_enablement_v1" as const,
              revision: setting.revision,
              enabledAdapterIds: [...setting.enabledAdapterIds],
              userActionEvidenceId: setting.userActionEvidenceId,
              updatedAt: setting.updatedAt,
              settingFingerprint: toProtocolSha256(setting.settingFingerprint),
          };
}

function projectWatchedSource(source: WatchedScanIntentV1["environments"][number]["sourceSelectors"][number]["source"]) {
    return {
        adapterId: source.adapterId,
        rootRole: source.rootRole,
        sourceDomain: source.sourceDomain,
        canonicalPath: source.canonicalPath,
        locatorIdentities: nonEmpty(
            source.locatorIdentities.map((identity) => ({
                locatorKind: identity.locatorKind,
                locatorKey: identity.locatorKey,
            })),
            "watched source locator identities",
        ),
    };
}

export function projectWatchedScanIntent(setting: WatchedScanIntentV1) {
    if (!("userActionEvidenceId" in setting)) {
        return {
            configVersion: 1 as const,
            settingId: "watched_scan_intent_v1" as const,
            revision: 0 as const,
            environments: [] as [],
            updatedAt: 0 as const,
            settingFingerprint: toProtocolSha256(setting.settingFingerprint),
        };
    }
    return {
        configVersion: 1 as const,
        settingId: "watched_scan_intent_v1" as const,
        revision: setting.revision,
        environments: setting.environments.map((environment) => ({
            environment: { ...environment.environment },
            sourceSelectors: nonEmpty(
                environment.sourceSelectors.map((selector) =>
                    selector.disposition === "excluded"
                        ? {
                              disposition: "excluded" as const,
                              source: projectWatchedSource(selector.source),
                              agentRuntimeIds: nonEmpty(selector.agentRuntimeIds, "watched source agent runtime ids"),
                              selectorFingerprint: toProtocolSha256(selector.selectorFingerprint),
                          }
                        : {
                              disposition: "included" as const,
                              source: projectWatchedSource(selector.source),
                              agentRuntimeIds: nonEmpty(selector.agentRuntimeIds, "watched source agent runtime ids"),
                              binding: { ...selector.binding },
                              selectorFingerprint: toProtocolSha256(selector.selectorFingerprint),
                          },
                ),
                "watched environment source selectors",
            ),
        })),
        userActionEvidenceId: setting.userActionEvidenceId,
        updatedAt: setting.updatedAt,
        settingFingerprint: toProtocolSha256(setting.settingFingerprint),
    };
}

export function toCorePromotionTarget(target: {
    readonly targetKind: "project" | "global_target";
    readonly projectId?: string;
    readonly targetAuthorityFingerprint?: string;
}): PromotionGrantTarget {
    return target.targetKind === "project"
        ? { targetKind: "project", projectId: target.projectId as UuidV4 }
        : {
              targetKind: "global_target",
              targetAuthorityFingerprint: `sha256:${target.targetAuthorityFingerprint}` as Sha256Digest,
          };
}

export function projectPromotionGrant(grant: PromotionGrantV1) {
    return {
        promotionGrantId: grant.promotionGrantId,
        subject: { ...grant.subject },
        target:
            grant.target.targetKind === "project"
                ? { ...grant.target }
                : {
                      targetKind: "global_target" as const,
                      targetAuthorityFingerprint: toProtocolSha256(grant.target.targetAuthorityFingerprint),
                  },
        grantState: grant.grantState,
        revision: grant.revision,
        updatedAt: grant.updatedAt,
        grantFingerprint: toProtocolSha256(grant.grantFingerprint),
    };
}

export function projectPromotionGrantView(grant: PromotionGrantViewV1) {
    return { ...projectPromotionGrant(grant), targetDescription: { ...grant.targetDescription } };
}

export function projectRestrictedSourceFullAccess(setting: RestrictedSourcePromotionFullAccessSettingV1) {
    return setting.state === "disabled"
        ? {
              configVersion: 1 as const,
              settingId: "restricted_source_promotion_full_access_v1" as const,
              state: "disabled" as const,
              revision: setting.revision,
              updatedAt: setting.updatedAt,
              settingFingerprint: toProtocolSha256(setting.settingFingerprint),
          }
        : {
              configVersion: 1 as const,
              settingId: "restricted_source_promotion_full_access_v1" as const,
              state: "enabled" as const,
              revision: setting.revision,
              userActionEvidenceId: setting.userActionEvidenceId,
              enabledAt: setting.enabledAt,
              settingFingerprint: toProtocolSha256(setting.settingFingerprint),
          };
}
