export const DESKTOP_MAINTENANCE_MESSAGE_IDS = [
    "settings.maintenance.cache.clear",
    "settings.maintenance.cache.complete",
    "settings.maintenance.cache.copy",
    "settings.maintenance.cache.failed",
    "settings.maintenance.cache.title",
    "settings.maintenance.cache.unavailable",
    "settings.maintenance.copy",
    "settings.maintenance.load_failed",
    "settings.maintenance.location.action_failed",
    "settings.maintenance.location.copy_complete",
    "settings.maintenance.location.copy_path",
    "settings.maintenance.location.desktop_profile",
    "settings.maintenance.location.interface_cache",
    "settings.maintenance.location.oaam_data",
    "settings.maintenance.location.open",
    "settings.maintenance.location.open_complete",
    "settings.maintenance.location.ordinary_logs",
    "settings.maintenance.location.state_backups",
    "settings.maintenance.location.unavailable",
    "settings.maintenance.locations.copy",
    "settings.maintenance.locations.move_hint",
    "settings.maintenance.locations.title",
    "settings.maintenance.reset.action",
    "settings.maintenance.reset.complete",
    "settings.maintenance.reset.copy",
    "settings.maintenance.reset.failed",
    "settings.maintenance.reset.partial",
    "settings.maintenance.reset.preserved",
    "settings.maintenance.reset.title",
    "settings.maintenance.title",
] as const;

export type DesktopMaintenanceMessageId = (typeof DESKTOP_MAINTENANCE_MESSAGE_IDS)[number];
type DesktopMaintenanceMessages = Readonly<Record<DesktopMaintenanceMessageId, string>>;

export const ENGLISH_DESKTOP_MAINTENANCE_MESSAGES = {
    "settings.maintenance.cache.clear": "Clear interface cache",
    "settings.maintenance.cache.complete": "The interface cache was cleared.",
    "settings.maintenance.cache.copy":
        "Only the HTTP cache for this OAAM window is cleared. Preferences, local storage, and Assets are untouched.",
    "settings.maintenance.cache.failed": "The interface cache could not be cleared.",
    "settings.maintenance.cache.title": "Interface cache",
    "settings.maintenance.cache.unavailable": "Size unavailable",
    "settings.maintenance.copy":
        "Inspect local application storage, clear the bounded interface cache, or restore presentation defaults.",
    "settings.maintenance.load_failed": "Local maintenance information could not be inspected.",
    "settings.maintenance.location.action_failed": "The selected data-location action failed.",
    "settings.maintenance.location.copy_complete": "The path was copied.",
    "settings.maintenance.location.copy_path": "Copy path",
    "settings.maintenance.location.desktop_profile": "Desktop profile",
    "settings.maintenance.location.interface_cache": "Interface cache",
    "settings.maintenance.location.oaam_data": "OAAM data",
    "settings.maintenance.location.open": "Open",
    "settings.maintenance.location.open_complete": "The location was opened.",
    "settings.maintenance.location.ordinary_logs": "Ordinary logs",
    "settings.maintenance.location.state_backups": "State backups",
    "settings.maintenance.location.unavailable": "Unavailable",
    "settings.maintenance.locations.copy":
        "These paths have different owners. Showing them together does not make them one reset or delete boundary.",
    "settings.maintenance.locations.move_hint":
        "To move OAAM state, create a complete backup and restore it into the selected new data root while mutations are stopped.",
    "settings.maintenance.locations.title": "Data locations",
    "settings.maintenance.reset.action": "Restore interface defaults",
    "settings.maintenance.reset.complete": "Interface defaults were restored.",
    "settings.maintenance.reset.copy":
        "Reset language and theme to System, Asset layout to List, panes to their defaults, and the saved window placement.",
    "settings.maintenance.reset.failed": "Interface defaults could not be restored.",
    "settings.maintenance.reset.partial": "Some interface defaults were restored. Retry to finish the remaining part.",
    "settings.maintenance.reset.preserved":
        "Onboarding, the last selected Project, logs, Assets, backups, and the OAAM data folder are preserved.",
    "settings.maintenance.reset.title": "Interface defaults",
    "settings.maintenance.title": "Local maintenance",
} as const satisfies DesktopMaintenanceMessages;

export const GERMAN_DESKTOP_MAINTENANCE_MESSAGES = {
    "settings.maintenance.cache.clear": "Oberflächen-Cache leeren",
    "settings.maintenance.cache.complete": "Der Oberflächen-Cache wurde geleert.",
    "settings.maintenance.cache.copy":
        "Nur der HTTP-Cache dieses OAAM-Fensters wird geleert. Einstellungen, lokaler Speicher und Assets bleiben unverändert.",
    "settings.maintenance.cache.failed": "Der Oberflächen-Cache konnte nicht geleert werden.",
    "settings.maintenance.cache.title": "Oberflächen-Cache",
    "settings.maintenance.cache.unavailable": "Größe nicht verfügbar",
    "settings.maintenance.copy":
        "Lokale Anwendungsspeicher prüfen, den begrenzten Oberflächen-Cache leeren oder Darstellungsstandards wiederherstellen.",
    "settings.maintenance.load_failed": "Lokale Wartungsinformationen konnten nicht geprüft werden.",
    "settings.maintenance.location.action_failed": "Die ausgewählte Aktion für den Datenort ist fehlgeschlagen.",
    "settings.maintenance.location.copy_complete": "Der Pfad wurde kopiert.",
    "settings.maintenance.location.copy_path": "Pfad kopieren",
    "settings.maintenance.location.desktop_profile": "Desktop-Profil",
    "settings.maintenance.location.interface_cache": "Oberflächen-Cache",
    "settings.maintenance.location.oaam_data": "OAAM-Daten",
    "settings.maintenance.location.open": "Öffnen",
    "settings.maintenance.location.open_complete": "Der Speicherort wurde geöffnet.",
    "settings.maintenance.location.ordinary_logs": "Normale Protokolle",
    "settings.maintenance.location.state_backups": "Zustandssicherungen",
    "settings.maintenance.location.unavailable": "Nicht verfügbar",
    "settings.maintenance.locations.copy":
        "Diese Pfade haben unterschiedliche Eigentümer. Die gemeinsame Anzeige macht sie nicht zu einer gemeinsamen Rücksetz- oder Löschgrenze.",
    "settings.maintenance.locations.move_hint":
        "Zum Verschieben des OAAM-Zustands erstellen Sie eine vollständige Sicherung und stellen sie bei angehaltenen Änderungen im neuen Datenstamm wieder her.",
    "settings.maintenance.locations.title": "Datenspeicherorte",
    "settings.maintenance.reset.action": "Oberflächenstandards wiederherstellen",
    "settings.maintenance.reset.complete": "Die Oberflächenstandards wurden wiederhergestellt.",
    "settings.maintenance.reset.copy":
        "Sprache und Design auf System, Asset-Layout auf Liste, Bereiche auf Standard und die gespeicherte Fensterposition zurücksetzen.",
    "settings.maintenance.reset.failed": "Die Oberflächenstandards konnten nicht wiederhergestellt werden.",
    "settings.maintenance.reset.partial":
        "Einige Oberflächenstandards wurden wiederhergestellt. Wiederholen Sie den Vorgang für den Rest.",
    "settings.maintenance.reset.preserved":
        "Onboarding, zuletzt gewähltes Projekt, Protokolle, Assets, Sicherungen und der OAAM-Datenordner bleiben erhalten.",
    "settings.maintenance.reset.title": "Oberflächenstandards",
    "settings.maintenance.title": "Lokale Wartung",
} as const satisfies DesktopMaintenanceMessages;

export const JAPANESE_DESKTOP_MAINTENANCE_MESSAGES = {
    "settings.maintenance.cache.clear": "インターフェースキャッシュを消去",
    "settings.maintenance.cache.complete": "インターフェースキャッシュを消去しました。",
    "settings.maintenance.cache.copy":
        "この OAAM ウィンドウの HTTP キャッシュだけを消去します。設定、ローカルストレージ、Asset は変更しません。",
    "settings.maintenance.cache.failed": "インターフェースキャッシュを消去できませんでした。",
    "settings.maintenance.cache.title": "インターフェースキャッシュ",
    "settings.maintenance.cache.unavailable": "サイズを取得できません",
    "settings.maintenance.copy":
        "ローカルアプリの保存場所を確認し、限定されたインターフェースキャッシュの消去や表示設定の初期化を行います。",
    "settings.maintenance.load_failed": "ローカル保守情報を確認できませんでした。",
    "settings.maintenance.location.action_failed": "選択したデータ場所の操作に失敗しました。",
    "settings.maintenance.location.copy_complete": "パスをコピーしました。",
    "settings.maintenance.location.copy_path": "パスをコピー",
    "settings.maintenance.location.desktop_profile": "Desktop プロファイル",
    "settings.maintenance.location.interface_cache": "インターフェースキャッシュ",
    "settings.maintenance.location.oaam_data": "OAAM データ",
    "settings.maintenance.location.open": "開く",
    "settings.maintenance.location.open_complete": "場所を開きました。",
    "settings.maintenance.location.ordinary_logs": "通常ログ",
    "settings.maintenance.location.state_backups": "State バックアップ",
    "settings.maintenance.location.unavailable": "利用できません",
    "settings.maintenance.locations.copy":
        "各パスの所有者は異なります。同じ画面に表示しても、共通のリセットまたは削除境界にはなりません。",
    "settings.maintenance.locations.move_hint":
        "OAAM State を移動するには、完全なバックアップを作成し、変更を停止した状態で選択した新しいデータルートへ復元します。",
    "settings.maintenance.locations.title": "データの場所",
    "settings.maintenance.reset.action": "インターフェース設定を初期化",
    "settings.maintenance.reset.complete": "インターフェース設定を初期化しました。",
    "settings.maintenance.reset.copy":
        "言語とテーマをシステム、Asset レイアウトをリスト、ペインを既定値に戻し、保存済みのウィンドウ位置をリセットします。",
    "settings.maintenance.reset.failed": "インターフェース設定を初期化できませんでした。",
    "settings.maintenance.reset.partial": "一部の設定を初期化しました。残りを完了するには再試行してください。",
    "settings.maintenance.reset.preserved":
        "オンボーディング、最後に選択した Project、ログ、Asset、バックアップ、OAAM データフォルダーは保持されます。",
    "settings.maintenance.reset.title": "インターフェース設定",
    "settings.maintenance.title": "ローカル保守",
} as const satisfies DesktopMaintenanceMessages;

export const SIMPLIFIED_CHINESE_DESKTOP_MAINTENANCE_MESSAGES = {
    "settings.maintenance.cache.clear": "清除界面缓存",
    "settings.maintenance.cache.complete": "界面缓存已清除。",
    "settings.maintenance.cache.copy": "只清除当前 OAAM 窗口的 HTTP 缓存；偏好、本地存储与 Asset 均不受影响。",
    "settings.maintenance.cache.failed": "无法清除界面缓存。",
    "settings.maintenance.cache.title": "界面缓存",
    "settings.maintenance.cache.unavailable": "大小不可用",
    "settings.maintenance.copy": "检查本地应用存储、清除有限的界面缓存，或恢复界面默认值。",
    "settings.maintenance.load_failed": "无法检查本地维护信息。",
    "settings.maintenance.location.action_failed": "所选数据位置操作失败。",
    "settings.maintenance.location.copy_complete": "路径已复制。",
    "settings.maintenance.location.copy_path": "复制路径",
    "settings.maintenance.location.desktop_profile": "Desktop 配置",
    "settings.maintenance.location.interface_cache": "界面缓存",
    "settings.maintenance.location.oaam_data": "OAAM 数据",
    "settings.maintenance.location.open": "打开",
    "settings.maintenance.location.open_complete": "位置已打开。",
    "settings.maintenance.location.ordinary_logs": "普通日志",
    "settings.maintenance.location.state_backups": "State 备份",
    "settings.maintenance.location.unavailable": "不可用",
    "settings.maintenance.locations.copy": "这些路径各有不同的拥有者。把它们展示在一起，不代表它们属于同一个重置或删除边界。",
    "settings.maintenance.locations.move_hint":
        "若要移动 OAAM State，请先创建完整备份，再在停止变更期间将其恢复到所选的新数据根目录。",
    "settings.maintenance.locations.title": "数据位置",
    "settings.maintenance.reset.action": "恢复界面默认值",
    "settings.maintenance.reset.complete": "界面默认值已恢复。",
    "settings.maintenance.reset.copy":
        "语言与主题恢复为跟随系统，Asset 布局恢复为列表，面板恢复默认状态，并重置已保存的窗口位置。",
    "settings.maintenance.reset.failed": "无法恢复界面默认值。",
    "settings.maintenance.reset.partial": "部分界面默认值已经恢复；请重试以完成剩余部分。",
    "settings.maintenance.reset.preserved": "引导完成状态、上次选择的 Project、日志、Asset、备份和 OAAM 数据目录都会保留。",
    "settings.maintenance.reset.title": "界面默认值",
    "settings.maintenance.title": "本地维护",
} as const satisfies DesktopMaintenanceMessages;
