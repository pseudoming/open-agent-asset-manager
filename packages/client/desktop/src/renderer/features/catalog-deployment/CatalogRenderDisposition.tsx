import { useDesktopPresentation } from "../../presentation";
import type { RenderAnalysisView, RenderOptionView, RenderSemanticView } from "./catalog-deployment-model";
import { presentClaudeExactFileDisposition } from "./render-review-presentation";

type BlockedSemanticView = RenderAnalysisView["blockedSemantics"][number];

export type CatalogRenderDispositionProps =
    | {
          readonly semantic: RenderSemanticView;
          readonly option: RenderOptionView;
          readonly blocked?: never;
      }
    | {
          readonly semantic: RenderSemanticView;
          readonly option?: never;
          readonly blocked: BlockedSemanticView;
      };

export function CatalogRenderDisposition(props: CatalogRenderDispositionProps): React.JSX.Element | null {
    const { text } = useDesktopPresentation();
    const presentation = presentClaudeExactFileDisposition(
        props.semantic,
        props.option === undefined
            ? { state: "blocked", reasonCode: props.blocked.reasonCode }
            : { state: "option", option: props.option },
    );
    if (presentation === undefined) return null;
    return (
        <div className="render-disposition" data-oaam-render-disposition={presentation.state}>
            <strong>{text(presentation.title)}</strong>
            <p>{text(presentation.detail)}</p>
            {presentation.boundary === undefined ? null : <p>{text(presentation.boundary)}</p>}
        </div>
    );
}
