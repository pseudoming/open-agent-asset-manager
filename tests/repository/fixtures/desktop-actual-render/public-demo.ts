import type { DesktopApplicationClientApi } from "../../../../packages/client/desktop/src/renderer/client";

const names: Readonly<Record<string, readonly [string, string]>> = {
    "Project guide map 1": ["Team coding guide", "Shared conventions for a small TypeScript team"],
    "Project guide map 2": ["Architecture notes", "Keep the API, storage and interface boundaries clear"],
    "Review conventions": ["Review checklist", "Check behavior, edge cases and readable tests"],
    "Deployment review": ["Release checklist", "Review migrations and recovery before publishing"],
    "Project onboarding": ["Project orientation", "Find the entry points and run the first test"],
    "Release helper": ["Release notes", "Turn reviewed changes into useful release notes"],
    "Fixture inspector": ["Test planning", "Choose examples that expose the likely failure"],
    "Asset exporter": ["Documentation review", "Check examples, links and setup instructions"],
    "Source validator": ["API review", "Keep request and error contracts consistent"],
    "Project guidance": ["Team coding guide", "Shared conventions for a small TypeScript team"],
};

const previewText = [
    "# Team coding guide",
    "",
    "## Before making changes",
    "Read the project README and the nearest tests.",
    "Describe the user-visible behavior you are changing.",
    "",
    "## While you work",
    "Keep TypeScript strict and changes focused.",
    "Prefer small functions with explicit inputs.",
    "Preserve existing files and ask before overwriting work.",
    "",
    "## Before you finish",
    "Run the checks for the affected behavior.",
    "Explain what changed and what you verified.",
    "",
].join("\n");

function demoValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(demoValue);
    if (value === null || typeof value !== "object") return value;
    const item = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, demoValue(child)]));
    if (typeof item.displayName === "string") {
        const asset = names[item.displayName];
        if (asset) [item.displayName, item.displayDescription] = asset;
        if (item.displayName === "Open Agent Asset Manager") item.displayName = "Atlas Notes";
        if (item.displayName === "Documentation playground") item.displayName = "Developer handbook";
    }
    if (typeof item.rootPath === "string" && item.deleted === false) item.rootPath = "C:\\Projects\\atlas-notes";
    if (item.logicalPath === "AGENTS.md") item.byteLength = new TextEncoder().encode(previewText).length;
    if (typeof item.text === "string" && item.text.includes("Keep facts.")) {
        item.text = previewText;
        item.lineCount = previewText.split("\n").length;
        item.byteLength = new TextEncoder().encode(previewText).length;
    }
    return item;
}

/** Synthetic display data for documentation; ordinary acceptance scenarios are unchanged. */
export function publicDemoClient(client: DesktopApplicationClientApi): DesktopApplicationClientApi {
    return new Proxy(client, {
        get(target, key, receiver) {
            const method = Reflect.get(target, key, receiver) as unknown;
            if (typeof key !== "string" || !/^(get|list|query|preview|read)/u.test(key) || typeof method !== "function") {
                return method;
            }
            return async (...args: readonly unknown[]) => demoValue(await Reflect.apply(method, target, args));
        },
    });
}
