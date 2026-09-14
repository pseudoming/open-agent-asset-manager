import { fireEvent, waitFor } from "@testing-library/react";
import { expect } from "vitest";

interface SemanticActionSpy {
    readonly mock: {
        readonly calls: readonly (readonly unknown[])[];
    };
}

export interface SemanticActionReceiptOptions {
    readonly expected: SemanticActionSpy;
    readonly expectedArgs: readonly unknown[];
    readonly unrelated: readonly SemanticActionSpy[];
    readonly root?: Element | ParentNode;
}

export async function clickSemanticAction(
    entryId: string,
    actionId: string,
    options: SemanticActionReceiptOptions,
): Promise<HTMLElement> {
    const selector = `[data-oaam-semantic-entry="${entryId}"]`;
    const candidates =
        options.root instanceof Element && options.root.matches(selector)
            ? [options.root]
            : [...(options.root ?? document).querySelectorAll<HTMLElement>(selector)];
    expect(candidates, `${entryId} must resolve to one exact rendered control`).toHaveLength(1);
    const target = candidates[0];
    expect(target?.getAttribute("data-oaam-semantic-action")).toBe(actionId);

    const expectedBefore = options.expected.mock.calls.length;
    const unrelatedBefore = options.unrelated.map((spy) => spy.mock.calls.length);
    fireEvent.click(target as HTMLElement);
    await waitFor(() => expect(options.expected.mock.calls).toHaveLength(expectedBefore + 1));
    expect(options.expected.mock.calls.at(-1)).toEqual(options.expectedArgs);
    for (const [index, spy] of options.unrelated.entries()) {
        expect(spy.mock.calls).toHaveLength(unrelatedBefore[index]);
    }
    return target as HTMLElement;
}
