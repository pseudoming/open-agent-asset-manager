import * as path from "node:path";
import type { ProductionHostLaunchOptions } from "@oaam/app-server-bootstrap";

const OPTION_NAMES = Object.freeze([
    "--oaam-root",
    "--database-path",
    "--platform",
    "--platform-instance-id",
    "--access-root",
] as const);

type OptionName = (typeof OPTION_NAMES)[number];
type HeadlessPlatform = ProductionHostLaunchOptions["platformContexts"][number]["platform"];
type HostPathApi = Pick<typeof path.posix, "isAbsolute" | "normalize" | "parse" | "sep">;

export class HeadlessConfigurationError extends Error {
    public constructor() {
        super("Headless launch configuration is invalid");
        this.name = "HeadlessConfigurationError";
    }
}

function canonicalHostPath(value: string, allowFilesystemRoot: boolean, hostPath: HostPathApi): string {
    const root = hostPath.parse(value).root;
    if (
        value.length === 0 ||
        value.trim() !== value ||
        value.includes("\0") ||
        !hostPath.isAbsolute(value) ||
        hostPath.normalize(value) !== value ||
        (hostPath.sep === "\\" && (root === "\\" || /^\\\\[?.]\\/u.test(value))) ||
        (!allowFilesystemRoot && value === root) ||
        (!allowFilesystemRoot && value.endsWith(hostPath.sep))
    ) {
        throw new HeadlessConfigurationError();
    }
    return value;
}

function platform(value: string): HeadlessPlatform {
    if (value === "win32" || value === "darwin" || value === "linux" || value === "wsl") return value;
    throw new HeadlessConfigurationError();
}

function parseHeadlessArgumentsForHostPath(argv: readonly string[], hostPath: HostPathApi): ProductionHostLaunchOptions {
    const values = new Map<OptionName, string>();
    for (let index = 0; index < argv.length; index += 2) {
        const name = argv[index];
        const value = argv[index + 1];
        if (
            !OPTION_NAMES.includes(name as OptionName) ||
            value === undefined ||
            value.startsWith("--") ||
            values.has(name as OptionName)
        ) {
            throw new HeadlessConfigurationError();
        }
        values.set(name as OptionName, value);
    }
    if (values.size !== OPTION_NAMES.length) throw new HeadlessConfigurationError();

    const selectedPlatform = platform(values.get("--platform") as string);
    const platformInstanceId = values.get("--platform-instance-id") as string;
    if (
        platformInstanceId.length === 0 ||
        platformInstanceId.trim() !== platformInstanceId ||
        platformInstanceId.includes("\0")
    ) {
        throw new HeadlessConfigurationError();
    }
    return {
        oaamRoot: canonicalHostPath(values.get("--oaam-root") as string, false, hostPath),
        databasePath: canonicalHostPath(values.get("--database-path") as string, false, hostPath),
        platformContexts: [
            {
                platform: selectedPlatform,
                platformInstanceId,
                // Platform names the target runtime. The path is Host-visible and
                // may therefore use Win32 UNC grammar for a selected WSL runtime.
                accessRootPath: canonicalHostPath(values.get("--access-root") as string, true, hostPath),
            },
        ],
    };
}

export function parseHeadlessArguments(argv: readonly string[]): ProductionHostLaunchOptions {
    return parseHeadlessArgumentsForHostPath(argv, path);
}

/** @internal Models the actual Host path API without changing logical target Platform. */
export function parseHeadlessArgumentsWithHostPathForTest(
    argv: readonly string[],
    hostPath: HostPathApi,
): ProductionHostLaunchOptions {
    return parseHeadlessArgumentsForHostPath(argv, hostPath);
}
