import type { ClientConnectionApi } from "@oaam/client-framework";
import { expect, vi } from "vitest";
import {
    PACKAGED_ZCODE_TARGET_PROOF_PORT_SIGNAL,
    type PackagedProofSubjectIdentity,
    type PackagedZcodeTargetProofRequest,
} from "../src/bridge/desktop-bridge";
import type { BrowserProtocolPort } from "../src/renderer/client";
import { installPackagedZcodeTargetProofListener } from "../src/renderer/client/packaged-zcode-target-proof";

export async function expectPackagedZcodeTargetListenerProtocol(options: {
    readonly createReverseConnection: () => ClientConnectionApi;
    readonly createBrowserPort: () => BrowserProtocolPort;
    readonly reverseRequest: Extract<PackagedZcodeTargetProofRequest, { readonly mode: "reverse" }>;
    readonly reversedSubject: PackagedProofSubjectIdentity;
}): Promise<void> {
    const listeners: Array<(event: MessageEvent<unknown>) => void> = [];
    const browserWindow = {
        addEventListener: vi.fn((_type: string, listener: (event: MessageEvent<unknown>) => void) => listeners.push(listener)),
        removeEventListener: vi.fn(),
    } as unknown as Window;
    const dispose = installPackagedZcodeTargetProofListener(
        browserWindow,
        vi.fn(() => options.createReverseConnection()),
        () => "request",
    );
    const receive = listeners[0];
    if (receive === undefined) throw new Error("listener was not installed");
    receive(new MessageEvent("message", { data: null }));
    receive(new MessageEvent("message", { data: { signal: "other" } }));

    const extraPort = { close: vi.fn() };
    receive({
        source: browserWindow,
        data: { signal: PACKAGED_ZCODE_TARGET_PROOF_PORT_SIGNAL },
        ports: [extraPort],
    } as unknown as MessageEvent<unknown>);
    expect(extraPort.close).toHaveBeenCalledOnce();

    const protocolPort = options.createBrowserPort();
    const resultPort = { postMessage: vi.fn(), close: vi.fn() };
    receive({
        source: browserWindow,
        data: { signal: PACKAGED_ZCODE_TARGET_PROOF_PORT_SIGNAL, request: { mode: "invalid" } },
        ports: [protocolPort, resultPort],
    } as unknown as MessageEvent<unknown>);
    await vi.waitFor(() =>
        expect(resultPort.postMessage).toHaveBeenCalledWith({ status: "failed", step: "unexpected", diagnosticCodes: [] }),
    );
    expect(resultPort.close).toHaveBeenCalledOnce();

    const successProtocolPort = options.createBrowserPort();
    const successResultPort = { postMessage: vi.fn(), close: vi.fn() };
    receive({
        source: browserWindow,
        data: { signal: PACKAGED_ZCODE_TARGET_PROOF_PORT_SIGNAL, request: options.reverseRequest },
        ports: [successProtocolPort, successResultPort],
    } as unknown as MessageEvent<unknown>);
    await vi.waitFor(() =>
        expect(successResultPort.postMessage).toHaveBeenCalledWith({
            status: "complete",
            subject: options.reversedSubject,
        }),
    );
    expect(successResultPort.close).toHaveBeenCalledOnce();
    dispose();
    expect(browserWindow.removeEventListener).toHaveBeenCalledOnce();
}
