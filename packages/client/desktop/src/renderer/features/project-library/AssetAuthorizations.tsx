import type { ProtocolDiagnosticV1, ProtocolOperationResult } from "@oaam/app-server-protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopApplicationClientApi } from "../../client";
import { type DesktopMessageId, ProtocolDiagnostics, useDesktopPresentation } from "../../presentation";
import { WorkbenchNotice, WorkbenchTechnicalFact } from "../../ui";
import { projectDisplayName } from "../../presentation/project-label";
import {
    type AdapterProviderView,
    presentDiscoveryAgentRuntime,
    presentDiscoveryEnvironment,
    presentDiscoveryPath,
} from "../discovery";

type Grant = Extract<ProtocolOperationResult<"promotion_grant.list">, { value: unknown }>["value"]["grants"][number];
type Row = { readonly grant: Grant; readonly versionRevision: number | undefined };

export function AssetAuthorizations({
    client,
    assetId,
}: {
    readonly client: DesktopApplicationClientApi;
    readonly assetId: string;
}): React.JSX.Element {
    const { text, snapshot, displayText } = useDesktopPresentation();
    const [providers, setProviders] = useState<readonly AdapterProviderView[]>([]);
    const [rows, setRows] = useState<readonly Row[]>([]);
    const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
    const [diagnostics, setDiagnostics] = useState<readonly ProtocolDiagnosticV1[]>([]);
    const [feedback, setFeedback] = useState<DesktopMessageId>();
    const [confirmation, setConfirmation] = useState<Grant>();
    const [revoking, setRevoking] = useState(false);
    const [refreshRequired, setRefreshRequired] = useState(false);
    const generation = useRef(0);
    const refreshButton = useRef<HTMLButtonElement>(null);
    const cancelButton = useRef<HTMLButtonElement>(null);
    const triggers = useRef(new Map<string, HTMLButtonElement>());
    const [focusRequest, setFocusRequest] = useState<string>();

    const load = useCallback(async (): Promise<boolean> => {
        const current = ++generation.current;
        setStatus("loading");
        setConfirmation(undefined);
        try {
            const result = await client.listPromotionGrants({ assetId });
            if (generation.current !== current) return false;
            setDiagnostics(result.diagnostics);
            if (result.status === "failed") {
                setStatus("failed");
                return false;
            }
            const versions = new Map<string, Promise<number | undefined>>();
            for (const { subject } of result.value.grants) {
                if (subject.subjectKind !== "asset_version" || versions.has(subject.versionId)) continue;
                versions.set(
                    subject.versionId,
                    client
                        .getAssetVersion({ assetId, versionId: subject.versionId })
                        .then((version) =>
                            version.status !== "failed" &&
                            version.value.found &&
                            version.value.value.assetId === assetId &&
                            version.value.value.versionId === subject.versionId
                                ? version.value.value.revision
                                : undefined,
                        )
                        .catch(() => undefined),
                );
            }
            const loaded = await Promise.all(
                result.value.grants.map(async (grant) => ({
                    grant,
                    versionRevision:
                        grant.subject.subjectKind === "asset_version" ? await versions.get(grant.subject.versionId) : undefined,
                })),
            );
            if (generation.current !== current) return false;
            setRows(loaded);
            setStatus("ready");
            setRefreshRequired(false);
            return true;
        } catch {
            if (generation.current === current) {
                setStatus("failed");
                setDiagnostics([]);
            }
            return false;
        }
    }, [client, assetId]);

    useEffect(() => {
        void load();
        return () => {
            ++generation.current;
        };
    }, [load]);

    useEffect(() => {
        let current = true;
        void client
            .listAdapterProviders()
            .then((result) => {
                if (current && result.status !== "failed") setProviders(result.value.providers);
            })
            .catch(() => undefined);
        return () => {
            current = false;
        };
    }, [client]);

    useEffect(() => {
        if (confirmation !== undefined) cancelButton.current?.focus();
    }, [confirmation]);

    useEffect(() => {
        if (focusRequest === undefined || revoking || status === "loading") return;
        const button = focusRequest === "refresh" ? refreshButton.current : triggers.current.get(focusRequest);
        button?.focus();
        setFocusRequest(undefined);
    }, [focusRequest, revoking, status]);

    function cancel(): void {
        setFocusRequest(confirmation?.promotionGrantId);
        setConfirmation(undefined);
    }

    async function revoke(grant: Grant): Promise<void> {
        if (revoking || refreshRequired) return;
        const current = generation.current;
        setRevoking(true);
        setFeedback(undefined);
        try {
            const result = await client.revokePromotionGrant({
                promotionGrantId: grant.promotionGrantId,
                expectedRevision: grant.revision,
                expectedGrantFingerprint: grant.grantFingerprint,
                userActionId: globalThis.crypto.randomUUID(),
            });
            if (generation.current !== current) return;
            setDiagnostics(result.diagnostics);
            setConfirmation(undefined);
            if (
                result.status === "failed" ||
                result.value.promotionGrantId !== grant.promotionGrantId ||
                result.value.grantState !== "revoked"
            ) {
                setRefreshRequired(true);
                setFeedback("library.grants.revoke_failed");
            } else {
                setFeedback("library.grants.revoke_complete");
                await load();
            }
        } catch {
            if (generation.current !== current) return;
            setConfirmation(undefined);
            setRefreshRequired(true);
            setFeedback("library.grants.revoke_failed");
            setDiagnostics([]);
        } finally {
            setRevoking(false);
            setFocusRequest("refresh");
        }
    }

    return (
        <section
            className="asset-inspector-scroll"
            aria-label={text("library.grants.title")}
            data-oaam-asset-authorizations={assetId}
        >
            <div className="inspector-section">
                <p>{text("library.grants.intro")}</p>
                <button
                    ref={refreshButton}
                    type="button"
                    className="library-secondary-button"
                    data-oaam-interaction-entry="features.project-library.asset_authorizations.001"
                    disabled={status === "loading" || revoking}
                    onClick={() => {
                        setFeedback(undefined);
                        void load();
                    }}
                >
                    {text("library.grants.refresh")}
                </button>
                {feedback === undefined ? null : (
                    <WorkbenchNotice role="status" tone={refreshRequired ? "danger" : "note"}>
                        {text(feedback)}
                    </WorkbenchNotice>
                )}
                {status === "loading" ? (
                    <WorkbenchNotice role="status" aria-busy="true">
                        {text("library.grants.loading")}
                    </WorkbenchNotice>
                ) : status === "failed" ? (
                    <WorkbenchNotice tone="danger" role="alert">
                        {text("library.grants.failed")}
                    </WorkbenchNotice>
                ) : rows.length === 0 ? (
                    <p>{text("library.grants.empty")}</p>
                ) : null}
                <ProtocolDiagnostics diagnostics={diagnostics} technicalSummary={text("import.ui.technical_details")} />
            </div>
            {status !== "ready"
                ? null
                : rows.map(({ grant, versionRevision }) => {
                      const description = grant.targetDescription;
                      const selected = confirmation?.promotionGrantId === grant.promotionGrantId;
                      return (
                          <section
                              key={grant.promotionGrantId}
                              className="inspector-section asset-authorization"
                              data-oaam-grant-id={grant.promotionGrantId}
                              data-oaam-grant-state={grant.grantState}
                          >
                              <h3>
                                  {grant.subject.subjectKind === "asset_all_versions"
                                      ? text("library.grants.all_versions")
                                      : versionRevision === undefined
                                        ? text("library.grants.version_unavailable")
                                        : text("library.assets.revision", { revision: versionRevision })}
                              </h3>
                              <p>
                                  <strong>
                                      {text(
                                          grant.target.targetKind === "project"
                                              ? "library.grants.project"
                                              : "library.grants.global",
                                      )}
                                  </strong>
                                  {description.status === "available" && description.targetKind === "project"
                                      ? ` · ${projectDisplayName(description)}`
                                      : ""}
                              </p>
                              {description.status === "unavailable" ? (
                                  <p>{text("library.grants.target_unavailable")}</p>
                              ) : description.targetKind === "project" ? (
                                  <p className="asset-authorization-path">{description.rootPath}</p>
                              ) : (
                                  <>
                                      <p>{displayText(presentDiscoveryEnvironment(description))}</p>
                                      <p className="asset-authorization-path">
                                          {presentDiscoveryPath(description.targetRootPath, description)}
                                      </p>
                                      <p>
                                          {description.consumerAgentRuntimeIds
                                              .map((id) => displayText(presentDiscoveryAgentRuntime(id, providers).label))
                                              .join(" · ")}
                                      </p>
                                  </>
                              )}
                              <WorkbenchTechnicalFact
                                  data-oaam-interaction-entry="features.project-library.asset_authorizations.002"
                                  fact={
                                      <span>
                                          {text(
                                              grant.grantState === "active" ? "library.grants.active" : "library.grants.revoked",
                                          )}
                                      </span>
                                  }
                                  summary={text("import.ui.technical_details")}
                              >
                                  <code>{text("library.grants.technical_id", { id: grant.promotionGrantId })}</code>
                                  <code>{text("library.grants.technical_revision", { revision: grant.revision })}</code>
                                  <code>{grant.grantFingerprint}</code>
                                  <code>
                                      {grant.target.targetKind === "project"
                                          ? grant.target.projectId
                                          : grant.target.targetAuthorityFingerprint}
                                  </code>
                                  <code>
                                      {grant.subject.subjectKind === "asset_version"
                                          ? grant.subject.versionId
                                          : grant.subject.activationVersionId}
                                  </code>
                                  {description.status === "available" && description.targetKind === "global_target" ? (
                                      <code>{description.consumerAgentRuntimeIds.join(", ")}</code>
                                  ) : null}
                              </WorkbenchTechnicalFact>
                              <p>
                                  {text("library.grants.updated", {
                                      date: new Intl.DateTimeFormat(snapshot.resolvedLocale, {
                                          dateStyle: "medium",
                                          timeStyle: "short",
                                      }).format(grant.updatedAt),
                                  })}
                              </p>
                              {grant.grantState !== "active" ? null : selected ? (
                                  <fieldset
                                      className="asset-action-form"
                                      aria-label={text("library.grants.confirm")}
                                      onKeyDown={(event) => {
                                          if (event.key === "Escape" && !revoking) {
                                              event.preventDefault();
                                              event.stopPropagation();
                                              cancel();
                                          }
                                      }}
                                  >
                                      <p>{text("library.grants.consequence")}</p>
                                      <div className="detail-actions">
                                          <button
                                              type="button"
                                              disabled={revoking}
                                              data-oaam-journey-action="promotion_grant.revoke"
                                              data-oaam-interaction-entry="features.project-library.asset_authorizations.003"
                                              onClick={() => void revoke(grant)}
                                          >
                                              {text(revoking ? "library.grants.revoking" : "library.grants.confirm")}
                                          </button>
                                          <button
                                              ref={cancelButton}
                                              type="button"
                                              className="library-secondary-button"
                                              disabled={revoking}
                                              data-oaam-interaction-entry="features.project-library.asset_authorizations.004"
                                              onClick={cancel}
                                          >
                                              {text("common.cancel")}
                                          </button>
                                      </div>
                                  </fieldset>
                              ) : (
                                  <button
                                      type="button"
                                      className="library-secondary-button"
                                      disabled={revoking || refreshRequired}
                                      ref={(button) => {
                                          if (button === null) triggers.current.delete(grant.promotionGrantId);
                                          else triggers.current.set(grant.promotionGrantId, button);
                                      }}
                                      data-oaam-interaction-entry="features.project-library.asset_authorizations.005"
                                      onClick={() => setConfirmation(grant)}
                                  >
                                      {text("library.grants.revoke")}
                                  </button>
                              )}
                          </section>
                      );
                  })}
        </section>
    );
}
