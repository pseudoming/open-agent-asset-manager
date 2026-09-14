import * as path from "node:path";

export type HostLocalPathSelectionKind =
    | "project_root"
    | "source_root"
    | "installation_root"
    | "backup_destination"
    | "restore_archive"
    | "asset_export_file"
    | "asset_native_export_file"
    | "support_bundle_file";

interface LocalPathSelection {
    readonly kind: HostLocalPathSelectionKind;
    readonly rootPath: string;
    readonly expiresAt: number;
}

export interface HostPathSelectionStoreOptions {
    readonly createToken: () => string;
    readonly now?: () => number;
    readonly maximumSelections?: number;
    readonly maximumAgeMs?: number;
}

const DEFAULT_MAXIMUM_SELECTIONS = 16;
const DEFAULT_MAXIMUM_AGE_MS = 2 * 60 * 60 * 1000;

export class HostPathSelectionStore {
    readonly #createToken: () => string;
    readonly #now: () => number;
    readonly #maximumSelections: number;
    readonly #maximumAgeMs: number;
    readonly #selections = new Map<string, LocalPathSelection>();

    public constructor(options: HostPathSelectionStoreOptions) {
        this.#createToken = options.createToken;
        this.#now = options.now ?? Date.now;
        this.#maximumSelections = options.maximumSelections ?? DEFAULT_MAXIMUM_SELECTIONS;
        this.#maximumAgeMs = options.maximumAgeMs ?? DEFAULT_MAXIMUM_AGE_MS;
        if (this.#maximumSelections < 1 || this.#maximumAgeMs < 1) {
            throw new RangeError("Host path-selection limits must be positive");
        }
    }

    public register(kind: HostLocalPathSelectionKind, rootPath: string): string {
        this.expire();
        if (rootPath.trim() !== rootPath || rootPath.length === 0 || rootPath.includes("\0") || !path.isAbsolute(rootPath)) {
            throw new TypeError("Host path selection must be an absolute trusted-launcher path");
        }
        const replacedToken = [...this.#selections].find(([, selection]) => selection.kind === kind)?.[0];
        const retainedSelectionCount = this.#selections.size - (replacedToken === undefined ? 0 : 1);
        if (retainedSelectionCount >= this.#maximumSelections) {
            throw new Error("Host path-selection capacity is exhausted");
        }
        const token = this.#newToken();
        if (replacedToken !== undefined) this.#selections.delete(replacedToken);
        this.#selections.set(token, { kind, rootPath, expiresAt: this.#now() + this.#maximumAgeMs });
        return token;
    }

    public consume(token: string, expectedKind: HostLocalPathSelectionKind): string | null {
        this.expire();
        const selection = this.#selections.get(token);
        if (selection === undefined) return null;
        this.#selections.delete(token);
        return selection.kind === expectedKind ? selection.rootPath : null;
    }

    public expire(): void {
        const now = this.#now();
        for (const [token, selection] of this.#selections) {
            if (selection.expiresAt <= now) this.#selections.delete(token);
        }
    }

    public clear(): void {
        this.#selections.clear();
    }

    #newToken(): string {
        for (let attempt = 0; attempt < 8; attempt += 1) {
            const token = this.#createToken();
            if (token.length > 0 && token.trim() === token && !token.includes("\0") && !this.#selections.has(token)) return token;
        }
        throw new Error("Host could not allocate a unique local-path token");
    }
}
