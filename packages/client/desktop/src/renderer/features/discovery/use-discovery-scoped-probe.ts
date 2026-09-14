import { useCallback, useRef, useState } from "react";
import type { DiscoveryController } from "./discovery-controller";
import type { DiscoveryWorkspaceProps } from "./discovery-workspace-model";

interface DiscoveryScopedProbeInput {
    readonly controller: DiscoveryController;
    readonly targetProjectId: string | undefined;
    readonly preferredProjectId: string | undefined;
    readonly authorizeRegisteredProjectRoot: DiscoveryWorkspaceProps["authorizeRegisteredProjectRoot"];
}

export function useDiscoveryScopedProbe({
    controller,
    targetProjectId,
    preferredProjectId,
    authorizeRegisteredProjectRoot,
}: DiscoveryScopedProbeInput): {
    readonly probeCurrentScope: () => Promise<boolean>;
    readonly projectProbeAuthorizationPending: boolean;
    readonly registeredProjectAccessFailed: boolean;
} {
    const authorizationLock = useRef(false);
    const [projectProbeAuthorizationPending, setProjectProbeAuthorizationPending] = useState(false);
    const [registeredProjectAccessFailed, setRegisteredProjectAccessFailed] = useState(false);
    const probeCurrentScope = useCallback(async (): Promise<boolean> => {
        const projectProbeId =
            targetProjectId ??
            (preferredProjectId !== undefined && controller.projectMatchesCurrentSelection(preferredProjectId)
                ? preferredProjectId
                : undefined);
        if (projectProbeId === undefined) return controller.probe();
        if (authorizationLock.current) return false;
        authorizationLock.current = true;
        setProjectProbeAuthorizationPending(true);
        setRegisteredProjectAccessFailed(false);
        try {
            if (authorizeRegisteredProjectRoot === undefined) {
                setRegisteredProjectAccessFailed(true);
                return false;
            }
            const authorization = await authorizeRegisteredProjectRoot(projectProbeId);
            if (authorization.status !== "authorized") {
                setRegisteredProjectAccessFailed(true);
                return false;
            }
            return controller.probeProject(authorization.localPathSelectionToken);
        } catch {
            setRegisteredProjectAccessFailed(true);
            return false;
        } finally {
            authorizationLock.current = false;
            setProjectProbeAuthorizationPending(false);
        }
    }, [authorizeRegisteredProjectRoot, controller, preferredProjectId, targetProjectId]);
    return { probeCurrentScope, projectProbeAuthorizationPending, registeredProjectAccessFailed };
}
