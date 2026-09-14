import type { ProtocolDiagnosticV1 } from "@oaam/app-server-protocol";
import type { DesktopApplicationClientApi } from "../../client";
import { type DesktopDisplayText, localizedText, mergeNonInformationalProtocolDiagnostics } from "../../presentation";
import { currentProjectPromotionAuthorization, type DeploymentTargetView } from "./catalog-deployment-model";
import type { CatalogDeploymentState } from "./catalog-deployment-state";
interface CatalogPromotionAuthorizationControllerOptions {
    readonly client: DesktopApplicationClientApi;
    readonly current: () => CatalogDeploymentState;
    readonly transition: (state: CatalogDeploymentState) => void;
    readonly nextOwnerGeneration: () => number;
    readonly isCurrentOwnerGeneration: (generation: number) => boolean;
    readonly busy: () => boolean;
    readonly createUserActionId: () => string;
    readonly start: () => void;
    readonly fail: (message: DesktopDisplayText, diagnostics?: readonly ProtocolDiagnosticV1[]) => void;
    readonly failThrown: (error: unknown) => void;
    readonly reanalyze: (deploymentId: string) => Promise<void>;
}
export class CatalogPromotionAuthorizationController {
    readonly #options: CatalogPromotionAuthorizationControllerOptions;
    public constructor(options: CatalogPromotionAuthorizationControllerOptions) {
        this.#options = options;
    }
    public async authorize(
        identity: { readonly assetId: string; readonly versionId: string; readonly projectId: string },
        deploymentId: string,
        target: DeploymentTargetView,
    ): Promise<void> {
        const state = this.#options.current();
        if (state.status !== "ready" || this.#options.busy()) return;
        const authorization = currentProjectPromotionAuthorization({
            subject: { subjectKind: "project", projectId: identity.projectId },
            target,
            deployment: state.deployments.find((value) => value.deploymentId === deploymentId),
            asset: state.assets.find((value) => value.assetId === identity.assetId),
            analysis: state.analysis.status === "ready" ? state.analysis.value : undefined,
        });
        if (authorization.status === "invalid") {
            this.#options.fail(localizedText("catalog.authorization.target_changed"));
            return;
        }
        if (
            authorization.status !== "required" ||
            authorization.assetId !== identity.assetId ||
            authorization.versionId !== identity.versionId ||
            authorization.projectId !== identity.projectId
        ) {
            return;
        }
        const ownerGeneration = this.#options.nextOwnerGeneration();
        this.#options.start();
        try {
            const result = await this.#options.client.createPromotionGrant({
                promotionAction: "grant_current_version_current_target",
                assetId: identity.assetId,
                versionId: identity.versionId,
                target: { targetKind: "project", projectId: identity.projectId },
                userActionId: this.#options.createUserActionId(),
            });
            const current = this.#options.current();
            if (!this.#options.isCurrentOwnerGeneration(ownerGeneration) || current.status !== "ready") return;
            if (
                result.status === "failed" ||
                result.value.grantState !== "active" ||
                result.value.subject.subjectKind !== "asset_version" ||
                result.value.subject.assetId !== identity.assetId ||
                result.value.subject.versionId !== identity.versionId ||
                result.value.target.targetKind !== "project" ||
                result.value.target.projectId !== identity.projectId
            ) {
                this.#options.fail(
                    localizedText("catalog.authorization.create_failed"),
                    result.status === "failed" ? result.diagnostics : [],
                );
                return;
            }
            this.#options.transition(
                Object.freeze({
                    ...current,
                    activity: Object.freeze({ status: "idle" }),
                    message: undefined,
                    diagnostics: mergeNonInformationalProtocolDiagnostics(current.diagnostics, result.diagnostics),
                }),
            );
            await this.#options.reanalyze(deploymentId);
        } catch (error) {
            if (this.#options.isCurrentOwnerGeneration(ownerGeneration)) this.#options.failThrown(error);
        }
    }
}
