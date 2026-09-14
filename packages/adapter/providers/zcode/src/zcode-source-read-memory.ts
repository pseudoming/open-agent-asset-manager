/** ZCode project-keyed Memory catalog and direct topic candidate builder. */

import type {
    AdapterExtractedAssetCandidate,
    MemoryCatalogMemberBindingInputV1,
    OperationDiagnostic,
    PosixRelativePath,
} from "@oaam/core";
import {
    basename,
    candidateBase,
    candidateIdFor,
    metadataOrigins,
    readDiagnostic,
    separateNative,
    sourceEvidence,
    textEntry,
} from "./zcode-source-read-foundation";
import {
    ZCODE_NATIVE_DIALECTS,
    type ZcodeFileRecord,
    type ZcodeScanResult,
    type ZcodeSourceContext,
} from "./zcode-source-read-model";

const MEMORY_TYPES = new Set(["user", "feedback", "project", "reference"]);

export interface ParsedZcodeMemoryTopic {
    name: string;
    description: string;
    classification: string;
    body: string;
    sessionId: string;
    source: string;
    updatedAt: string;
}

interface MemoryIndexLink {
    title: string;
    hint: string;
}

export interface ParsedZcodeMemoryIndex {
    links: Map<string, MemoryIndexLink>;
    members: MemoryCatalogMemberBindingInputV1[];
    diagnostics: OperationDiagnostic[];
}

export interface ZcodeMemoryTopicRestorationPayload {
    schemaVersion: 1;
    dialectId: typeof ZCODE_NATIVE_DIALECTS.memoryTopic;
    classification: string;
    sessionId: string;
    source: string;
    updatedAt: string;
}

export function parseZcodeMemoryTopicRestorationPayload(bytes: Uint8Array): ZcodeMemoryTopicRestorationPayload | null {
    try {
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
        const record = value as Record<string, unknown>;
        const expected = ["classification", "dialectId", "schemaVersion", "sessionId", "source", "updatedAt"].sort();
        const keys = Object.keys(record).sort();
        return keys.length === expected.length &&
            keys.every((key, index) => key === expected[index]) &&
            record.schemaVersion === 1 &&
            record.dialectId === ZCODE_NATIVE_DIALECTS.memoryTopic &&
            typeof record.classification === "string" &&
            MEMORY_TYPES.has(record.classification) &&
            typeof record.sessionId === "string" &&
            typeof record.source === "string" &&
            typeof record.updatedAt === "string"
            ? (record as unknown as ZcodeMemoryTopicRestorationPayload)
            : null;
    } catch {
        return null;
    }
}

export function buildMemoryCandidates(context: ZcodeSourceContext, scan: ZcodeScanResult) {
    const candidates: AdapterExtractedAssetCandidate[] = [];
    const diagnostics: OperationDiagnostic[] = [];
    let ignoredSource = false;
    const catalog = scan.files.find((file) => file.relativePath === "MEMORY.md");
    const catalogText = catalog?.text === null || catalog === undefined ? null : restoreLeadingUtf8Bom(catalog);
    const index = catalogText === null ? emptyIndex() : parseZcodeMemoryIndex(catalogText);
    const rootDirectory = scan.directories.find((directory) => directory.relativePath === "");

    if (catalog !== undefined) {
        if (catalog.text === null) {
            scan.ignoreRecord(catalog, "memory_catalog_not_utf8");
            diagnostics.push(
                readDiagnostic(
                    "zcode.memory_catalog_not_utf8",
                    "ZCode Memory catalog must be valid UTF-8",
                    "invalid_schema",
                    "error",
                    catalog.relativePath,
                ),
            );
            ignoredSource = true;
        } else if ((catalogText ?? "").trim() !== "") {
            const candidateId = candidateIdFor("Memory", scan, "MEMORY.md#catalog");
            const records = rootDirectory === undefined ? [catalog] : [catalog, rootDirectory];
            const complete = index.diagnostics.every((item) => item.severity !== "error");
            const candidate: AdapterExtractedAssetCandidate = {
                ...candidateBase(context, scan, candidateId, catalog),
                displayName: "ZCode Memory catalog",
                displayDescription: "Ordered ZCode Memory topics",
                files: [],
                nativeRepresentation: separateNative(ZCODE_NATIVE_DIALECTS.memoryCatalog, [catalog]),
                dialectRestorationTransition: { action: "inherit" },
                status: complete ? "complete" : "incomplete",
                assetCandidateStatus: complete ? "importable" : "incomplete",
                promotionSafety: "default_promotable",
                sourceFileOrigins: [],
                sourceContainerEntryIds: rootDirectory === undefined ? [] : [rootDirectory.observedReadEntryId],
                metadataSourceOrigins: metadataOrigins(catalog.observedReadEntryId, false),
                sourceEvidence: sourceEvidence(scan, catalog, "zcode_memory_catalog"),
                diagnostics: index.diagnostics,
                kind: "Memory",
                typeData: { schemaVersion: 2, entityRole: "catalog", members: [] },
                ...(complete ? { memoryCatalogMemberBindingInputs: index.members } : {}),
            };
            scan.attachCandidate(candidateId, records);
            candidates.push(candidate);
        }
    }

    for (const file of scan.files) {
        if (file.relativePath === "MEMORY.md") continue;
        if (file.text === null) {
            scan.ignoreRecord(file, "memory_topic_not_utf8");
            diagnostics.push(
                readDiagnostic(
                    "zcode.memory_topic_not_utf8",
                    "ZCode Memory topic must be valid UTF-8",
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            );
            ignoredSource = true;
            continue;
        }
        const topic = parseZcodeMemoryTopic(restoreLeadingUtf8Bom(file));
        if (topic === null) {
            scan.ignoreRecord(file, "invalid_memory_topic");
            diagnostics.push(
                readDiagnostic(
                    "zcode.memory_topic_invalid",
                    "ZCode Memory topic requires closed frontmatter, non-empty name, recognized type, and body",
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            );
            ignoredSource = true;
            continue;
        }
        const candidateDiagnostics: OperationDiagnostic[] = [];
        if (topic.body === "") {
            candidateDiagnostics.push(
                readDiagnostic(
                    "zcode.memory_topic_body_empty",
                    "ZCode accepts this topic header, but OAAM Memory Unit import requires a non-empty body",
                    "invalid_schema",
                    "error",
                    file.relativePath,
                ),
            );
        }
        const link = index.links.get(file.relativePath);
        if (catalog !== undefined && catalog.text !== null && link === undefined) {
            candidateDiagnostics.push(
                readDiagnostic(
                    "zcode.memory_topic_unlinked",
                    "Memory topic is not linked from MEMORY.md but remains a source candidate",
                    "partial",
                    "warning",
                    file.relativePath,
                ),
            );
        }
        const candidateId = candidateIdFor("Memory", scan, file.relativePath);
        const nativeRecords: ZcodeFileRecord[] = [{ ...file, relativePath: file.relativePath }];
        const evidence = sourceEvidence(scan, file, "zcode_memory_topic");
        const originRecords: ZcodeFileRecord[] = [file];
        if (catalog !== undefined && link !== undefined) {
            originRecords.push(catalog);
            evidence.push({
                evidenceOrigin: "observed_read",
                observedReadEntryId: catalog.observedReadEntryId,
                kind: "summary",
                value: `MEMORY.md:${link.title}:${link.hint}`,
                evidenceLevel: scan.capability.evidenceLevel,
            });
        }
        const restoration = {
            schemaVersion: 1,
            dialectId: ZCODE_NATIVE_DIALECTS.memoryTopic,
            classification: topic.classification,
            sessionId: topic.sessionId,
            source: topic.source,
            updatedAt: topic.updatedAt,
        };
        const complete = topic.body !== "";
        const candidate: AdapterExtractedAssetCandidate = {
            ...candidateBase(context, scan, candidateId, file),
            scopePath: "",
            displayName: topic.name,
            displayDescription: topic.description,
            files: [textEntry("memory.md", topic.body)],
            nativeRepresentation: separateNative(ZCODE_NATIVE_DIALECTS.memoryTopic, nativeRecords),
            dialectRestorationTransition: { action: "replace", bytes: Buffer.from(JSON.stringify(restoration), "utf-8") },
            status: complete ? "complete" : "incomplete",
            assetCandidateStatus: complete ? "importable" : "incomplete",
            promotionSafety: "requires_user_confirmation",
            sourceFileOrigins: [{ logicalPath: "memory.md", observedReadEntryIds: [file.observedReadEntryId] }],
            sourceContainerEntryIds: [],
            metadataSourceOrigins: metadataOrigins(file.observedReadEntryId, true),
            sourceEvidence: evidence,
            diagnostics: candidateDiagnostics,
            kind: "Memory",
            typeData: {
                schemaVersion: 2,
                entityRole: "unit",
                card: { name: topic.name, description: topic.description },
                loading: { card: "high", body: "low" },
                applicabilityRule: "",
            },
        };
        scan.attachCandidate(candidateId, originRecords);
        candidates.push(candidate);
    }
    return { candidates, diagnostics, ignoredSource };
}

export function parseZcodeMemoryTopic(content: string): ParsedZcodeMemoryTopic | null {
    const source = normalizeLines(content);
    const lines = source.split("\n");
    if (lines[0] !== "---") return null;
    const closingIndex = lines.findIndex((line, index) => index > 0 && line === "---");
    if (closingIndex < 0) return null;
    const fields = new Map<string, string>();
    for (const rawLine of lines.slice(1, closingIndex)) {
        const line = rawLine.trim();
        if (line === "" || line.startsWith("#")) continue;
        const separator = line.indexOf(":");
        if (separator <= 0) continue;
        fields.set(line.slice(0, separator).trim(), parseMemoryScalar(line.slice(separator + 1).trim()));
    }
    const classification = fields.get("type") ?? "";
    const name = oneLine(fields.get("name") ?? "", 72);
    if (!MEMORY_TYPES.has(classification) || name === "") return null;
    const body = lines
        .slice(closingIndex + 1)
        .join("\n")
        .trim();
    return {
        name,
        description: oneLine(fields.get("description") ?? body, 180),
        classification,
        body,
        sessionId: oneLine(fields.get("sessionId") ?? "", 120),
        source: oneLine(fields.get("source") ?? "", 80),
        updatedAt: oneLine(fields.get("updatedAt") ?? "", 80),
    };
}

function parseMemoryScalar(value: string): string {
    if (value.startsWith('"') && value.endsWith('"')) {
        try {
            const parsed: unknown = JSON.parse(value);
            return typeof parsed === "string" ? parsed : value.slice(1, -1);
        } catch {
            return value.slice(1, -1);
        }
    }
    return value;
}

export function parseZcodeMemoryIndex(content: string): ParsedZcodeMemoryIndex {
    const links = new Map<string, MemoryIndexLink>();
    const members: MemoryCatalogMemberBindingInputV1[] = [];
    const ambiguousTargets = new Set<string>();
    const diagnostics: OperationDiagnostic[] = [];
    for (const [lineIndex, line] of normalizeLines(content).split("\n").entries()) {
        if (!line.startsWith("- [")) continue;
        const titleEnd = line.indexOf("](", 3);
        const targetEnd = titleEnd < 0 ? -1 : line.indexOf(") — ", titleEnd + 2);
        if (titleEnd < 0 || targetEnd < 0) {
            diagnostics.push(invalidCatalogMember(lineIndex + 1));
            continue;
        }
        const title = oneLine(line.slice(3, titleEnd), 180);
        const target = line.slice(titleEnd + 2, targetEnd);
        if (title === "" || !isMemoryTopicPath(target)) {
            diagnostics.push(invalidCatalogMember(lineIndex + 1));
            continue;
        }
        const hint = oneLine(withoutTypeSuffix(line.slice(targetEnd + 4)), 180);
        if (links.has(target) || ambiguousTargets.has(target)) {
            links.delete(target);
            const existingIndex = members.findIndex((member) => member.rawTarget === target);
            if (existingIndex >= 0) members.splice(existingIndex, 1);
            if (ambiguousTargets.has(target)) continue;
            ambiguousTargets.add(target);
            diagnostics.push(
                readDiagnostic(
                    "zcode.memory_catalog_duplicate_link",
                    "ZCode Memory catalog contains a duplicate topic path",
                    "conflict",
                    "error",
                    target,
                ),
            );
            continue;
        }
        links.set(target, { title: title || basename(target), hint });
        members.push({ rawTarget: target as PosixRelativePath, routingTitle: title, routingHint: hint });
    }
    return { links, members, diagnostics };
}

function invalidCatalogMember(lineNumber: number): OperationDiagnostic {
    return readDiagnostic(
        "zcode.memory_catalog_member_invalid",
        `ZCode Memory catalog contains an invalid topic declaration at line ${lineNumber}`,
        "invalid_schema",
        "error",
        "MEMORY.md",
    );
}

function isMemoryTopicPath(value: string): boolean {
    const segments = value.split("/");
    return (
        segments.length === 2 &&
        segments[0] === "topics" &&
        (segments[1] ?? "").endsWith(".md") &&
        segments.every((segment) => segment !== "" && segment !== "." && segment !== ".." && !segment.includes("\\"))
    );
}

function withoutTypeSuffix(value: string): string {
    const markerIndex = value.lastIndexOf(" (type:");
    return (markerIndex < 0 ? value : value.slice(0, markerIndex)).trim();
}

function emptyIndex(): ParsedZcodeMemoryIndex {
    return { links: new Map(), members: [], diagnostics: [] };
}

function normalizeLines(value: string): string {
    return value.replace(/\r\n/g, "\n");
}

function restoreLeadingUtf8Bom(file: ZcodeFileRecord): string {
    const hasBom = file.bytes[0] === 0xef && file.bytes[1] === 0xbb && file.bytes[2] === 0xbf;
    return hasBom ? `\ufeff${file.text ?? ""}` : (file.text ?? "");
}

function oneLine(value: string, limit: number): string {
    const normalized = value.split(/\s+/).filter(Boolean).join(" ").trim();
    return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 3))}...`;
}
