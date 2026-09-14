import path from "node:path";
import {
    SafeFilesystemError,
    durableEnsureDirectory,
    durableReplaceFile,
    readRegularFileNoFollow,
} from "@oaam/shared/filesystem";

export const DESKTOP_WINDOW_STATE_FILE_NAME = "window-state.json";
export const DEFAULT_DESKTOP_WINDOW_WIDTH = 1180;
export const DEFAULT_DESKTOP_WINDOW_HEIGHT = 760;
export const MINIMUM_DESKTOP_WINDOW_WIDTH = 860;
export const MINIMUM_DESKTOP_WINDOW_HEIGHT = 560;

export interface DesktopWindowBounds {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

export type DesktopWindowStateV1 =
    | { readonly schemaVersion: 1; readonly state: "default" }
    | {
          readonly schemaVersion: 1;
          readonly state: "saved";
          readonly bounds: DesktopWindowBounds;
          readonly maximized: boolean;
      };

export type DesktopWindowStateV2 =
    | { readonly schemaVersion: 2; readonly state: "default" }
    | {
          readonly schemaVersion: 2;
          readonly state: "saved";
          /** Outer-window position with content-area dimensions. */
          readonly bounds: DesktopWindowBounds;
          readonly maximized: boolean;
      };

export type DesktopWindowState = DesktopWindowStateV1 | DesktopWindowStateV2;

export interface DesktopWindowStateTarget {
    /** Electron normal outer bounds own the persisted screen position. */
    getNormalBounds(): DesktopWindowBounds;
    getBounds(): DesktopWindowBounds;
    getContentSize(): number[];
    isMaximized(): boolean;
}

export interface DesktopWindowPlacementTarget {
    setBounds(bounds: DesktopWindowBounds): void;
    setPosition(x: number, y: number): void;
    setContentSize(width: number, height: number): void;
}

export interface DesktopWindowDefaultsTarget {
    isMaximized(): boolean;
    unmaximize(): void;
    setContentSize(width: number, height: number): void;
    center(): void;
}

const DEFAULT_WINDOW_STATE: DesktopWindowStateV2 = Object.freeze({ schemaVersion: 2, state: "default" });

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isCoordinate(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= 1_000_000;
}

function isDimension(value: unknown, minimum: number): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= 65_535;
}

function parseDesktopWindowBounds(value: unknown): DesktopWindowBounds {
    if (
        !isExactRecord(value, ["height", "width", "x", "y"]) ||
        !isCoordinate(value.x) ||
        !isCoordinate(value.y) ||
        !isDimension(value.width, MINIMUM_DESKTOP_WINDOW_WIDTH) ||
        !isDimension(value.height, MINIMUM_DESKTOP_WINDOW_HEIGHT)
    ) {
        throw new TypeError("invalid Desktop window bounds");
    }
    return Object.freeze({ x: value.x, y: value.y, width: value.width, height: value.height });
}

export function parseDesktopWindowState(value: unknown): DesktopWindowState {
    if (
        isExactRecord(value, ["schemaVersion", "state"]) &&
        (value.schemaVersion === 1 || value.schemaVersion === 2) &&
        value.state === "default"
    ) {
        return Object.freeze({ schemaVersion: value.schemaVersion, state: "default" });
    }
    if (
        isExactRecord(value, ["bounds", "maximized", "schemaVersion", "state"]) &&
        (value.schemaVersion === 1 || value.schemaVersion === 2) &&
        value.state === "saved" &&
        typeof value.maximized === "boolean"
    ) {
        return Object.freeze({
            schemaVersion: value.schemaVersion,
            state: "saved",
            bounds: parseDesktopWindowBounds(value.bounds),
            maximized: value.maximized,
        });
    }
    throw new TypeError("invalid Desktop window state");
}

export function resolveDesktopWindowState(
    state: DesktopWindowState,
    workAreas: readonly DesktopWindowBounds[],
): DesktopWindowState {
    if (
        state.state === "default" ||
        !workAreas.some((area) => {
            const width = Math.min(state.bounds.x + state.bounds.width, area.x + area.width) - Math.max(state.bounds.x, area.x);
            const height =
                Math.min(state.bounds.y + state.bounds.height, area.y + area.height) - Math.max(state.bounds.y, area.y);
            return width >= 64 && height >= 64;
        })
    ) {
        return DEFAULT_WINDOW_STATE;
    }
    return state;
}

export function restoreDesktopWindowDefaults(target: DesktopWindowDefaultsTarget): void {
    if (target.isMaximized()) target.unmaximize();
    target.setContentSize(DEFAULT_DESKTOP_WINDOW_WIDTH, DEFAULT_DESKTOP_WINDOW_HEIGHT);
    target.center();
}

export function applyDesktopWindowPlacement(target: DesktopWindowPlacementTarget, state: DesktopWindowState): void {
    if (state.state !== "saved") return;
    if (state.schemaVersion === 1) {
        target.setBounds(state.bounds);
        return;
    }
    target.setPosition(state.bounds.x, state.bounds.y);
    target.setContentSize(state.bounds.width, state.bounds.height);
}

export class DesktopWindowStateStore {
    readonly #filePath: string;
    #state: DesktopWindowState;

    public constructor(userDataRoot: string) {
        durableEnsureDirectory(path.dirname(userDataRoot), path.basename(userDataRoot));
        this.#filePath = path.join(userDataRoot, DESKTOP_WINDOW_STATE_FILE_NAME);
        this.#state = this.#load();
    }

    public get current(): DesktopWindowState {
        return this.#state;
    }

    public capture(target: DesktopWindowStateTarget): DesktopWindowStateV2 {
        const normalBounds = target.getNormalBounds();
        const currentBounds = target.getBounds();
        const [contentWidth, contentHeight] = target.getContentSize();
        if (contentWidth === undefined || contentHeight === undefined) {
            throw new TypeError("invalid Desktop window content size");
        }
        const next = parseDesktopWindowState({
            schemaVersion: 2,
            state: "saved",
            bounds: {
                x: normalBounds.x,
                y: normalBounds.y,
                width: normalBounds.width - Math.max(0, currentBounds.width - contentWidth),
                height: normalBounds.height - Math.max(0, currentBounds.height - contentHeight),
            },
            maximized: target.isMaximized(),
        });
        if (next.schemaVersion !== 2) throw new TypeError("invalid current Desktop window state");
        this.#publish(next);
        return next;
    }

    public restoreDefaults(): DesktopWindowStateV2 {
        this.#publish(DEFAULT_WINDOW_STATE);
        return DEFAULT_WINDOW_STATE;
    }

    #publish(next: DesktopWindowState): void {
        durableReplaceFile(this.#filePath, `${JSON.stringify(next, null, 4)}\n`);
        this.#state = next;
    }

    #load(): DesktopWindowState {
        try {
            const { bytes } = readRegularFileNoFollow(this.#filePath);
            return parseDesktopWindowState(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown);
        } catch (error) {
            if (
                (error instanceof SafeFilesystemError && error.failureKind === "not_found") ||
                error instanceof SyntaxError ||
                error instanceof TypeError
            ) {
                return DEFAULT_WINDOW_STATE;
            }
            throw error;
        }
    }
}
