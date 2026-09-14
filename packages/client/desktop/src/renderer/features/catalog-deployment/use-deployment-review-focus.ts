import { useLayoutEffect, useRef, useState } from "react";

type ReviewFocusRequest = { kind: "review" } | { kind: "preview"; deploymentId: string };

/** Bring a user-selected review into view once; background updates never request focus. */
export function useDeploymentReviewFocus() {
    const workspaceRef = useRef<HTMLDivElement>(null);
    const [request, setRequest] = useState<ReviewFocusRequest>();
    useLayoutEffect(() => {
        if (request === undefined) return;
        const frame = requestAnimationFrame(() => {
            const review =
                request.kind === "preview"
                    ? Array.from(workspaceRef.current?.querySelectorAll<HTMLElement>("[data-oaam-preview-result]") ?? []).find(
                          (element) => element.dataset.oaamPreviewResult === request.deploymentId,
                      )
                    : workspaceRef.current?.querySelector<HTMLElement>(
                          '[data-oaam-version-update], [data-oaam-deployment-step="review"]',
                      );
            if (review === null || review === undefined) return;
            review.tabIndex = -1;
            review.focus({ preventScroll: true });
            const bounds = review.getBoundingClientRect();
            if (bounds.top < 0 || bounds.bottom > window.innerHeight) review.scrollIntoView({ block: "start" });
        });
        return () => cancelAnimationFrame(frame);
    }, [request]);
    return {
        workspaceRef,
        requestReviewFocus: () => setRequest({ kind: "review" }),
        requestPreviewFocus: (deploymentId: string) => setRequest({ kind: "preview", deploymentId }),
    };
}
