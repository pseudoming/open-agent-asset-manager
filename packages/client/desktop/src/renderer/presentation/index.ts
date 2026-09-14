export type { DesktopMessageId } from "../../presentation/localization";
export { localizedText, technicalText } from "../../presentation/localization";
export type { DesktopDisplayText, DesktopMessageValues } from "./PresentationContext";
export {
    DesktopPresentationProvider,
    formatDesktopMessage,
    useDesktopPresentation,
} from "./PresentationContext";
export { PresentationPreferences } from "./PresentationPreferences";
export { ProtocolDiagnostics, type ProtocolDiagnosticsProps, ProtocolFeedbackNotice } from "./ProtocolDiagnostics";
export {
    mergeNonInformationalProtocolDiagnostics,
    nonInformationalProtocolDiagnostics,
    type ProtocolDiagnosticPresentation,
    type ProtocolFeedback,
    presentProtocolDiagnostic,
    protocolDiagnosticIdentity,
    protocolFeedback,
    uniqueProtocolDiagnostics,
} from "./protocol-diagnostics";
export { type DesktopPaneWidthController, type DesktopPaneWidths, useDesktopPaneWidths } from "./useDesktopPaneWidths";
