import { protocolEnum } from "./validation";

export const PROTOCOL_IMMEDIATE_QUERY_NAMES = Object.freeze([
    "environment.list",
    "adapter_provider.list",
    "adapter_enablement.get",
    "watched_scan_intent.get",
    "probe_environment_reference.list",
    "project.list",
    "project.get",
    "catalog.search",
    "asset.list",
    "asset.get",
    "asset_version.get",
    "asset_library.kind_counts",
    "asset_library.page",
    "asset_version.list",
    "asset_version.file_children",
    "asset_version.file_preview",
    "asset_version.text_page",
    "asset.purge.inspect",
    "deployment.list",
    "deployment.get",
    "promotion_grant.list",
    "restricted_source_full_access.get",
    "state_backup.list",
    "state_backup_prompt_policy.get",
    "diagnostics.health.get",
    "diagnostics.ordinary_log.settings.get",
    "import_preview.detail",
    "rendered_inspection.detail",
] as const);

export const PROTOCOL_IMMEDIATE_MUTATION_NAMES = Object.freeze([
    "adapter_enablement.replace",
    "watched_scan_intent.replace",
    "watched_scan_intent.reset",
    "project.register",
    "asset.display.update",
    "asset.copy",
    "asset.soft_delete",
    "asset.restore",
    "deployment.create",
    "deployment.update_inputs",
    "deployment.soft_delete",
    "promotion_grant.create",
    "promotion_grant.revoke",
    "restricted_source_full_access.set",
    "state_backup_prompt_policy.replace",
    "diagnostics.ordinary_log.settings.replace",
    "diagnostics.ordinary_log.clear",
    "import_preview.cancel",
] as const);

export const PROTOCOL_ACCEPTED_LONG_NAMES = Object.freeze([
    "asset_version.compare",
    "asset_version.export",
    "asset_version.export_native",
    "asset.purge.commit",
    "adapter.probe",
    "adapter.read",
    "import.preview",
    "import.accept_batch",
    "project_lifecycle.inspect",
    "project_lifecycle.commit",
    "asset_usage.analyze",
    "deployment.render_analyze",
    "deployment.render_preview",
    "deployment.deploy",
    "deployment.scan",
    "deployment.inspect_rendered_target",
    "deployment.repair",
    "deployment.recover",
    "reverse_accept.prepare",
    "reverse_accept.commit",
    "reverse_accept.cancel",
    "asset.reindex",
    "state_backup.inspect",
    "state_backup.create",
    "state_restore.inspect",
    "state_restore.activate",
    "diagnostics.support_bundle.inspect",
    "diagnostics.support_bundle.export",
] as const);

export const PROTOCOL_CONTROL_NAMES = Object.freeze(["initialize", "operation.observe", "operation.cancel"] as const);

export const PROTOCOL_OPERATION_NAMES = Object.freeze([
    ...PROTOCOL_IMMEDIATE_QUERY_NAMES,
    ...PROTOCOL_IMMEDIATE_MUTATION_NAMES,
    ...PROTOCOL_ACCEPTED_LONG_NAMES,
    ...PROTOCOL_CONTROL_NAMES,
] as const);

export type ProtocolOperationName = (typeof PROTOCOL_OPERATION_NAMES)[number];
export type ProtocolAcceptedLongOperationName = (typeof PROTOCOL_ACCEPTED_LONG_NAMES)[number];
export type ProtocolDeliveryClass = "immediate_query" | "immediate_mutation" | "accepted_long" | "control";

export const protocolOperationNameSchema = protocolEnum(PROTOCOL_OPERATION_NAMES);
export const protocolAcceptedLongOperationNameSchema = protocolEnum(PROTOCOL_ACCEPTED_LONG_NAMES);
