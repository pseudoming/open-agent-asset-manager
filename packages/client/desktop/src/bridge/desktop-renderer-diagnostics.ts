import {
    type ProtocolDesktopRendererDiagnosticInputV1,
    protocolDesktopRendererDiagnosticInputSchema,
} from "@oaam/app-server-protocol";

export const RENDERER_DIAGNOSTIC_CHANNEL = "oaam:desktop-renderer-diagnostic";

export type DesktopRendererDiagnosticInput = ProtocolDesktopRendererDiagnosticInputV1;

export function parseDesktopRendererDiagnosticInput(value: unknown): DesktopRendererDiagnosticInput {
    return protocolDesktopRendererDiagnosticInputSchema.parse(value);
}
