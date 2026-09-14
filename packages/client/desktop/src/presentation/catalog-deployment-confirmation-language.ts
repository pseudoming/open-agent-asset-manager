export const DESKTOP_DEPLOYMENT_CONFIRMATION_MESSAGE_IDS = [
    "catalog.product.replace.title",
    "catalog.product.replace.graph_title",
    "catalog.product.replace.effect",
    "catalog.product.replace.file_scope",
    "catalog.product.replace.directory_scope",
    "catalog.product.replace.confirm",
    "catalog.product.replace.unchanged",
    "catalog.product.overwrite.title",
    "catalog.product.overwrite.graph_title",
    "catalog.product.build_unobserved",
    "catalog.product.overwrite.effect",
] as const;

type DesktopDeploymentConfirmationMessageId = (typeof DESKTOP_DEPLOYMENT_CONFIRMATION_MESSAGE_IDS)[number];
type DesktopDeploymentConfirmationMessages = Readonly<Record<DesktopDeploymentConfirmationMessageId, string>>;

export const ENGLISH_DESKTOP_DEPLOYMENT_CONFIRMATION_MESSAGES = {
    "catalog.product.replace.title": "Replace these files?",
    "catalog.product.replace.file_scope": "Apply this version to the listed files.",
    "catalog.product.replace.directory_scope": "Apply this version to the listed files and these complete folders:",
    "catalog.product.build_unobserved": "Tool version not checked",
    "catalog.product.replace.graph_title": "Apply these file and folder changes?",
    "catalog.product.replace.effect":
        "The selected OAAM version will be applied. Changes made after this preview within the listed complete-file or complete-folder replacement scope will also be overwritten. Confirmation applies only to this preview; Cancel leaves the files unchanged.",
    "catalog.product.replace.confirm": "Confirm replacement",
    "catalog.product.replace.unchanged": "View {count} unchanged entries",
    "catalog.product.overwrite.title": "Restore the reviewed OAAM files?",
    "catalog.product.overwrite.graph_title": "Restore the reviewed OAAM files and folders?",
    "catalog.product.overwrite.effect":
        "The selected OAAM version will be applied. Changes made after this preview within the listed complete-file or complete-folder replacement scope will also be overwritten. Confirmation applies only to this preview; Cancel leaves the files unchanged.",
} as const satisfies DesktopDeploymentConfirmationMessages;

export const GERMAN_DESKTOP_DEPLOYMENT_CONFIRMATION_MESSAGES = {
    "catalog.product.replace.title": "Diese Dateien ersetzen?",
    "catalog.product.replace.file_scope": "Diese Version wird auf die aufgeführten Dateien angewendet.",
    "catalog.product.replace.directory_scope":
        "Diese Version wird auf die aufgeführten Dateien und diese vollständigen Ordner angewendet:",
    "catalog.product.build_unobserved": "Tool-Version nicht geprüft",
    "catalog.product.replace.graph_title": "Diese Datei- und Ordneränderungen anwenden?",
    "catalog.product.replace.effect":
        "Die ausgewählte OAAM-Version wird angewendet. Änderungen nach dieser Vorschau innerhalb der angegebenen vollständig ersetzten Dateien oder Ordner werden ebenfalls überschrieben. Die Bestätigung gilt nur für diese Vorschau. Abbrechen lässt die Dateien unverändert.",
    "catalog.product.replace.confirm": "Ersetzen bestätigen",
    "catalog.product.replace.unchanged": "{count} unveränderte Einträge anzeigen",
    "catalog.product.overwrite.title": "Geprüfte OAAM-Dateien wiederherstellen?",
    "catalog.product.overwrite.graph_title": "Geprüfte OAAM-Dateien und -Ordner wiederherstellen?",
    "catalog.product.overwrite.effect":
        "Die ausgewählte OAAM-Version wird angewendet. Änderungen nach dieser Vorschau innerhalb der angegebenen vollständig ersetzten Dateien oder Ordner werden ebenfalls überschrieben. Die Bestätigung gilt nur für diese Vorschau. Abbrechen lässt die Dateien unverändert.",
} as const satisfies DesktopDeploymentConfirmationMessages;

export const JAPANESE_DESKTOP_DEPLOYMENT_CONFIRMATION_MESSAGES = {
    "catalog.product.replace.title": "これらのファイルを置き換えますか？",
    "catalog.product.replace.file_scope": "表示したファイルにこのバージョンを適用します。",
    "catalog.product.replace.directory_scope": "表示したファイルと次のフォルダー全体に、このバージョンを適用します：",
    "catalog.product.build_unobserved": "ツールのバージョンは未確認",
    "catalog.product.replace.graph_title": "ファイルとフォルダーの変更を適用しますか？",
    "catalog.product.replace.effect":
        "選択した OAAM バージョンを適用します。表示されたファイル全体またはフォルダー全体の置換範囲では、このプレビュー後の変更も上書きされます。確定はこのプレビューにのみ有効です。キャンセルするとファイルは変更されません。",
    "catalog.product.replace.confirm": "置き換えを確定",
    "catalog.product.replace.unchanged": "変更しない {count} 件を表示",
    "catalog.product.overwrite.title": "確認した OAAM ファイルを復元しますか？",
    "catalog.product.overwrite.graph_title": "確認した OAAM のファイルとフォルダーを復元しますか？",
    "catalog.product.overwrite.effect":
        "選択した OAAM バージョンを適用します。表示されたファイル全体またはフォルダー全体の置換範囲では、このプレビュー後の変更も上書きされます。確定はこのプレビューにのみ有効です。キャンセルするとファイルは変更されません。",
} as const satisfies DesktopDeploymentConfirmationMessages;

export const SIMPLIFIED_CHINESE_DESKTOP_DEPLOYMENT_CONFIRMATION_MESSAGES = {
    "catalog.product.replace.title": "替换这些文件？",
    "catalog.product.replace.file_scope": "将按下方列出的变更，将此版本应用到所列文件。",
    "catalog.product.replace.directory_scope": "将按下方列出的变更，将此版本应用到所列文件及以下完整目录：",
    "catalog.product.build_unobserved": "尚未检查工具版本",
    "catalog.product.replace.graph_title": "应用这些文件和文件夹变更？",
    "catalog.product.replace.effect":
        "将应用所选 OAAM 版本。标明整文件或整目录替换的范围内，预览后发生的修改也会被覆盖。确认仅对本次预览有效；取消不会修改文件。",
    "catalog.product.replace.confirm": "确认替换",
    "catalog.product.replace.unchanged": "查看 {count} 个内容保持不变的条目",
    "catalog.product.overwrite.title": "恢复已审查的 OAAM 文件？",
    "catalog.product.overwrite.graph_title": "恢复已审查的 OAAM 文件和文件夹？",
    "catalog.product.overwrite.effect":
        "将应用所选 OAAM 版本。标明整文件或整目录替换的范围内，预览后发生的修改也会被覆盖。确认仅对本次预览有效；取消不会修改文件。",
} as const satisfies DesktopDeploymentConfirmationMessages;
