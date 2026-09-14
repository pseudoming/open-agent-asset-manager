import { fireEvent } from "@testing-library/react";
import { expect } from "vitest";

export function interactionElement(entryId: string, root: ParentNode = document): HTMLElement {
    const candidates = [...root.querySelectorAll<HTMLElement>(`[data-oaam-interaction-entry="${entryId}"]`)];
    expect(candidates, `${entryId} must resolve to one exact rendered interaction`).toHaveLength(1);
    const element = candidates[0];
    if (element === undefined) throw new Error(`${entryId} did not resolve to a rendered interaction`);
    return element;
}

export function toggleInteractionDisclosure(entryId: string, root: ParentNode = document): HTMLDetailsElement {
    const summary = interactionElement(entryId, root);
    expect(summary.tagName).toBe("SUMMARY");
    const details = summary.closest("details");
    expect(details).toBeInstanceOf(HTMLDetailsElement);
    if (!(details instanceof HTMLDetailsElement)) throw new Error(`${entryId} is not owned by a details element`);
    expect(details.open).toBe(false);
    fireEvent.click(summary);
    expect(details.open).toBe(true);
    fireEvent.click(summary);
    expect(details.open).toBe(false);
    return details;
}

export function toggleFirstInteractionDisclosure(entryId: string, root: ParentNode = document): HTMLDetailsElement {
    const summary = root.querySelector<HTMLElement>(`[data-oaam-interaction-entry="${entryId}"]`);
    expect(summary, `${entryId} must resolve to at least one rendered interaction`).not.toBeNull();
    if (summary === null) throw new Error(`${entryId} did not resolve to a rendered interaction`);
    expect(summary.tagName).toBe("SUMMARY");
    const details = summary.closest("details");
    expect(details).toBeInstanceOf(HTMLDetailsElement);
    if (!(details instanceof HTMLDetailsElement)) throw new Error(`${entryId} is not owned by a details element`);
    expect(details.open).toBe(false);
    fireEvent.click(summary);
    expect(details.open).toBe(true);
    fireEvent.click(summary);
    expect(details.open).toBe(false);
    return details;
}

export function exercisePersistentInteractionSidebar(entryId: string, root: ParentNode = document): HTMLElement {
    const sidebar = interactionElement(entryId, root);
    expect(sidebar.tagName).toBe("ASIDE");
    expect(sidebar.dataset.oaamSidebarMode).toBe("persistent");
    expect(sidebar.hidden).toBe(false);
    fireEvent.keyDown(sidebar, { key: "Escape" });
    expect(sidebar.dataset.oaamSidebarMode).toBe("persistent");
    expect(sidebar.hidden).toBe(false);
    return sidebar;
}

export function exerciseKeyboardResize(entryId: string, root: ParentNode = document): HTMLElement {
    const separator = interactionElement(entryId, root);
    expect(separator.tagName).toBe("HR");
    expect(separator.getAttribute("aria-orientation")).toBe("vertical");
    const value = Number(separator.getAttribute("aria-valuenow"));
    const minimum = Number(separator.getAttribute("aria-valuemin"));
    const maximum = Number(separator.getAttribute("aria-valuemax"));
    expect(Number.isFinite(value) && Number.isFinite(minimum) && Number.isFinite(maximum)).toBe(true);
    const key = value === maximum ? "Home" : "End";
    const expected = key === "Home" ? minimum : maximum;
    fireEvent.keyDown(separator, { key });
    expect(Number(separator.getAttribute("aria-valuenow"))).toBe(expected);
    return separator;
}
