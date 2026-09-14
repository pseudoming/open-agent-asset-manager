export const ENGLISH_DESKTOP_ASSET_AUTHORIZATION_MESSAGES = {
    "catalog.authorization.saved_versions_required":
        "The saved Versions lack write authorization for this tool location. File preview is blocked.",
    "catalog.authorization.review_saved_versions":
        "Review the saved Versions and their locations in the library. The authorization shortcut supports one current Version in its current Project.",
    "catalog.authorization.check_tools_first":
        "Check the available tools, then select this saved usage to review its authorization.",
    "catalog.authorization.open_asset_usage": "Check tools and review authorization",
    "library.grants.title": "Authorizations",
    "library.grants.intro": "Review this Asset's saved authorizations for a specific Project or global location.",
    "library.grants.loading": "Loading authorizations…",
    "library.grants.empty": "This Asset has no saved authorizations for a specific location.",
    "library.grants.failed": "Authorizations could not be loaded. Try again.",
    "library.grants.all_versions": "All existing and future versions",
    "library.grants.version_unavailable": "Specific version — details unavailable",
    "library.grants.project": "Project",
    "library.grants.global": "Global location",
    "library.grants.target_unavailable": "The location record is unavailable. This authorization can still be revoked.",
    "library.grants.active": "Not revoked",
    "library.grants.revoked": "Revoked",
    "library.grants.updated": "Updated {date}",
    "library.grants.revoke": "Revoke authorization",
    "library.grants.confirm": "Confirm revocation",
    "library.grants.consequence":
        "Future writes cannot use this authorization. Files already deployed stay in place. Other matching authorizations or Full Access may still allow future writes.",
    "library.grants.revoking": "Revoking authorization…",
    "library.grants.revoke_complete": "Authorization revoked. Existing files were preserved.",
    "library.grants.revoke_failed":
        "Revocation was not confirmed. Refresh the list to check the current record before trying again.",
    "library.grants.refresh": "Refresh authorizations",
    "library.grants.technical_id": "Authorization ID: {id}",
    "library.grants.technical_revision": "Authorization revision: {revision}",
} as const;

type Messages = Readonly<Record<keyof typeof ENGLISH_DESKTOP_ASSET_AUTHORIZATION_MESSAGES, string>>;

export const GERMAN_DESKTOP_ASSET_AUTHORIZATION_MESSAGES = {
    "catalog.authorization.saved_versions_required":
        "Den gespeicherten Versionen fehlt die Schreibberechtigung für diesen Werkzeugort. Die Dateivorschau ist gesperrt.",
    "catalog.authorization.review_saved_versions":
        "Prüfen Sie die gespeicherten Versionen und ihre Orte in der Bibliothek. Der direkte Berechtigungsweg unterstützt eine aktuelle Version in ihrem aktuellen Projekt.",
    "catalog.authorization.check_tools_first":
        "Prüfen Sie die verfügbaren Werkzeuge und wählen Sie dann diese gespeicherte Verwendung, um die Berechtigung zu prüfen.",
    "catalog.authorization.open_asset_usage": "Werkzeuge und Berechtigung prüfen",
    "library.grants.title": "Berechtigungen",
    "library.grants.intro":
        "Prüfen Sie die gespeicherten Berechtigungen dieses Assets für ein bestimmtes Projekt oder einen globalen Speicherort.",
    "library.grants.loading": "Berechtigungen werden geladen…",
    "library.grants.empty": "Dieses Asset hat keine gespeicherten Berechtigungen für einen bestimmten Speicherort.",
    "library.grants.failed": "Die Berechtigungen konnten nicht geladen werden. Versuchen Sie es erneut.",
    "library.grants.all_versions": "Alle vorhandenen und zukünftigen Versionen",
    "library.grants.version_unavailable": "Bestimmte Version — Details nicht verfügbar",
    "library.grants.project": "Projekt",
    "library.grants.global": "Globaler Speicherort",
    "library.grants.target_unavailable":
        "Der Speicherorteintrag ist nicht verfügbar. Diese Berechtigung kann weiterhin widerrufen werden.",
    "library.grants.active": "Nicht widerrufen",
    "library.grants.revoked": "Widerrufen",
    "library.grants.updated": "Aktualisiert am {date}",
    "library.grants.revoke": "Berechtigung widerrufen",
    "library.grants.confirm": "Widerruf bestätigen",
    "library.grants.consequence":
        "Zukünftige Schreibvorgänge können diese Berechtigung nicht mehr nutzen. Bereits bereitgestellte Dateien bleiben erhalten. Andere passende Berechtigungen oder Vollzugriff können weitere Schreibvorgänge weiterhin erlauben.",
    "library.grants.revoking": "Berechtigung wird widerrufen…",
    "library.grants.revoke_complete": "Berechtigung widerrufen. Vorhandene Dateien wurden beibehalten.",
    "library.grants.revoke_failed":
        "Der Widerruf wurde nicht bestätigt. Aktualisieren Sie die Liste, um den aktuellen Eintrag vor einem erneuten Versuch zu prüfen.",
    "library.grants.refresh": "Berechtigungen aktualisieren",
    "library.grants.technical_id": "Berechtigungs-ID: {id}",
    "library.grants.technical_revision": "Berechtigungsrevision: {revision}",
} as const satisfies Messages;

export const JAPANESE_DESKTOP_ASSET_AUTHORIZATION_MESSAGES = {
    "catalog.authorization.saved_versions_required":
        "保存済みのバージョンには、このツールの場所への書き込み承認がありません。ファイルのプレビューはできません。",
    "catalog.authorization.review_saved_versions":
        "ライブラリで保存済みのバージョンと場所を確認してください。この承認への近道は、現在のプロジェクト内の単一の現行バージョンに対応しています。",
    "catalog.authorization.check_tools_first": "利用可能なツールを確認し、この保存済みの使用先を選択して承認を確認してください。",
    "catalog.authorization.open_asset_usage": "ツールと承認を確認",
    "library.grants.title": "承認",
    "library.grants.intro": "このアセットについて、特定のプロジェクトまたはグローバルの場所への承認を確認します。",
    "library.grants.loading": "承認を読み込み中…",
    "library.grants.empty": "このアセットには、特定の場所への承認が保存されていません。",
    "library.grants.failed": "承認を読み込めませんでした。再試行してください。",
    "library.grants.all_versions": "既存および今後のすべてのバージョン",
    "library.grants.version_unavailable": "特定のバージョン — 詳細を取得できません",
    "library.grants.project": "プロジェクト",
    "library.grants.global": "グローバルの場所",
    "library.grants.target_unavailable": "場所の記録を取得できません。この承認は取り消せます。",
    "library.grants.active": "取り消されていません",
    "library.grants.revoked": "取り消し済み",
    "library.grants.updated": "更新日時: {date}",
    "library.grants.revoke": "承認を取り消す",
    "library.grants.confirm": "取り消しを確定",
    "library.grants.consequence":
        "今後の書き込みではこの承認を使用できなくなります。配置済みのファイルは残ります。他の該当する承認やフルアクセスにより、今後の書き込みが許可される場合があります。",
    "library.grants.revoking": "承認を取り消し中…",
    "library.grants.revoke_complete": "承認を取り消しました。既存のファイルは保持されています。",
    "library.grants.revoke_failed": "取り消しを確認できませんでした。再試行する前に一覧を更新し、現在の記録を確認してください。",
    "library.grants.refresh": "承認を更新",
    "library.grants.technical_id": "承認 ID: {id}",
    "library.grants.technical_revision": "承認リビジョン: {revision}",
} as const satisfies Messages;

export const SIMPLIFIED_CHINESE_DESKTOP_ASSET_AUTHORIZATION_MESSAGES = {
    "catalog.authorization.saved_versions_required": "保存的版本缺少对这个工具位置的写入授权，暂时不能预览文件。",
    "catalog.authorization.review_saved_versions":
        "请回到资产库查看保存的版本及其位置。此处的授权入口仅支持当前项目内单个资产的当前版本。",
    "catalog.authorization.check_tools_first": "请检查可用工具，再选择这条已有使用记录，查看并确认授权。",
    "catalog.authorization.open_asset_usage": "检查工具并查看授权",
    "library.grants.title": "授权",
    "library.grants.intro": "查看这个资产对特定项目或全局位置的已有授权。",
    "library.grants.loading": "正在读取授权…",
    "library.grants.empty": "这个资产没有针对特定位置保存的授权。",
    "library.grants.failed": "未能读取授权，请重试。",
    "library.grants.all_versions": "全部现有及未来版本",
    "library.grants.version_unavailable": "特定版本 — 暂时无法获取详情",
    "library.grants.project": "项目",
    "library.grants.global": "全局位置",
    "library.grants.target_unavailable": "暂时无法获取位置记录，仍可撤销这项授权。",
    "library.grants.active": "未撤销",
    "library.grants.revoked": "已撤销",
    "library.grants.updated": "更新于 {date}",
    "library.grants.revoke": "撤销授权",
    "library.grants.confirm": "确认撤销",
    "library.grants.consequence":
        "后续写入将不能使用这项授权。已部署的文件会保留。其他匹配的授权或完全访问设置仍可能允许后续写入。",
    "library.grants.revoking": "正在撤销授权…",
    "library.grants.revoke_complete": "授权已撤销，现有文件已保留。",
    "library.grants.revoke_failed": "未能确认撤销结果。请刷新列表，核对当前记录后再操作。",
    "library.grants.refresh": "刷新授权",
    "library.grants.technical_id": "授权 ID：{id}",
    "library.grants.technical_revision": "授权修订号：{revision}",
} as const satisfies Messages;
