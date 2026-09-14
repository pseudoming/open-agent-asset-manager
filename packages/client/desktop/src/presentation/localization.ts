import type { DesktopPresentationSnapshot } from "./presentation-preferences";
import { GERMAN_DESKTOP_MESSAGES } from "./catalog-de";
import { ENGLISH_DESKTOP_MESSAGES, type DesktopMessageId } from "./catalog-en";
import { JAPANESE_DESKTOP_MESSAGES } from "./catalog-ja";
import { SIMPLIFIED_CHINESE_DESKTOP_MESSAGES } from "./catalog-zh-cn";
import type { DesktopResolvedLocale } from "./presentation-preferences";

const DESKTOP_MESSAGE_CATALOGS = Object.freeze({
    en: ENGLISH_DESKTOP_MESSAGES,
    "zh-CN": SIMPLIFIED_CHINESE_DESKTOP_MESSAGES,
    de: GERMAN_DESKTOP_MESSAGES,
    ja: JAPANESE_DESKTOP_MESSAGES,
} satisfies Readonly<Record<DesktopResolvedLocale, Readonly<Record<DesktopMessageId, string>>>>);

export type DesktopMessageValue = string | number | DesktopDisplayText;
export type DesktopMessageValues = Readonly<Record<string, DesktopMessageValue>>;
export type DesktopDisplayText =
    | {
          readonly kind: "localized";
          readonly id: DesktopMessageId;
          readonly values?: DesktopMessageValues;
      }
    | {
          readonly kind: "technical";
          readonly text: string;
      };

export function localizedText(id: DesktopMessageId, values?: DesktopMessageValues): DesktopDisplayText {
    return Object.freeze(values === undefined ? { kind: "localized", id } : { kind: "localized", id, values });
}

export function technicalText(text: string): DesktopDisplayText {
    return Object.freeze({ kind: "technical", text });
}

function formatDisplayValue(snapshot: DesktopPresentationSnapshot, value: DesktopMessageValue): string {
    if (typeof value === "string" || typeof value === "number") return String(value);
    return value.kind === "technical" ? value.text : formatDesktopMessage(snapshot, value.id, value.values);
}

function formatTemplate(
    snapshot: DesktopPresentationSnapshot,
    template: string,
    values: DesktopMessageValues | undefined,
): string {
    if (values === undefined) return template;
    let formatted = template;
    for (const [key, value] of Object.entries(values)) {
        formatted = formatted.replaceAll(`{${key}}`, formatDisplayValue(snapshot, value));
    }
    return formatted;
}

export function formatDesktopMessage(
    snapshot: DesktopPresentationSnapshot,
    id: DesktopMessageId,
    values?: DesktopMessageValues,
): string {
    const template = DESKTOP_MESSAGE_CATALOGS[snapshot.resolvedLocale][id];
    return formatTemplate(snapshot, template, values);
}

export { ENGLISH_DESKTOP_MESSAGES, GERMAN_DESKTOP_MESSAGES, JAPANESE_DESKTOP_MESSAGES, SIMPLIFIED_CHINESE_DESKTOP_MESSAGES };
export type { DesktopMessageId };
