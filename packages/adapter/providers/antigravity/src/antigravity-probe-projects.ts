/** Project registry, trusted-workspace, and summaries-protobuf probe logic. */

import {
    canonicalHostPath,
    canonicalProviderHostPathWithinAccessRoot,
    hostAbsolutePathToRuntime,
    hostPathApiFor,
    runtimeAbsolutePathToHost,
} from "@oaam/adapter-framework";
import type {
    AdapterProbeContext,
    AdapterProbeResult,
    AgentRuntimeId,
    OperationDiagnostic,
    Platform,
    PlatformContext,
    SourceRoot,
} from "@oaam/core";
import {
    type BoundedDirectoryEntry,
    readDirectoryEntriesBounded,
    readRegularFileBounded,
    SafeFilesystemError,
} from "@oaam/shared/filesystem";
import { physicalAccessPathContains } from "@oaam/shared/paths";
import { type AntigravityPathRule, canonicalAntigravityRoot } from "./antigravity-paths";
import { readAntigravityCliProjectIndex } from "./antigravity-probe-cli-project-index";
import {
    addSourceRoot,
    compareText,
    diagnostic,
    ioDiagnostic,
    isPermission,
    isRecord,
    makeSourceRoot,
    MAX_PROBE_JSON_BYTES,
    runtimeValues,
    stableId,
    stringValue,
    uniqueSorted,
} from "./antigravity-probe-foundation";
import { canonicalWorkspacePath } from "./antigravity-project-paths";

const MAX_PROJECT_REGISTRY_ENTRIES = 4096;
// Match the reviewed selected-WSL Provider stable-read ceiling. Larger registry
// snapshots remain partial instead of falling back to main-thread UNC reads.
const MAX_SUMMARIES_BYTES = 16 * 1024 * 1024;
const MAX_PROTO_FIELDS = 500_000;

type AgentRuntimeResource = AdapterProbeResult["observation"]["agentRuntimeResources"][number];

export interface ProjectRecord {
    runtimeProjectKey: string;
    displayName: string;
    agentRuntimeIds: AgentRuntimeId[];
    workspaces: Array<{ path: string; role: "primary" | "additional" }>;
    evidence: AdapterProbeResult["observation"]["observedProjects"][number]["evidence"];
    diagnostics: OperationDiagnostic[];
}

export interface ProjectDiscovery {
    records: ProjectRecord[];
    diagnostics: OperationDiagnostic[];
    indexes: Record<"shared" | "app" | "ide" | "cli", "complete" | "not_found" | "partial">;
}

export interface MaterializedProjectDiscovery {
    observedProjects: AdapterProbeResult["observation"]["observedProjects"];
    observedProjectIdsByRuntime: Map<AgentRuntimeId, string[]>;
    sourceRootIdsByRuntime: Map<AgentRuntimeId, string[]>;
    diagnostics: OperationDiagnostic[];
}

interface ProtoField {
    tag: number;
    wireType: number;
    bytes?: Uint8Array;
}

interface ProjectRegistryFile {
    readonly name: string;
    readonly path: string;
}

type ProjectFileReader = (path: string, maximumBytes: number) => Uint8Array;

interface ProjectDiscoveryDependencies {
    readonly readDirectoryEntries: (directoryPath: string, maximumEntries: number) => BoundedDirectoryEntry[];
    readonly readRegularFile: ProjectFileReader;
}

const DEFAULT_PROJECT_DISCOVERY_DEPENDENCIES: ProjectDiscoveryDependencies = {
    readDirectoryEntries: readDirectoryEntriesBounded,
    readRegularFile: readRegularFileBounded,
};

export async function discoverAntigravityProjects(
    context: AdapterProbeContext,
    environment: NodeJS.ProcessEnv,
    rule: AntigravityPathRule,
    sharedRegistry: AgentRuntimeResource,
    appPb: AgentRuntimeResource,
    idePb: AgentRuntimeResource,
    cliSummaries: AgentRuntimeResource,
    overrides: Partial<ProjectDiscoveryDependencies> = {},
): Promise<ProjectDiscovery> {
    const records: ProjectRecord[] = [];
    const diagnostics: OperationDiagnostic[] = [];
    const indexState = (resource: AgentRuntimeResource): "complete" | "not_found" | "partial" =>
        resource.accessStatus === "available" ? "complete" : resource.accessStatus === "not_found" ? "not_found" : "partial";
    const indexes: ProjectDiscovery["indexes"] = {
        shared: indexState(sharedRegistry),
        app: indexState(appPb),
        ide: indexState(idePb),
        cli: indexState(cliSummaries),
    };

    if (context.authorizationScope === "project") {
        const projectPath = canonicalAntigravityRoot(context.projectRootPath);
        if (projectPath === null) {
            diagnostics.push(
                diagnostic(
                    "antigravity_project_root_invalid",
                    "The authorized Antigravity project root is not canonical absolute",
                    "invalid_schema",
                    "error",
                    context.projectRootPath,
                ),
            );
        } else {
            const runtimeProjectPath =
                hostAbsolutePathToRuntime(
                    context.platformContext.platform,
                    context.platformContext.accessRootPath,
                    projectPath,
                ) ?? projectPath;
            records.push({
                runtimeProjectKey: environment.ANTIGRAVITY_PROJECT_ID?.trim() || stableId("project-key", runtimeProjectPath),
                displayName: pathBasename(projectPath),
                agentRuntimeIds: ["ANTIGRAVITY_CLI", "ANTIGRAVITY_APP", "ANTIGRAVITY_IDE"],
                workspaces: [{ path: projectPath, role: "primary" }],
                evidence: [
                    {
                        evidenceKind: "invocation",
                        locatorKey: "probe_project_root",
                        evidenceLevel: "user_provided",
                    },
                ],
                diagnostics: [],
            });
        }
        return {
            records: mergeProjectRecords(records),
            diagnostics,
            indexes,
        };
    }

    const dependencies = { ...DEFAULT_PROJECT_DISCOVERY_DEPENDENCIES, ...overrides };
    let sharedRegistryFiles: ProjectRegistryFile[] = [];
    if (sharedRegistry.accessStatus === "available") {
        sharedRegistryFiles = listSharedProjectRegistryFiles(
            rule.sharedProjectsRoot,
            diagnostics,
            dependencies.readDirectoryEntries,
        );
        if (diagnostics.length > 0) indexes.shared = "partial";
    }
    const readFile = dependencies.readRegularFile;
    if (sharedRegistry.accessStatus === "available") {
        const parsed = readSharedProjectRegistry(
            sharedRegistryFiles,
            sharedRegistry.agentRuntimeResourceId,
            context.platformContext.platform,
            readFile,
        );
        records.push(...parsed.records);
        diagnostics.push(...parsed.diagnostics);
        if (parsed.diagnostics.some((item) => item.severity !== "info")) indexes.shared = "partial";
    }
    if (appPb.accessStatus === "available") {
        const parsed = readSummariesProjects(
            rule.appSummariesPath,
            appPb.agentRuntimeResourceId,
            "app",
            context.platformContext.platform,
            readFile,
        );
        records.push(...parsed.records);
        diagnostics.push(...parsed.diagnostics);
        if (parsed.diagnostics.some((item) => item.severity !== "info")) indexes.app = "partial";
    }
    if (idePb.accessStatus === "available") {
        const parsed = readSummariesProjects(
            rule.ideSummariesPath,
            idePb.agentRuntimeResourceId,
            "ide",
            context.platformContext.platform,
            readFile,
        );
        records.push(...parsed.records);
        diagnostics.push(...parsed.diagnostics);
        if (parsed.diagnostics.some((item) => item.severity !== "info")) indexes.ide = "partial";
    }
    // CLI trustedWorkspaces is a permission list, not a Project index; its presence does not determine enumeration.
    if (cliSummaries.accessStatus === "available") {
        const index = await readAntigravityCliProjectIndex(
            rule.cliSummariesDbPath,
            cliSummaries.agentRuntimeResourceId,
            context.platformContext,
        );
        records.push(...index.records);
        diagnostics.push(...index.diagnostics);
        indexes.cli = index.status;
    }
    return {
        records: mergeProjectRecords(records),
        diagnostics,
        indexes,
    };
}

export function antigravityProjectDiscoveryStatus(
    context: AdapterProbeContext,
    indexes: readonly ProjectDiscovery["indexes"]["shared"][],
): "complete" | "partial" | "not_found" {
    if (context.authorizationScope === "project") return "complete";
    if (context.authorizationScope === "directory") return "not_found";
    if (indexes.some((status) => status === "partial")) return "partial";
    return indexes.every((status) => status === "not_found") ? "not_found" : "complete";
}

export function materializeAntigravityProjects(
    records: ProjectRecord[],
    sourceRoots: Map<string, SourceRoot>,
    platformContext: PlatformContext,
    rule?: AntigravityPathRule,
): MaterializedProjectDiscovery {
    const diagnostics: OperationDiagnostic[] = [];
    const observedProjectIdsByRuntime = new Map<AgentRuntimeId, string[]>([
        ["ANTIGRAVITY_CLI", []],
        ["ANTIGRAVITY_APP", []],
        ["ANTIGRAVITY_IDE", []],
    ]);
    const sourceRootIdsByRuntime = new Map<AgentRuntimeId, string[]>([
        ["ANTIGRAVITY_CLI", []],
        ["ANTIGRAVITY_APP", []],
        ["ANTIGRAVITY_IDE", []],
    ]);
    const observedProjects = records
        .flatMap((record) => {
            const materializedWorkspaces = record.workspaces.flatMap((workspace) => {
                const hostPath = materializeWorkspacePath(workspace.path, platformContext);
                if (hostPath === null) {
                    diagnostics.push(
                        diagnostic(
                            "antigravity_project_workspace_unreachable",
                            "An Antigravity project workspace cannot be mapped into the selected Host-visible environment",
                            "partial",
                            "warning",
                            workspace.path,
                        ),
                    );
                    return [];
                }
                const managedRoot = rule === undefined ? undefined : antigravityManagedRootForPath(hostPath, rule);
                if (managedRoot !== undefined) {
                    diagnostics.push(
                        diagnostic(
                            "antigravity_managed_project_workspace_excluded",
                            "An Antigravity plugin or builtin-managed path was excluded from ordinary project discovery",
                            "unsupported",
                            "info",
                            hostPath,
                        ),
                    );
                    return [];
                }
                return [{ hostPath, role: workspace.role }];
            });
            if (!materializedWorkspaces.some((workspace) => workspace.role === "primary")) return [];
            const workspaces = materializedWorkspaces.flatMap((workspace) => {
                const sourceRootId = addSourceRoot(
                    sourceRoots,
                    makeSourceRoot(
                        workspace.hostPath,
                        "project_actual",
                        "project_root",
                        "directory",
                        projectRootLocatorEvidence(record),
                    ),
                );
                return [{ sourceRootId, role: workspace.role }];
            });
            const firstWorkspace = workspaces[0];
            if (firstWorkspace === undefined) return [];
            const observedProjectId = stableId("project", `${record.runtimeProjectKey}\0${firstWorkspace.sourceRootId}`);
            for (const agentRuntimeId of record.agentRuntimeIds) {
                runtimeValues(observedProjectIdsByRuntime, agentRuntimeId).push(observedProjectId);
                runtimeValues(sourceRootIdsByRuntime, agentRuntimeId).push(
                    ...workspaces.map((workspace) => workspace.sourceRootId),
                );
            }
            return [
                {
                    observedProjectId,
                    runtimeProjectKey: record.runtimeProjectKey,
                    displayName: record.displayName,
                    workspaces,
                    evidence: record.evidence,
                    diagnostics: record.diagnostics,
                },
            ];
        })
        .sort((left, right) => compareText(left.observedProjectId, right.observedProjectId));
    for (const values of observedProjectIdsByRuntime.values()) values.sort(compareText);
    for (const [agentRuntimeId, values] of sourceRootIdsByRuntime) {
        sourceRootIdsByRuntime.set(agentRuntimeId, uniqueSorted(values));
    }
    return { observedProjects, observedProjectIdsByRuntime, sourceRootIdsByRuntime, diagnostics };
}

function projectRootLocatorEvidence(record: ProjectRecord): SourceRoot["locatorEvidence"] {
    const explicitProjectRoot = record.evidence.find(
        (evidence) =>
            evidence.evidenceKind === "invocation" &&
            evidence.locatorKey === "probe_project_root" &&
            evidence.evidenceLevel === "user_provided",
    );
    if (explicitProjectRoot !== undefined) {
        return [
            {
                locatorKind: "user_provided_path",
                locatorKey: "probe_project_root",
                evidenceLevel: "user_provided",
            },
        ];
    }
    return [
        {
            locatorKind: "project_registry_entry",
            locatorKey: record.runtimeProjectKey,
            evidenceLevel: record.evidence[0]?.evidenceLevel ?? "local_artifact",
        },
    ];
}

function antigravityManagedRootForPath(hostPath: string, rule: AntigravityPathRule): string | undefined {
    const paths = hostPathApiFor(rule.familyRoot);
    if (paths === null) return undefined;
    return [
        paths.join(rule.sharedConfigRoot, "plugins"),
        paths.join(rule.appDataRoot, "builtin"),
        paths.join(rule.cliDataRoot, "builtin"),
        paths.join(rule.cliDataRoot, "plugins"),
    ].find((root) => physicalAccessPathContains(root, hostPath));
}

export function parseSummariesProjects(
    bytes: Uint8Array,
    platform: Platform = "linux",
): Array<{ projectId: string; workspacePath: string }> {
    const root = parseProto(bytes);
    const records: Array<{ projectId: string; workspacePath: string }> = [];
    for (const rootEntry of root.filter((field) => field.tag === 1 && field.bytes !== undefined)) {
        const entry = parseProto(rootEntry.bytes as Uint8Array);
        const conversationId = decodeText(firstBytes(entry, 1));
        const metadataBytes = firstBytes(entry, 2);
        if (conversationId === "" || metadataBytes === undefined) continue;
        const metadata = parseProto(metadataBytes);
        const configBytes = firstBytes(metadata, 17);
        if (configBytes === undefined) continue;
        const config = parseProto(configBytes);
        const parentConversationId = decodeText(firstBytes(config, 5));
        const projectId = decodeText(firstBytes(config, 18));
        const workspaceText = decodeText(firstBytes(config, 7));
        const workspacePath = canonicalWorkspacePath(workspaceText, platform);
        // Child/subagent summaries are session-private evidence. Only top-level
        // entries may contribute to ordinary project discovery.
        if (parentConversationId === "" && projectId !== "" && workspacePath !== null) {
            records.push({ projectId, workspacePath });
        }
    }
    const unique = new Map(records.map((record) => [`${record.projectId}\0${record.workspacePath}`, record]));
    return [...unique.values()].sort((left, right) =>
        compareText(`${left.projectId}\0${left.workspacePath}`, `${right.projectId}\0${right.workspacePath}`),
    );
}

function listSharedProjectRegistryFiles(
    directory: string,
    diagnostics: OperationDiagnostic[],
    readDirectoryEntries: ProjectDiscoveryDependencies["readDirectoryEntries"],
): ProjectRegistryFile[] {
    let entries: BoundedDirectoryEntry[];
    try {
        entries = readDirectoryEntries(directory, MAX_PROJECT_REGISTRY_ENTRIES)
            .filter((entry) => entry.entryKind === "file" && entry.name.endsWith(".json"))
            .sort((left, right) => compareText(left.name, right.name));
    } catch (error) {
        if (error instanceof SafeFilesystemError && error.failureKind === "resource_limit") {
            diagnostics.push(
                diagnostic(
                    "antigravity_project_registry_too_large",
                    "The shared Antigravity project registry exceeds the bounded entry limit",
                    "invalid_schema",
                    "error",
                    directory,
                ),
            );
            return [];
        }
        diagnostics.push(ioDiagnostic("antigravity_project_registry_unreadable", directory, error));
        return [];
    }
    const paths = hostPathApiFor(directory);
    if (paths === null) {
        diagnostics.push(
            diagnostic(
                "antigravity_project_registry_path_invalid",
                "The Antigravity project registry path is not canonical absolute",
                "invalid_schema",
                "error",
                directory,
            ),
        );
        return [];
    }
    return entries.map((entry) => ({ name: entry.name, path: paths.join(directory, entry.name) }));
}

function readSharedProjectRegistry(
    entries: readonly ProjectRegistryFile[],
    resourceId: string,
    platform: Platform,
    readFile: ProjectFileReader,
): { records: ProjectRecord[]; diagnostics: OperationDiagnostic[] } {
    const records: ProjectRecord[] = [];
    const diagnostics: OperationDiagnostic[] = [];
    for (const entry of entries) {
        const value = readBoundedJson(entry.path, diagnostics, readFile);
        if (!isRecord(value)) continue;
        const id = stringValue(value.id);
        const name = stringValue(value.name);
        const declaredResources =
            value.projectResources === undefined
                ? undefined
                : isRecord(value.projectResources)
                  ? value.projectResources.resources
                  : null;
        if (
            id !== "" &&
            (declaredResources === undefined || (Array.isArray(declaredResources) && declaredResources.length === 0))
        ) {
            // Valid runtime-only Projects have no filesystem workspace to register or target.
            continue;
        }
        const workspacePaths = projectWorkspacePaths(value.projectResources, platform);
        if (id === "" || workspacePaths.length === 0) {
            diagnostics.push(
                diagnostic(
                    "antigravity_project_registry_entry_incomplete",
                    "An Antigravity project registry entry lacks an id or primary workspace",
                    "invalid_schema",
                    "warning",
                    entry.path,
                ),
            );
            continue;
        }
        records.push({
            runtimeProjectKey: id,
            displayName: name || pathBasename(workspacePaths[0] as string),
            agentRuntimeIds: ["ANTIGRAVITY_CLI", "ANTIGRAVITY_APP", "ANTIGRAVITY_IDE"],
            workspaces: workspacePaths.map((workspace, index) => ({
                path: workspace,
                role: index === 0 ? "primary" : "additional",
            })),
            evidence: [
                {
                    evidenceKind: "agent_runtime_resource",
                    agentRuntimeResourceId: resourceId,
                    locatorKey: entry.name,
                    evidenceLevel: "agent_runtime_verified",
                },
            ],
            diagnostics: [],
        });
    }
    return { records, diagnostics };
}

function readSummariesProjects(
    path: string,
    resourceId: string,
    entryName: "app" | "ide",
    platform: Platform,
    readFile: ProjectFileReader,
): { records: ProjectRecord[]; diagnostics: OperationDiagnostic[] } {
    const diagnostics: OperationDiagnostic[] = [];
    let bytes: Uint8Array;
    try {
        bytes = readFile(path, MAX_SUMMARIES_BYTES);
    } catch (error) {
        diagnostics.push(ioDiagnostic("antigravity_summaries_unreadable", path, error));
        return { records: [], diagnostics };
    }
    try {
        const records = parseSummariesProjects(bytes, platform).map((project) => ({
            runtimeProjectKey: project.projectId,
            displayName: pathBasename(project.workspacePath),
            agentRuntimeIds: [entryName === "app" ? ("ANTIGRAVITY_APP" as const) : ("ANTIGRAVITY_IDE" as const)],
            workspaces: [{ path: project.workspacePath, role: "primary" as const }],
            evidence: [
                {
                    evidenceKind: "agent_runtime_resource" as const,
                    agentRuntimeResourceId: resourceId,
                    locatorKey: `${entryName}:tag18=${project.projectId}:tag7`,
                    evidenceLevel: "agent_runtime_verified" as const,
                },
            ],
            diagnostics: [],
        }));
        return { records, diagnostics };
    } catch (error) {
        diagnostics.push(
            diagnostic(
                "antigravity_summaries_schema_invalid",
                error instanceof Error ? error.message : "Antigravity summaries protobuf is malformed",
                "invalid_schema",
                "error",
                path,
            ),
        );
        return { records: [], diagnostics };
    }
}

function parseProto(bytes: Uint8Array): ProtoField[] {
    const fields: ProtoField[] = [];
    let offset = 0;
    while (offset < bytes.length) {
        if (fields.length >= MAX_PROTO_FIELDS) {
            throw new Error("Antigravity protobuf exceeds the field limit");
        }
        const key = decodeVarint(bytes, offset);
        offset = key.offset;
        const tag = Number(key.value >> 3n);
        const wireType = Number(key.value & 7n);
        if (tag <= 0) throw new Error("Antigravity protobuf contains an invalid field tag");
        if (wireType === 0) {
            offset = decodeVarint(bytes, offset).offset;
            fields.push({ tag, wireType });
        } else if (wireType === 1) {
            if (offset + 8 > bytes.length) {
                throw new Error("Antigravity protobuf fixed64 is truncated");
            }
            offset += 8;
            fields.push({ tag, wireType });
        } else if (wireType === 2) {
            const length = decodeVarint(bytes, offset);
            offset = length.offset;
            if (length.value > BigInt(bytes.length - offset)) {
                throw new Error("Antigravity protobuf bytes field is truncated");
            }
            const end = offset + Number(length.value);
            fields.push({ tag, wireType, bytes: bytes.slice(offset, end) });
            offset = end;
        } else if (wireType === 5) {
            if (offset + 4 > bytes.length) {
                throw new Error("Antigravity protobuf fixed32 is truncated");
            }
            offset += 4;
            fields.push({ tag, wireType });
        } else {
            throw new Error(`Antigravity protobuf wire type ${wireType} is unsupported`);
        }
    }
    return fields;
}

function decodeVarint(bytes: Uint8Array, start: number): { value: bigint; offset: number } {
    let value = 0n;
    let shift = 0n;
    let offset = start;
    while (offset < bytes.length && shift <= 63n) {
        const byte = BigInt(bytes[offset] as number);
        offset += 1;
        value |= (byte & 0x7fn) << shift;
        if ((byte & 0x80n) === 0n) return { value, offset };
        shift += 7n;
    }
    throw new Error("Antigravity protobuf varint is truncated or too large");
}

function firstBytes(fields: ProtoField[], tag: number): Uint8Array | undefined {
    return fields.find((field) => field.tag === tag && field.bytes !== undefined)?.bytes;
}

function decodeText(bytes: Uint8Array | undefined): string {
    if (bytes === undefined) return "";
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
    } catch {
        return "";
    }
}

function projectWorkspacePaths(projectResources: unknown, platform: Platform): string[] {
    if (!isRecord(projectResources) || !Array.isArray(projectResources.resources)) return [];
    const paths: string[] = [];
    for (const resource of projectResources.resources) {
        if (!isRecord(resource)) continue;
        const direct = stringValue(resource.folderUri);
        const nested = isRecord(resource.gitFolder) ? stringValue(resource.gitFolder.folderUri) : "";
        const workspacePath = canonicalWorkspacePath(direct || nested, platform);
        if (workspacePath !== null) paths.push(workspacePath);
    }
    return uniqueSorted(paths);
}

function materializeWorkspacePath(value: string, context: PlatformContext): string | null {
    const canonical = canonicalHostPath(value);
    const accessPaths = hostPathApiFor(context.accessRootPath);
    if (accessPaths === null) return null;
    if (canonical !== null && hostPathApiFor(canonical) === accessPaths) {
        return canonicalProviderHostPathWithinAccessRoot(canonical, context);
    }
    const mapped = runtimeAbsolutePathToHost(context.platform, context.accessRootPath, value);
    return mapped !== null && hostPathApiFor(mapped) === accessPaths
        ? canonicalProviderHostPathWithinAccessRoot(mapped, context)
        : null;
}

function pathBasename(value: string): string {
    const hostPaths = hostPathApiFor(value);
    return hostPaths?.basename(value) || value;
}

function mergeProjectRecords(records: ProjectRecord[]): ProjectRecord[] {
    const merged = new Map<string, ProjectRecord>();
    for (const record of records) {
        const firstWorkspace = record.workspaces[0];
        if (firstWorkspace === undefined) continue;
        const key = `${record.runtimeProjectKey}\0${firstWorkspace.path}`;
        const existing = merged.get(key);
        if (existing === undefined) {
            merged.set(key, structuredClone(record));
            continue;
        }
        existing.workspaces = uniqueWorkspaces([...existing.workspaces, ...record.workspaces]);
        existing.agentRuntimeIds = uniqueAgentRuntimeIds([...existing.agentRuntimeIds, ...record.agentRuntimeIds]);
        existing.evidence = uniqueEvidence([...existing.evidence, ...record.evidence]);
        existing.diagnostics.push(...record.diagnostics);
    }
    return [...merged.values()].sort((left, right) =>
        compareText(
            `${left.runtimeProjectKey}\0${(left.workspaces[0] as ProjectRecord["workspaces"][number]).path}`,
            `${right.runtimeProjectKey}\0${(right.workspaces[0] as ProjectRecord["workspaces"][number]).path}`,
        ),
    );
}

function uniqueAgentRuntimeIds(values: AgentRuntimeId[]): AgentRuntimeId[] {
    return [...new Set(values)].sort(compareText);
}

function uniqueWorkspaces(workspaces: ProjectRecord["workspaces"]): ProjectRecord["workspaces"] {
    const paths = new Map<string, ProjectRecord["workspaces"][number]>();
    for (const workspace of workspaces) {
        const existing = paths.get(workspace.path);
        if (existing === undefined || workspace.role === "primary") {
            paths.set(workspace.path, workspace);
        }
    }
    const values = [...paths.values()].sort((left, right) => compareText(left.path, right.path));
    if (!values.some((workspace) => workspace.role === "primary") && values[0] !== undefined) {
        values[0] = { ...values[0], role: "primary" };
    }
    return values;
}

function uniqueEvidence(evidence: ProjectRecord["evidence"]): ProjectRecord["evidence"] {
    const keyed = new Map(evidence.map((item) => [JSON.stringify(item), item]));
    return [...keyed.values()].sort((left, right) => compareText(JSON.stringify(left), JSON.stringify(right)));
}

function readBoundedJson(path: string, diagnostics: OperationDiagnostic[], readFile: ProjectFileReader): unknown {
    try {
        return JSON.parse(Buffer.from(readFile(path, MAX_PROBE_JSON_BYTES)).toString("utf8"));
    } catch (error) {
        diagnostics.push(
            diagnostic(
                "antigravity_json_source_invalid",
                error instanceof Error ? error.message : "Antigravity JSON source is unreadable",
                isPermission(error) ? "permission_denied" : "invalid_schema",
                "warning",
                path,
            ),
        );
        return null;
    }
}
