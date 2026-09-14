import fs from "node:fs";
import path from "node:path";
import { WorkspaceGraphError } from "./workspace-graph.mjs";

const TYPESCRIPT_SOURCE_PATTERN = /\.(?:cts|mts|ts|tsx)$/u;
const TYPESCRIPT_DECLARATION_PATTERN = /\.d\.(?:cts|mts|ts)$/u;

export function isTypeScriptSourceFile(filePath) {
    return TYPESCRIPT_SOURCE_PATTERN.test(filePath) && !TYPESCRIPT_DECLARATION_PATTERN.test(filePath);
}

export function walkGovernedRegularFiles(root, options = {}) {
    if (!fs.existsSync(root)) return Object.freeze([]);
    const label = options.label ?? root;
    const files = [];

    const visit = (directory) => {
        const directoryStat = fs.lstatSync(directory);
        if (directoryStat.isSymbolicLink()) {
            throw new WorkspaceGraphError(`${label}: symlinks are not allowed in governed filesystem trees`);
        }
        if (!directoryStat.isDirectory()) {
            throw new WorkspaceGraphError(`${label}: governed filesystem root must be a directory`);
        }

        for (const entry of fs
            .readdirSync(directory, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name, "en"))) {
            const absolutePath = path.join(directory, entry.name);
            if (options.skipPath?.(absolutePath, entry) === true) continue;
            if (entry.isSymbolicLink()) {
                throw new WorkspaceGraphError(
                    `${label}: symlinks are not allowed in governed filesystem trees (${absolutePath})`,
                );
            }
            if (entry.isDirectory()) {
                if (options.recursive !== false) visit(absolutePath);
            } else if (entry.isFile()) {
                files.push(absolutePath);
            } else {
                throw new WorkspaceGraphError(`${label}: unsupported filesystem entry in governed tree (${absolutePath})`);
            }
        }
    };

    visit(root);
    return Object.freeze(files.sort((left, right) => left.localeCompare(right, "en")));
}

export function walkGovernedTypeScriptSources(root, options = {}) {
    return Object.freeze(walkGovernedRegularFiles(root, options).filter((filePath) => isTypeScriptSourceFile(filePath)));
}
