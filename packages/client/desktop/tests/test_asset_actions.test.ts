import type { ProtocolDiagnosticV1 } from "@oaam/app-server-protocol";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    ENGLISH_DESKTOP_ASSET_ACTION_MESSAGES,
    GERMAN_DESKTOP_ASSET_ACTION_MESSAGES,
    JAPANESE_DESKTOP_ASSET_ACTION_MESSAGES,
    SIMPLIFIED_CHINESE_DESKTOP_ASSET_ACTION_MESSAGES,
} from "../src/presentation/catalog-asset-actions";
import type { DesktopApplicationClientApi } from "../src/renderer/client";
import { AssetActions, type AssetActionsProps } from "../src/renderer/features/project-library/AssetActions";
import { ordinarySurfaceText, renderWithPresentation } from "./desktop-presentation-test-harness";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function selectWorkbenchOption(label: string, option: string): void {
    fireEvent.click(screen.getByRole("combobox", { name: label }));
    fireEvent.click(screen.getByRole("option", { name: option }));
}

const PROJECT = {
    projectId: PROJECT_ID,
    displayName: "OAAM",
    rootPath: "/work/oaam",
    deleted: false,
    createdAt: 1,
    updatedAt: 2,
};

const ASSET = {
    assetId: ASSET_ID,
    kind: "Guidance" as const,
    scope: "project" as const,
    projectId: PROJECT_ID,
    scopePath: "",
    displayName: "Project guidance",
    displayDescription: "Project rules",
    versionIds: [VERSION_ID],
    deleted: false,
    createdAt: 1,
    updatedAt: 2,
};

const VERSION = {
    assetId: ASSET_ID,
    versionId: VERSION_ID,
    revision: 1,
    status: "complete" as const,
    fingerprint: DIGEST_A,
    originAuthorityFingerprint: DIGEST_B,
    versionCanonicalContentFingerprint: DIGEST_A,
    changeKind: "create" as const,
    sourceVersionId: "",
    sourceDeploymentId: "",
    changeNote: "",
    fileCount: 1,
    createdAt: 2,
};

const PURGE_PREPARATION = {
    schemaVersion: 1 as const,
    action: "purge" as const,
    assetId: ASSET_ID,
    assetManifestFingerprint: DIGEST_A,
    assetDirectoryIdentityFingerprint: DIGEST_B,
    kind: "Guidance" as const,
    scope: "project" as const,
    projectId: PROJECT_ID,
    scopePath: "",
    displayName: ASSET.displayName,
    versionCount: 3,
    promotionGrantCount: 2,
};

const BACKUP_POLICY = {
    configVersion: 1 as const,
    settingId: "state_backup_prompt_policy_v1" as const,
    revision: 4,
    mode: "ask_every_time" as const,
    updatedAt: 10,
    settingFingerprint: DIGEST_A,
};

const BACKUP = {
    schemaVersion: 1 as const,
    backupId: "44444444-4444-4444-8444-444444444444",
    createdAt: 10,
    archiveDisplayPath: "/home/user/.oaam/backups/oaam.zip",
    archiveByteSize: 1_024,
    archiveContentHash: DIGEST_A,
    manifestFingerprint: DIGEST_B,
    sourceSnapshotFingerprint: DIGEST_A,
    encryptionMode: "none" as const,
    destinationKind: "oaam_default" as const,
    observation: "available" as const,
};

function complete<T>(value: T) {
    return { status: "complete" as const, value, diagnostics: [] };
}

function failed(message: string, operation: ProtocolDiagnosticV1["operation"] = "asset") {
    return {
        status: "failed" as const,
        diagnostics: [
            {
                severity: "error" as const,
                code: "asset.action_failed",
                operation,
                causeKind: "internal_error" as const,
                retryable: true,
                suggestedActions: ["retry"],
                message,
            },
        ],
    };
}

function fakeClient(overrides: Partial<DesktopApplicationClientApi> = {}): DesktopApplicationClientApi {
    return {
        updateAssetDisplay: vi.fn(async ({ displayName, displayDescription }) =>
            complete({ ...ASSET, displayName, displayDescription, updatedAt: 3 }),
        ),
        copyAsset: vi.fn(async ({ source, destination, displayName, displayDescription }) =>
            complete({
                source,
                asset: {
                    ...ASSET,
                    assetId: "55555555-5555-4555-8555-555555555555",
                    projectId: undefined,
                    ...destination,
                    versionIds: ["66666666-6666-4666-8666-666666666666"],
                    displayName,
                    displayDescription,
                },
                version: {
                    ...VERSION,
                    assetId: "55555555-5555-4555-8555-555555555555",
                    versionId: "66666666-6666-4666-8666-666666666666",
                },
            }),
        ),
        softDeleteAsset: vi.fn(async () => complete({ ...ASSET, deleted: true, updatedAt: 3 })),
        restoreAsset: vi.fn(async () => complete({ ...ASSET, deleted: false, updatedAt: 4 })),
        inspectAssetPurge: vi.fn(async () => complete(PURGE_PREPARATION)),
        getStateBackupPromptPolicy: vi.fn(async () => complete(BACKUP_POLICY)),
        listStateBackups: vi.fn(async () =>
            complete({
                schemaVersion: 1 as const,
                entries: [
                    { ...BACKUP, backupId: "77777777-7777-4777-8777-777777777777", createdAt: 5 },
                    BACKUP,
                    {
                        ...BACKUP,
                        backupId: "88888888-8888-4888-8888-888888888888",
                        createdAt: 20,
                        observation: "missing" as const,
                    },
                ],
                totalKnownArchiveBytes: BACKUP.archiveByteSize * 3,
                totalAvailableArchiveBytes: BACKUP.archiveByteSize * 2,
            }),
        ),
        replaceStateBackupPromptPolicy: vi.fn(async ({ mode }) =>
            complete({ ...BACKUP_POLICY, revision: 5, mode, updatedAt: 11, settingFingerprint: DIGEST_B }),
        ),
        inspectStateBackup: vi.fn(async () =>
            complete({
                backupReviewToken: "backup-review-token",
                backupId: BACKUP.backupId,
                createdAt: 12,
                destinationKind: "oaam_default" as const,
                destinationDisplayPath: "/home/user/.oaam/backups",
                destinationState: "ready" as const,
                outputFileName: "oaam-backup.zip",
                encryptionMode: "none" as const,
                sourceFileCount: 3,
                sourceLogicalBytes: 2_048,
                requiredAvailableBytes: 4_096,
                availableBytes: 8_192,
                sourceSnapshotFingerprint: DIGEST_A,
            }),
        ),
        createStateBackup: vi.fn(async () =>
            complete({
                schemaVersion: 1 as const,
                backupId: BACKUP.backupId,
                createdAt: 12,
                archiveDisplayPath: BACKUP.archiveDisplayPath,
                archiveByteSize: BACKUP.archiveByteSize,
                archiveContentHash: DIGEST_A,
                manifestFingerprint: DIGEST_B,
                sourceSnapshotFingerprint: DIGEST_A,
                encryptionMode: "none" as const,
            }),
        ),
        commitAssetPurge: vi.fn(async () => complete({ assetId: ASSET_ID, recycled: true })),
        ...overrides,
    } as unknown as DesktopApplicationClientApi;
}

function renderActions(
    client: DesktopApplicationClientApi,
    asset: AssetActionsProps["asset"] = ASSET,
    overrides: Partial<
        Pick<AssetActionsProps, "onAssetChanged" | "onCopyCreated" | "onOpenCopy" | "onPurged" | "selectedVersion">
    > = {},
) {
    const callbacks = {
        onAssetChanged: vi.fn(),
        onCopyCreated: vi.fn(),
        onPurged: vi.fn(),
        ...overrides,
    };
    const view = renderWithPresentation(
        createElement(AssetActions, {
            client,
            asset,
            selectedVersion: VERSION,
            projects: [PROJECT],
            ...callbacks,
        }),
    );
    return { ...callbacks, ...view };
}

async function openPurge(client: DesktopApplicationClientApi): Promise<void> {
    renderActions(client, { ...ASSET, deleted: true });
    fireEvent.click(screen.getByRole("button", { name: "Permanent purge" }));
    await vi.waitFor(() => expect(client.inspectAssetPurge).toHaveBeenCalledWith({ assetId: ASSET_ID }));
}

function typePurgeName(): void {
    fireEvent.change(screen.getByLabelText(/Type the exact Asset display name/u), {
        target: { value: ASSET.displayName },
    });
}

afterEach(cleanup);

describe("AssetActions", () => {
    it.each([
        ["English", ENGLISH_DESKTOP_ASSET_ACTION_MESSAGES, "Project folders"],
        ["German", GERMAN_DESKTOP_ASSET_ACTION_MESSAGES, "Projekt"],
        ["Japanese", JAPANESE_DESKTOP_ASSET_ACTION_MESSAGES, "プロジェクト"],
        ["Simplified Chinese", SIMPLIFIED_CHINESE_DESKTOP_ASSET_ACTION_MESSAGES, "项目文件夹"],
    ] as const)("keeps %s delete and purge consequences in ordinary user language", (_locale, messages, scopeLabel) => {
        const consequenceCopy = `${messages["library.delete.copy"]} ${messages["library.purge.copy"]}`;
        expect(consequenceCopy).toContain(scopeLabel);
        expect(consequenceCopy).not.toMatch(/\b(?:runtime|agent[- ]runtime|payloads?)\b|Agent-Runtime|ランタイム|运行时/iu);
        expect(messages["library.purge.backup_remember"]).toMatch(/backup|バックアップ|备份/iu);
        expect(messages["library.purge.backup_remember"]).not.toMatch(/do not ask|nicht mehr fragen|確認しない|不再询问/iu);
    });

    it("edits only display metadata and copies one exact Version without inherited authority", async () => {
        const client = fakeClient();
        const callbacks = renderActions(client);

        fireEvent.click(screen.getByRole("button", { name: "Edit name and description" }));
        fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Renamed guidance" } });
        fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Renamed description" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() =>
            expect(client.updateAssetDisplay).toHaveBeenCalledWith({
                assetId: ASSET_ID,
                displayName: "Renamed guidance",
                displayDescription: "Renamed description",
            }),
        );
        expect(callbacks.onAssetChanged).toHaveBeenCalledWith(
            expect.objectContaining({ displayName: "Renamed guidance", versionIds: [VERSION_ID] }),
        );
        await vi.waitFor(() => expect(screen.queryByLabelText("Display name")).toBeNull());

        fireEvent.click(screen.getByRole("button", { name: "Copy version" }));
        const projectDestination = screen.getByRole("radio", { name: "Projects" }) as HTMLInputElement;
        expect(screen.queryByText(ENGLISH_DESKTOP_ASSET_ACTION_MESSAGES["library.metadata.complete"])).toBeNull();
        const globalDestination = screen.getByRole("radio", { name: "Global" }) as HTMLInputElement;
        expect(projectDestination.checked).toBe(true);
        expect(screen.getByRole("group", { name: "Copy to" })).not.toBeNull();
        fireEvent.click(globalDestination);
        expect(globalDestination.checked).toBe(true);
        fireEvent.click(projectDestination);
        expect(projectDestination.checked).toBe(true);
        expect(screen.getByText("Advanced options").closest("details")?.hasAttribute("open")).toBe(false);
        fireEvent.click(screen.getByText("Advanced options"));
        expect(screen.getByText(/Leave this blank for the Project root/u)).toBeTruthy();
        expect(screen.getByLabelText("Location inside the Project")).toBeTruthy();
        fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Project copy" } });
        fireEvent.click(screen.getByRole("button", { name: "Create copy" }));
        await vi.waitFor(() =>
            expect(client.copyAsset).toHaveBeenCalledWith({
                source: {
                    assetId: ASSET_ID,
                    versionId: VERSION_ID,
                    versionFingerprint: DIGEST_A,
                    originAuthorityFingerprint: DIGEST_B,
                },
                destination: { scope: "project", projectId: PROJECT_ID, scopePath: "" },
                displayName: "Project copy",
                displayDescription: ASSET.displayDescription,
                userActionId: expect.any(String),
            }),
        );
        expect(callbacks.onCopyCreated).toHaveBeenCalledOnce();
    });

    it.each([
        "Cancel",
        "Escape",
    ])("shows the selected source beside the draft and restores focus on %s without copying", (cancel) => {
        const client = fakeClient();
        renderActions(client, { ...ASSET, versionIds: [VERSION_ID, "44444444-4444-4444-8444-444444444444"] });
        const trigger = screen.getByRole("button", { name: "Copy version" });
        fireEvent.click(trigger);
        expect(screen.getByText("Source: Project guidance · Version 1")).not.toBeNull();
        expect(screen.queryByRole("button", { name: "Edit name and description" })).toBeNull();
        expect(screen.getByText(ENGLISH_DESKTOP_ASSET_ACTION_MESSAGES["library.copy.no_authority"])).not.toBeNull();
        if (cancel === "Cancel") fireEvent.click(screen.getByRole("button", { name: cancel }));
        else fireEvent.keyDown(screen.getByLabelText("Display name"), { key: "Escape" });
        expect(screen.queryByText("Source: Project guidance · Version 1")).toBeNull();
        expect(document.activeElement).toBe(trigger);
        expect(client.copyAsset).not.toHaveBeenCalled();
    });

    it("closes an open Project choice before a second Escape cancels the copy draft", () => {
        const client = fakeClient();
        renderActions(client);
        fireEvent.click(screen.getByRole("button", { name: "Copy version" }));
        const project = screen.getByRole("combobox", { name: "Project" });
        fireEvent.click(project);
        fireEvent.keyDown(screen.getByRole("listbox", { name: "Project" }), { key: "Escape" });
        expect(screen.queryByRole("listbox", { name: "Project" })).toBeNull();
        expect(screen.getByText("Source: Project guidance · Version 1")).not.toBeNull();
        expect(document.activeElement).toBe(project);
        fireEvent.keyDown(project, { key: "Escape" });
        expect(screen.queryByText("Source: Project guidance · Version 1")).toBeNull();
        expect(document.activeElement).toBe(screen.getByRole("button", { name: "Copy version" }));
        expect(client.copyAsset).not.toHaveBeenCalled();
    });

    it("opens the returned copy explicitly and keeps its own revision after the source selection changes", async () => {
        const client = fakeClient();
        const original = vi.mocked(client.copyAsset).getMockImplementation();
        if (original === undefined) throw new Error("missing copy fixture");
        let release!: () => void;
        vi.mocked(client.copyAsset).mockImplementation(async (input) => {
            await new Promise<void>((resolve) => {
                release = resolve;
            });
            return original(input);
        });
        const onOpenCopy = vi.fn();
        const props: AssetActionsProps = {
            client,
            asset: ASSET,
            selectedVersion: VERSION,
            projects: [PROJECT],
            onAssetChanged: vi.fn(),
            onCopyCreated: vi.fn(),
            onPurged: vi.fn(),
            onOpenCopy,
        };
        const view = renderWithPresentation(createElement(AssetActions, props));
        fireEvent.click(screen.getByRole("button", { name: "Copy version" }));
        fireEvent.click(screen.getByRole("radio", { name: "Global" }));
        fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Historical copy" } });
        fireEvent.click(screen.getByRole("button", { name: "Create copy" }));
        fireEvent.keyDown(screen.getByLabelText("Display name"), { key: "Escape" });
        expect(screen.getByRole("button", { name: "Create copy" }).hasAttribute("disabled")).toBe(true);
        view.rerender(
            createElement(AssetActions, {
                ...props,
                selectedVersion: { ...VERSION, versionId: "44444444-4444-4444-8444-444444444444", revision: 2 },
            }),
        );
        await act(async () => release());
        expect(client.copyAsset).toHaveBeenCalledWith(
            expect.objectContaining({ source: expect.objectContaining({ versionId: VERSION_ID }) }),
        );
        expect(screen.getByText("Historical copy")).not.toBeNull();
        expect(screen.getByText("Saved in Global · Version 1")).not.toBeNull();
        expect(onOpenCopy).not.toHaveBeenCalled();
        const open = screen.getByRole("button", { name: "Open copy" });
        expect(document.activeElement).toBe(open);
        fireEvent.click(open);
        expect(onOpenCopy).toHaveBeenCalledWith(
            expect.objectContaining({
                asset: expect.objectContaining({ assetId: "55555555-5555-4555-8555-555555555555", scope: "global" }),
                version: expect.objectContaining({ versionId: "66666666-6666-4666-8666-666666666666", revision: 1 }),
            }),
        );
    });

    it("takes a Global source directly to Project selection without a redundant scope choice", async () => {
        const client = fakeClient();
        renderActions(client, { ...ASSET, scope: "global", projectId: undefined });
        fireEvent.click(screen.getByRole("button", { name: "Copy version" }));
        expect(screen.queryByRole("group", { name: "Copy to" })).toBeNull();
        expect(screen.getByRole("combobox", { name: "Project" })).not.toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Create copy" }));
        await vi.waitFor(() => expect(screen.getByText("Saved in OAAM · Version 1")).not.toBeNull());
        expect(client.copyAsset).toHaveBeenCalledWith(
            expect.objectContaining({ destination: { scope: "project", projectId: PROJECT_ID, scopePath: "" } }),
        );
    });

    it("closes unchanged metadata immediately and reviews dirty edits before leaving", async () => {
        const client = fakeClient();
        renderActions(client);

        fireEvent.click(screen.getByRole("button", { name: "Edit name and description" }));
        fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
        expect(screen.queryByLabelText("Display name")).toBeNull();
        expect(client.updateAssetDisplay).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole("button", { name: "Edit name and description" }));
        fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Unsaved guidance" } });
        fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
        expect(screen.getByRole("alert").textContent).toContain("Choose what to do");
        expect(
            screen.getByLabelText("Display name").compareDocumentPosition(screen.getByRole("alert")) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Save", exact: true })).toBeNull();
        expect(screen.queryByRole("button", { name: "Cancel", exact: true })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
        expect(screen.queryByRole("alert")).toBeNull();
        expect((screen.getByLabelText("Display name") as HTMLInputElement).value).toBe("Unsaved guidance");

        fireEvent.click(screen.getByRole("button", { name: "Copy version" }));
        expect(screen.getByRole("alert").textContent).toContain("Choose what to do");
        fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
        await vi.waitFor(() => {
            expect(client.updateAssetDisplay).toHaveBeenCalledWith({
                assetId: ASSET_ID,
                displayName: "Unsaved guidance",
                displayDescription: ASSET.displayDescription,
            });
            expect(screen.getByRole("group", { name: "Copy to" })).toBeTruthy();
            expect((screen.getByRole("radio", { name: "Projects" }) as HTMLInputElement).checked).toBe(true);
        });

        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        fireEvent.click(screen.getByRole("button", { name: "Edit name and description" }));
        fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Discard this" } });
        fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
        fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
        expect(screen.queryByLabelText("Display name")).toBeNull();
        expect(client.updateAssetDisplay).toHaveBeenCalledOnce();
    });

    it("requires an explicit checkbox before soft-delete and exposes restore only for a deleted Asset", async () => {
        const client = fakeClient();
        const callbacks = renderActions(client);

        fireEvent.click(screen.getByRole("button", { name: "Delete" }));
        const deleteButton = screen.getByRole("button", { name: "Move Asset to Deleted" });
        expect((deleteButton as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(screen.getByRole("checkbox", { name: /move from the current list/u }));
        fireEvent.click(deleteButton);
        await vi.waitFor(() => expect(client.softDeleteAsset).toHaveBeenCalledWith({ assetId: ASSET_ID }));
        expect(callbacks.onAssetChanged).toHaveBeenCalledWith(expect.objectContaining({ deleted: true }));

        cleanup();
        const restoreCallbacks = renderActions(client, { ...ASSET, deleted: true });
        fireEvent.click(screen.getByRole("button", { name: "Restore Asset" }));
        await vi.waitFor(() => expect(client.restoreAsset).toHaveBeenCalledWith({ assetId: ASSET_ID }));
        expect(restoreCallbacks.onAssetChanged).toHaveBeenCalledWith(expect.objectContaining({ deleted: false }));
    });

    it("shows the exact purge inventory and preserves the reviewed no-backup choice before commit", async () => {
        const client = fakeClient();
        const callbacks = renderActions(client, { ...ASSET, deleted: true });

        fireEvent.click(screen.getByRole("button", { name: "Permanent purge" }));
        await vi.waitFor(() => expect(screen.queryByText("Exact inventory: 3 Versions and 2 Promotion Grants.")).not.toBeNull());
        expect(screen.getByText(/Latest verified backup/u)).not.toBeNull();
        const purgeWithoutBackup = screen.getByRole("button", { name: "Purge without creating a new backup" });
        expect((purgeWithoutBackup as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByRole("switch", { name: "Remember only my backup choice" }).getAttribute("aria-checked")).toBe("true");
        fireEvent.change(screen.getByLabelText(/Type the exact Asset display name/u), {
            target: { value: ASSET.displayName },
        });
        fireEvent.click(purgeWithoutBackup);

        await vi.waitFor(() =>
            expect(client.replaceStateBackupPromptPolicy).toHaveBeenCalledWith({
                expectedRevision: BACKUP_POLICY.revision,
                expectedSettingFingerprint: BACKUP_POLICY.settingFingerprint,
                mode: "continue_without_prompt",
                userActionId: expect.any(String),
            }),
        );
        expect(client.createStateBackup).not.toHaveBeenCalled();
        expect(client.commitAssetPurge).toHaveBeenCalledWith({
            preparation: PURGE_PREPARATION,
            userActionId: expect.any(String),
        });
        await vi.waitFor(() => expect(callbacks.onPurged).toHaveBeenCalledOnce());
    });

    it("uses exact singular and plural labels for every purge inventory count", async () => {
        const client = fakeClient({
            inspectAssetPurge: vi.fn(async () => complete({ ...PURGE_PREPARATION, versionCount: 1, promotionGrantCount: 1 })),
        });
        renderActions(client, { ...ASSET, deleted: true });

        fireEvent.click(screen.getByRole("button", { name: "Permanent purge" }));

        await vi.waitFor(() => expect(screen.queryByText("Exact inventory: 1 Version and 1 Promotion Grant.")).not.toBeNull());
    });

    it("creates the required backup before purge and preserves the Asset when the purge commit fails", async () => {
        const failedDiagnostic = {
            severity: "error" as const,
            code: "asset.purge.stale",
            operation: "asset" as const,
            causeKind: "conflict" as const,
            retryable: true,
            suggestedActions: ["refresh"],
            message: "The purge inventory changed.",
        };
        const client = fakeClient({
            getStateBackupPromptPolicy: vi.fn(async () => complete({ ...BACKUP_POLICY, mode: "back_up_first" as const })),
            commitAssetPurge: vi.fn(async () => ({ status: "failed", diagnostics: [failedDiagnostic] })),
        });
        const callbacks = renderActions(client, { ...ASSET, deleted: true });

        fireEvent.click(screen.getByRole("button", { name: "Permanent purge" }));
        await vi.waitFor(() => expect(screen.queryByText("Exact inventory: 3 Versions and 2 Promotion Grants.")).not.toBeNull());
        fireEvent.change(screen.getByLabelText(/Type the exact Asset display name/u), {
            target: { value: ASSET.displayName },
        });
        fireEvent.click(screen.getByRole("button", { name: "Create a State backup, then purge" }));

        await vi.waitFor(() =>
            expect(client.inspectStateBackup).toHaveBeenCalledWith({
                destination: { destinationKind: "oaam_default" },
                encryptionMode: "none",
            }),
        );
        expect(client.createStateBackup).toHaveBeenCalledWith({
            backupReviewToken: "backup-review-token",
            userActionId: expect.any(String),
        });
        await vi.waitFor(() =>
            expect(client.commitAssetPurge).toHaveBeenCalledWith({
                preparation: PURGE_PREPARATION,
                userActionId: expect.any(String),
            }),
        );
        expect(callbacks.onPurged).not.toHaveBeenCalled();
        expect(ordinarySurfaceText(callbacks.container)).toContain(
            "OAAM could not confirm that the purge completed. Refresh the review before trying again.",
        );
        expect(ordinarySurfaceText(callbacks.container)).not.toContain(failedDiagnostic.message);
        expect(callbacks.container.textContent).toContain(failedDiagnostic.message);
        expect((screen.getByRole("button", { name: "Create a State backup, then purge" }) as HTMLButtonElement).disabled).toBe(
            true,
        );
        expect((screen.getByLabelText(/Type the exact Asset display name/u) as HTMLInputElement).value).toBe("");
        expect(screen.getByRole("button", { name: "Refresh purge review" })).not.toBeNull();
    });

    it("refreshes a failed purge in place and requires fresh name confirmation without automatically committing", async () => {
        const freshPreparation = { ...PURGE_PREPARATION, assetManifestFingerprint: DIGEST_B, versionCount: 4 };
        const client = fakeClient({
            getStateBackupPromptPolicy: vi.fn(async () =>
                complete({ ...BACKUP_POLICY, mode: "continue_without_prompt" as const }),
            ),
        });
        vi.mocked(client.inspectAssetPurge)
            .mockResolvedValueOnce(complete(PURGE_PREPARATION))
            .mockResolvedValueOnce(failed("Fresh inventory could not be read"))
            .mockResolvedValue(complete(freshPreparation));
        vi.mocked(client.commitAssetPurge).mockResolvedValueOnce(failed("The purge result was not confirmed"));
        const callbacks = renderActions(client, { ...ASSET, deleted: true });
        const control = (suffix: string) => {
            const element = callbacks.container.querySelector<HTMLButtonElement>(
                `[data-oaam-interaction-entry="features.project-library.asset_actions.${suffix}"]`,
            );
            expect(element).not.toBeNull();
            if (element === null) throw new Error(`Missing Asset action ${suffix}`);
            return element;
        };
        const visibleFailure = () => callbacks.container.querySelector('[data-oaam-visible-state="asset_purge_review_required"]');

        fireEvent.click(control("005"));
        await screen.findByText("Exact inventory: 3 Versions and 2 Promotion Grants.");
        typePurgeName();
        fireEvent.click(control("030"));
        await vi.waitFor(() => expect(visibleFailure()).not.toBeNull());
        expect(control("030").disabled).toBe(true);
        expect((screen.getByLabelText(/Type the exact Asset display name/u) as HTMLInputElement).value).toBe("");
        expect(client.commitAssetPurge).toHaveBeenCalledTimes(1);
        expect(client.inspectAssetPurge).toHaveBeenCalledTimes(1);
        typePurgeName();
        fireEvent.click(control("030"));
        expect(control("030").disabled).toBe(true);
        expect(client.commitAssetPurge).toHaveBeenCalledTimes(1);

        fireEvent.click(control("032"));
        await screen.findByText("OAAM could not prepare an exact purge inventory.");
        expect(visibleFailure()).not.toBeNull();
        expect(control("030").disabled).toBe(true);
        expect((screen.getByLabelText(/Type the exact Asset display name/u) as HTMLInputElement).value).toBe("");
        expect(client.commitAssetPurge).toHaveBeenCalledTimes(1);
        fireEvent.click(control("032"));
        await screen.findByText("Exact inventory: 4 Versions and 2 Promotion Grants.");
        expect(visibleFailure()).toBeNull();
        expect(control("030").disabled).toBe(true);
        expect(client.inspectAssetPurge).toHaveBeenNthCalledWith(3, { assetId: ASSET_ID });
        expect(client.commitAssetPurge).toHaveBeenCalledTimes(1);
        typePurgeName();
        fireEvent.click(control("031"));
        expect(screen.queryByLabelText(/Type the exact Asset display name/u)).toBeNull();
        expect(client.commitAssetPurge).toHaveBeenCalledTimes(1);
        expect(callbacks.onPurged).not.toHaveBeenCalled();

        fireEvent.click(control("005"));
        await screen.findByText("Exact inventory: 4 Versions and 2 Promotion Grants.");
        expect(control("030").disabled).toBe(true);
        expect((screen.getByLabelText(/Type the exact Asset display name/u) as HTMLInputElement).value).toBe("");
        typePurgeName();
        fireEvent.click(control("030"));
        await vi.waitFor(() => expect(callbacks.onPurged).toHaveBeenCalledOnce());
        expect(client.commitAssetPurge).toHaveBeenNthCalledWith(2, {
            preparation: freshPreparation,
            userActionId: expect.any(String),
        });
        expect(client.createStateBackup).not.toHaveBeenCalled();
        expect(client.replaceStateBackupPromptPolicy).not.toHaveBeenCalled();
        expect(callbacks.onAssetChanged).not.toHaveBeenCalled();
        expect(callbacks.onCopyCreated).not.toHaveBeenCalled();
    });

    it("keeps metadata, copy, delete and restore failures localized while retaining raw technical evidence", async () => {
        const metadataRejected = fakeClient({
            updateAssetDisplay: vi.fn(async () => failed("Metadata rejected")),
        });
        let view = renderActions(metadataRejected);
        fireEvent.click(screen.getByRole("button", { name: "Edit name and description" }));
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() => expect(screen.getByText("The Asset display metadata could not be saved.")).not.toBeNull());
        expect(ordinarySurfaceText(view.container)).not.toContain("Metadata rejected");
        expect(view.container.textContent).toContain("Metadata rejected");
        cleanup();

        const metadataInterrupted = fakeClient({
            updateAssetDisplay: vi.fn(async () => {
                throw new Error("offline");
            }),
        });
        view = renderActions(metadataInterrupted);
        fireEvent.click(screen.getByRole("button", { name: "Edit name and description" }));
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() => expect(screen.getByText("The Asset display metadata could not be saved.")).not.toBeNull());
        cleanup();

        const copyRejected = fakeClient({
            copyAsset: vi.fn(async () => failed("Copy rejected")),
        });
        view = renderActions(copyRejected);
        fireEvent.click(screen.getByRole("button", { name: "Copy version" }));
        fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Copied description" } });
        fireEvent.click(screen.getByRole("button", { name: "Create copy" }));
        await vi.waitFor(() => expect(screen.getByText("The exact Version could not be copied.")).not.toBeNull());
        expect(ordinarySurfaceText(view.container)).not.toContain("Copy rejected");
        expect(view.container.textContent).toContain("Copy rejected");
        cleanup();

        const copyInterrupted = fakeClient({
            copyAsset: vi.fn(async () => {
                throw new Error("offline");
            }),
        });
        renderActions(copyInterrupted);
        fireEvent.click(screen.getByRole("button", { name: "Copy version" }));
        fireEvent.click(screen.getByRole("button", { name: "Create copy" }));
        await vi.waitFor(() => expect(screen.getByText("The exact Version could not be copied.")).not.toBeNull());
        cleanup();

        const deleteRejected = fakeClient({
            softDeleteAsset: vi.fn(async () => failed("Delete rejected")),
        });
        view = renderActions(deleteRejected);
        fireEvent.click(screen.getByRole("button", { name: "Delete" }));
        fireEvent.click(screen.getByRole("checkbox", { name: /move from the current list/u }));
        fireEvent.click(screen.getByRole("button", { name: "Move Asset to Deleted" }));
        await vi.waitFor(() => expect(screen.getByText("The Asset could not be moved to Deleted.")).not.toBeNull());
        expect(ordinarySurfaceText(view.container)).not.toContain("Delete rejected");
        expect(view.container.textContent).toContain("Delete rejected");
        cleanup();

        const deleteInterrupted = fakeClient({
            softDeleteAsset: vi.fn(async () => {
                throw new Error("offline");
            }),
        });
        renderActions(deleteInterrupted);
        fireEvent.click(screen.getByRole("button", { name: "Delete" }));
        fireEvent.click(screen.getByRole("checkbox", { name: /move from the current list/u }));
        fireEvent.click(screen.getByRole("button", { name: "Move Asset to Deleted" }));
        await vi.waitFor(() => expect(screen.getByText("The Asset could not be moved to Deleted.")).not.toBeNull());
        cleanup();

        const restoreRejected = fakeClient({
            restoreAsset: vi.fn(async () => failed("Restore rejected")),
        });
        view = renderActions(restoreRejected, { ...ASSET, deleted: true });
        fireEvent.click(screen.getByRole("button", { name: "Restore Asset" }));
        await vi.waitFor(() => expect(screen.getByText("The deleted Asset could not be restored.")).not.toBeNull());
        expect(ordinarySurfaceText(view.container)).not.toContain("Restore rejected");
        expect(view.container.textContent).toContain("Restore rejected");
        cleanup();

        const restoreInterrupted = fakeClient({
            restoreAsset: vi.fn(async () => {
                throw new Error("offline");
            }),
        });
        renderActions(restoreInterrupted, { ...ASSET, deleted: true });
        fireEvent.click(screen.getByRole("button", { name: "Restore Asset" }));
        await vi.waitFor(() => expect(screen.getByText("The deleted Asset could not be restored.")).not.toBeNull());
    });

    it("keeps successful action warnings technical and carries purge completion evidence past inspector removal", async () => {
        const warning: ProtocolDiagnosticV1 = {
            severity: "warning",
            code: "asset.action_attention",
            operation: "asset",
            causeKind: "partial",
            retryable: false,
            suggestedActions: ["contact_support"],
            message: "Host-internal warning that must not become product copy.",
            path: "C:/Users/example/.oaam/private",
            traceId: "trace-asset-action",
        };
        const client = fakeClient({
            updateAssetDisplay: vi.fn(async ({ displayName, displayDescription }) => ({
                status: "partial" as const,
                value: { ...ASSET, displayName, displayDescription, updatedAt: 3 },
                diagnostics: [warning],
            })),
        });
        const metadataView = renderActions(client);
        fireEvent.click(screen.getByRole("button", { name: "Edit name and description" }));
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() => expect(screen.getByText("The Asset display metadata was saved.")).not.toBeNull());
        expect(ordinarySurfaceText(metadataView.container)).not.toContain(warning.message);
        expect(ordinarySurfaceText(metadataView.container)).not.toContain(warning.path);
        expect(metadataView.container.textContent).toContain(warning.message);
        cleanup();

        const purgeClient = fakeClient({
            commitAssetPurge: vi.fn(async () => ({
                status: "partial" as const,
                value: { assetId: ASSET_ID, recycled: true },
                diagnostics: [warning],
            })),
        });
        const purgeCallbacks = renderActions(purgeClient, { ...ASSET, deleted: true });
        fireEvent.click(screen.getByRole("button", { name: "Permanent purge" }));
        await vi.waitFor(() => expect(screen.getByText("The exact purge inventory is ready for review.")).not.toBeNull());
        typePurgeName();
        fireEvent.click(screen.getByRole("button", { name: "Purge without creating a new backup" }));
        await vi.waitFor(() =>
            expect(purgeCallbacks.onPurged).toHaveBeenCalledWith(
                expect.objectContaining({
                    tone: "note",
                    diagnostics: [warning],
                }),
            ),
        );
    });

    it("identifies which purge prerequisite failed before exposing destructive authority", async () => {
        for (const [override, message] of [
            [{ inspectAssetPurge: vi.fn(async () => failed("Purge inspection rejected")) }, "Purge inspection rejected"],
            [{ getStateBackupPromptPolicy: vi.fn(async () => failed("Policy rejected", "settings")) }, "Policy rejected"],
            [{ listStateBackups: vi.fn(async () => failed("Backup inventory rejected", "backup")) }, "Backup inventory rejected"],
        ] as const) {
            const client = fakeClient(override);
            const view = renderActions(client, { ...ASSET, deleted: true });
            fireEvent.click(screen.getByRole("button", { name: "Permanent purge" }));
            await vi.waitFor(() => expect(screen.getByText("OAAM could not prepare an exact purge inventory.")).not.toBeNull());
            expect(ordinarySurfaceText(view.container)).not.toContain(message);
            expect(view.container.textContent).toContain(message);
            expect(client.commitAssetPurge).not.toHaveBeenCalled();
            cleanup();
        }

        const interrupted = fakeClient({
            inspectAssetPurge: vi.fn(async () => {
                throw new Error("offline");
            }),
        });
        await openPurge(interrupted);
        await vi.waitFor(() => expect(screen.getByText("OAAM could not prepare an exact purge inventory.")).not.toBeNull());
        expect(interrupted.commitAssetPurge).not.toHaveBeenCalled();
    });

    it("stops purge when backup creation or remembered policy authority fails", async () => {
        const backupInspectRejected = fakeClient({
            getStateBackupPromptPolicy: vi.fn(async () => complete({ ...BACKUP_POLICY, mode: "back_up_first" as const })),
            inspectStateBackup: vi.fn(async () => failed("Backup inspection rejected", "backup")),
        });
        let view = renderActions(backupInspectRejected, { ...ASSET, deleted: true });
        fireEvent.click(screen.getByRole("button", { name: "Permanent purge" }));
        await vi.waitFor(() => expect(screen.getByText("The exact purge inventory is ready for review.")).not.toBeNull());
        typePurgeName();
        fireEvent.click(screen.getByRole("button", { name: "Create a State backup, then purge" }));
        await vi.waitFor(() => expect(screen.getByText("The required State backup could not be created.")).not.toBeNull());
        expect(ordinarySurfaceText(view.container)).not.toContain("Backup inspection rejected");
        expect(view.container.textContent).toContain("Backup inspection rejected");
        expect(backupInspectRejected.commitAssetPurge).not.toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "Refresh purge review" })).not.toBeNull();
        cleanup();

        const backupCreateRejected = fakeClient({
            getStateBackupPromptPolicy: vi.fn(async () => complete({ ...BACKUP_POLICY, mode: "back_up_first" as const })),
            createStateBackup: vi.fn(async () => failed("Backup creation rejected", "backup")),
        });
        view = renderActions(backupCreateRejected, { ...ASSET, deleted: true });
        fireEvent.click(screen.getByRole("button", { name: "Permanent purge" }));
        await vi.waitFor(() => expect(screen.getByText("The exact purge inventory is ready for review.")).not.toBeNull());
        typePurgeName();
        fireEvent.click(screen.getByRole("button", { name: "Create a State backup, then purge" }));
        await vi.waitFor(() => expect(screen.getByText("The required State backup could not be created.")).not.toBeNull());
        expect(ordinarySurfaceText(view.container)).not.toContain("Backup creation rejected");
        expect(view.container.textContent).toContain("Backup creation rejected");
        expect(backupCreateRejected.commitAssetPurge).not.toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "Refresh purge review" })).not.toBeNull();
        cleanup();

        const policyRejected = fakeClient({
            replaceStateBackupPromptPolicy: vi.fn(async () => failed("Policy replacement rejected", "settings")),
        });
        view = renderActions(policyRejected, { ...ASSET, deleted: true });
        fireEvent.click(screen.getByRole("button", { name: "Permanent purge" }));
        await vi.waitFor(() => expect(screen.getByText("The exact purge inventory is ready for review.")).not.toBeNull());
        typePurgeName();
        fireEvent.click(screen.getByRole("button", { name: "Purge without creating a new backup" }));
        await vi.waitFor(() => expect(screen.getByText("The State-backup policy could not be read or saved.")).not.toBeNull());
        expect(ordinarySurfaceText(view.container)).not.toContain("Policy replacement rejected");
        expect(view.container.textContent).toContain("Policy replacement rejected");
        expect(policyRejected.commitAssetPurge).not.toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "Refresh purge review" })).not.toBeNull();
        cleanup();

        const purgeInterrupted = fakeClient({
            getStateBackupPromptPolicy: vi.fn(async () =>
                complete({ ...BACKUP_POLICY, mode: "continue_without_prompt" as const }),
            ),
            commitAssetPurge: vi.fn(async () => {
                throw new Error("offline");
            }),
        });
        await openPurge(purgeInterrupted);
        typePurgeName();
        fireEvent.click(screen.getByRole("button", { name: "Permanently purge from OAAM" }));
        await vi.waitFor(() =>
            expect(
                screen.getByText("OAAM could not confirm that the purge completed. Refresh the review before trying again."),
            ).not.toBeNull(),
        );
    });

    it("keeps every form choice reversible and supports the reviewed backup branch", async () => {
        const client = fakeClient();
        renderActions(client);

        fireEvent.click(screen.getByRole("button", { name: "Edit name and description" }));
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.queryByLabelText("Display name")).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Copy version" }));
        expect((screen.getByRole("radio", { name: "Projects" }) as HTMLInputElement).checked).toBe(true);
        selectWorkbenchOption("Project", PROJECT.displayName);
        fireEvent.click(screen.getByText("Advanced options"));
        fireEvent.change(screen.getByLabelText("Location inside the Project"), { target: { value: "nested" } });
        fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Copy description" } });
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("group", { name: "Copy to" })).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Delete" }));
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("button", { name: "Move Asset to Deleted" })).toBeNull();
        cleanup();

        const purgeCallbacks = renderActions(client, { ...ASSET, deleted: true });
        fireEvent.click(screen.getByRole("button", { name: "Permanent purge" }));
        await vi.waitFor(() => expect(screen.queryByText("Exact inventory: 3 Versions and 2 Promotion Grants.")).not.toBeNull());
        fireEvent.click(screen.getByRole("switch", { name: "Remember only my backup choice" }));
        typePurgeName();
        fireEvent.click(screen.getByRole("button", { name: "Create a State backup, then purge" }));
        await vi.waitFor(() => expect(purgeCallbacks.onPurged).toHaveBeenCalledOnce());

        cleanup();
        renderActions(client, { ...ASSET, deleted: true });
        fireEvent.click(screen.getByRole("button", { name: "Permanent purge" }));
        await vi.waitFor(() => expect(screen.queryByText("Exact inventory: 3 Versions and 2 Promotion Grants.")).not.toBeNull());
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.queryByLabelText(/Type the exact Asset display name/u)).toBeNull();
    });
});
