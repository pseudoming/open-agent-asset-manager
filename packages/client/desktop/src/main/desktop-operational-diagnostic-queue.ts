import type { DesktopHostControlCommand } from "../process/control-protocol";

type DesktopOperationalDiagnosticCommand = Extract<DesktopHostControlCommand, { readonly type: "record_operational_diagnostic" }>;

interface DesktopOperationalDiagnosticOwner {
    postMessage(message: DesktopHostControlCommand): void;
}

const MAXIMUM_PENDING_OPERATIONAL_DIAGNOSTICS = 32;

export class DesktopOperationalDiagnosticQueue {
    readonly #pending: DesktopOperationalDiagnosticCommand[] = [];

    public record(owner: DesktopOperationalDiagnosticOwner | undefined, command: DesktopOperationalDiagnosticCommand): void {
        if (owner === undefined) {
            if (this.#pending.length === MAXIMUM_PENDING_OPERATIONAL_DIAGNOSTICS) this.#pending.shift();
            this.#pending.push(command);
            return;
        }
        const pending = this.#pending.splice(0);
        for (const queued of pending) this.#deliver(owner, queued);
        this.#deliver(owner, command);
    }

    #deliver(owner: DesktopOperationalDiagnosticOwner, command: DesktopOperationalDiagnosticCommand): void {
        try {
            owner.postMessage(command);
        } catch {
            // Diagnostic delivery is best effort and cannot change supervisor lifecycle.
        }
    }
}
