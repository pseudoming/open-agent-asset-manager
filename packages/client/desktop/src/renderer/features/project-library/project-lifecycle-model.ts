import type {
    ProtocolDiagnosticV1,
    ProtocolOperationResult,
    ProtocolOperationTerminal,
    ProtocolProjectLifecycleInspectParamsV1,
    ProtocolProjectLifecycleReviewV1,
} from "@oaam/app-server-protocol";
import type { DesktopDisplayText } from "../../presentation";

export type ProjectLifecycleInspectParams = ProtocolProjectLifecycleInspectParamsV1;
export type ProjectLifecycleReview = ProtocolProjectLifecycleReviewV1;
export type ProjectLifecycleProject = Extract<
    ProtocolOperationTerminal<"project_lifecycle.commit">,
    { readonly status: "complete" | "partial" }
>["value"];
export type ProjectLifecycleDeployment = Extract<
    ProtocolOperationResult<"deployment.list">,
    { readonly status: "complete" | "partial" }
>["value"]["deployments"][number];
export type ProjectLifecycleBackupPolicy = Extract<
    ProtocolOperationResult<"state_backup_prompt_policy.get">,
    { readonly status: "complete" | "partial" }
>["value"];
export type ProjectLifecycleBackupEntry = Extract<
    ProtocolOperationResult<"state_backup.list">,
    { readonly status: "complete" | "partial" }
>["value"]["entries"][number];
export type ProjectLifecycleBackupChoice = "back_up_then_continue" | "continue_without_backup";

export interface ProjectLifecycleReviewContext {
    readonly review: ProjectLifecycleReview;
    readonly deployments: readonly ProjectLifecycleDeployment[];
    readonly backupPolicy: ProjectLifecycleBackupPolicy | undefined;
    readonly latestBackup: ProjectLifecycleBackupEntry | undefined;
}

export type ProjectLifecycleFlowState =
    | { readonly status: "idle" }
    | { readonly status: "inspecting"; readonly action: ProjectLifecycleInspectParams["action"] }
    | {
          readonly status: "review";
          readonly context: ProjectLifecycleReviewContext;
          readonly busyStage: "backup" | "policy" | "commit" | undefined;
          readonly message: DesktopDisplayText | undefined;
          readonly diagnostics: readonly ProtocolDiagnosticV1[];
      }
    | {
          readonly status: "failed";
          readonly message: DesktopDisplayText;
          readonly diagnostics: readonly ProtocolDiagnosticV1[];
      }
    | {
          readonly status: "succeeded";
          readonly context: ProjectLifecycleReviewContext;
          readonly project: ProjectLifecycleProject;
      };

export function requiresPreDestructiveBackup(action: ProjectLifecycleReview["action"]): boolean {
    return action === "rebind" || action === "stop_managing";
}

export function latestAvailableLifecycleBackup(
    entries: readonly ProjectLifecycleBackupEntry[],
): ProjectLifecycleBackupEntry | undefined {
    return [...entries]
        .filter((entry) => entry.observation === "available")
        .sort((left, right) => right.createdAt - left.createdAt)[0];
}
