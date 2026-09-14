import {
    ProtocolValidationError,
    protocolEnum,
    protocolNonBlankString,
    protocolObject,
    protocolString,
    type InferProtocolSchema,
    type ProtocolSchema,
} from "./validation";

export const PROTOCOL_VERSION = 1 as const;

export const protocolPlatformSchema = protocolEnum(["win32", "darwin", "linux", "wsl"] as const);
export type ProtocolPlatform = InferProtocolSchema<typeof protocolPlatformSchema>;

export const protocolClientKindSchema = protocolEnum(["desktop", "headless"] as const);
export type ProtocolClientKind = InferProtocolSchema<typeof protocolClientKindSchema>;

export const protocolUuidV4Schema: ProtocolSchema<string> = Object.freeze({
    description: "lowercase UUID v4",
    parse(value: unknown, path = "$"): string {
        const parsed = protocolString.parse(value, path);
        const parts = parsed.split("-");
        const valid =
            parts.length === 5 &&
            parts[0]?.length === 8 &&
            parts[1]?.length === 4 &&
            parts[2]?.length === 4 &&
            parts[2]?.startsWith("4") === true &&
            parts[3]?.length === 4 &&
            ["8", "9", "a", "b"].includes((parts[3] as string)[0] as string) &&
            parts[4]?.length === 12 &&
            [...parsed.replaceAll("-", "")].every((character) => "0123456789abcdef".includes(character));
        if (!valid) throw new ProtocolValidationError(path, "expected lowercase UUID v4");
        return parsed;
    },
});

export const protocolSha256Schema: ProtocolSchema<string> = Object.freeze({
    description: "lowercase sha256 digest",
    parse(value: unknown, path = "$"): string {
        const parsed = protocolString.parse(value, path);
        if (parsed.length !== 64 || ![...parsed].every((character) => "0123456789abcdef".includes(character))) {
            throw new ProtocolValidationError(path, "expected lowercase sha256 digest");
        }
        return parsed;
    },
});

export const protocolEnvironmentSelectorSchema = protocolObject(
    {
        platform: protocolPlatformSchema,
        platformInstanceId: protocolNonBlankString,
    },
    "environment selector",
);
export type ProtocolEnvironmentSelectorV1 = InferProtocolSchema<typeof protocolEnvironmentSelectorSchema>;
