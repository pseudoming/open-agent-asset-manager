export const DESKTOP_DEPLOYMENT_OUTCOME_MESSAGE_IDS = [
    "catalog.ui.outcome.asset_version",
    "catalog.ui.outcome.revision",
    "catalog.ui.outcome.selected_version",
    "catalog.ui.outcome.tool_entry",
    "catalog.ui.outcome.files",
    "catalog.ui.outcome.next_action",
    "catalog.ui.outcome.new_version",
    "catalog.ui.outcome.file_count",
    "catalog.ui.outcome.location",
    "catalog.ui.outcome.another_tool",
    "catalog.ui.outcome.selected_version_matches",
    "catalog.ui.outcome.previous_observation",
    "catalog.ui.outcome.recovery_explanation",
    "catalog.ui.outcome.recovered_title",
    "catalog.ui.outcome.reload_saved",
] as const;

type DesktopDeploymentOutcomeMessageId = (typeof DESKTOP_DEPLOYMENT_OUTCOME_MESSAGE_IDS)[number];
type DesktopDeploymentOutcomeMessages = Readonly<Record<DesktopDeploymentOutcomeMessageId, string>>;

export const ENGLISH_DESKTOP_DEPLOYMENT_OUTCOME_MESSAGES = {
    "catalog.ui.outcome.previous_observation": "Last check: {observation}",
    "catalog.ui.outcome.recovery_explanation":
        "A previous file operation needs recovery. OAAM will check its saved state and finish it safely before allowing further changes.",
    "catalog.ui.outcome.recovered_title": "Recovery complete",
    "catalog.ui.outcome.reload_saved": "Reload saved state",
    "catalog.ui.outcome.asset_version": "Asset Version: {version}",
    "catalog.ui.outcome.revision": "Revision {revision}",
    "catalog.ui.outcome.selected_version": "Selected Version",
    "catalog.ui.outcome.tool_entry": "Tool entry: {entry}",
    "catalog.ui.outcome.files": "Files: {files}",
    "catalog.ui.outcome.next_action": "Next: {action}",
    "catalog.ui.outcome.new_version": "New Version",
    "catalog.ui.outcome.file_count": "{count} files",
    "catalog.ui.outcome.location": "Location: {path}",
    "catalog.ui.outcome.another_tool": "Use with another tool",
    "catalog.ui.outcome.selected_version_matches": "Files match the Version selected for this tool.",
} as const satisfies DesktopDeploymentOutcomeMessages;

export const GERMAN_DESKTOP_DEPLOYMENT_OUTCOME_MESSAGES = {
    "catalog.ui.outcome.previous_observation": "Letzte Prüfung: {observation}",
    "catalog.ui.outcome.recovery_explanation":
        "Ein vorheriger Dateivorgang muss wiederhergestellt werden. OAAM prüft den gespeicherten Zustand und schließt den Vorgang sicher ab, bevor weitere Änderungen möglich sind.",
    "catalog.ui.outcome.recovered_title": "Wiederherstellung abgeschlossen",
    "catalog.ui.outcome.reload_saved": "Gespeicherten Zustand neu laden",
    "catalog.ui.outcome.asset_version": "Asset-Version: {version}",
    "catalog.ui.outcome.revision": "Revision {revision}",
    "catalog.ui.outcome.selected_version": "Ausgewählte Version",
    "catalog.ui.outcome.tool_entry": "Tool-Eintrag: {entry}",
    "catalog.ui.outcome.files": "Dateien: {files}",
    "catalog.ui.outcome.next_action": "Nächster Schritt: {action}",
    "catalog.ui.outcome.new_version": "Neue Version",
    "catalog.ui.outcome.file_count": "{count} Dateien",
    "catalog.ui.outcome.location": "Speicherort: {path}",
    "catalog.ui.outcome.another_tool": "Mit einem anderen Tool verwenden",
    "catalog.ui.outcome.selected_version_matches": "Die Dateien entsprechen der für dieses Tool ausgewählten Version.",
} as const satisfies DesktopDeploymentOutcomeMessages;

export const JAPANESE_DESKTOP_DEPLOYMENT_OUTCOME_MESSAGES = {
    "catalog.ui.outcome.previous_observation": "前回の確認: {observation}",
    "catalog.ui.outcome.recovery_explanation":
        "前回のファイル操作には復旧が必要です。保存済みの状態を確認し、安全に完了してから次の変更を許可します。",
    "catalog.ui.outcome.recovered_title": "復旧が完了しました",
    "catalog.ui.outcome.reload_saved": "保存済みの状態を再読み込み",
    "catalog.ui.outcome.asset_version": "Asset Version: {version}",
    "catalog.ui.outcome.revision": "リビジョン {revision}",
    "catalog.ui.outcome.selected_version": "選択中の Version",
    "catalog.ui.outcome.tool_entry": "ツールエントリ: {entry}",
    "catalog.ui.outcome.files": "ファイル: {files}",
    "catalog.ui.outcome.next_action": "次の操作: {action}",
    "catalog.ui.outcome.new_version": "新しいバージョン",
    "catalog.ui.outcome.file_count": "{count} 個のファイル",
    "catalog.ui.outcome.location": "場所: {path}",
    "catalog.ui.outcome.another_tool": "別のツールで使用",
    "catalog.ui.outcome.selected_version_matches": "ファイルは、このツールで選択したバージョンと一致しています。",
} as const satisfies DesktopDeploymentOutcomeMessages;

export const SIMPLIFIED_CHINESE_DESKTOP_DEPLOYMENT_OUTCOME_MESSAGES = {
    "catalog.ui.outcome.previous_observation": "上次检查：{observation}",
    "catalog.ui.outcome.recovery_explanation": "之前的文件操作尚待恢复。OAAM 会核对已保存的状态，安全完成该操作后再允许修改。",
    "catalog.ui.outcome.recovered_title": "恢复完成",
    "catalog.ui.outcome.reload_saved": "重新加载已保存状态",
    "catalog.ui.outcome.asset_version": "资产版本：{version}",
    "catalog.ui.outcome.revision": "第 {revision} 版",
    "catalog.ui.outcome.selected_version": "已选版本",
    "catalog.ui.outcome.tool_entry": "工具入口：{entry}",
    "catalog.ui.outcome.files": "文件：{files}",
    "catalog.ui.outcome.next_action": "下一步：{action}",
    "catalog.ui.outcome.new_version": "新版本",
    "catalog.ui.outcome.file_count": "{count} 个文件",
    "catalog.ui.outcome.location": "位置：{path}",
    "catalog.ui.outcome.another_tool": "用于其他工具",
    "catalog.ui.outcome.selected_version_matches": "文件与此工具所选的版本一致。",
} as const satisfies DesktopDeploymentOutcomeMessages;
