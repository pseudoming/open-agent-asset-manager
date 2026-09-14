import { ordinaryLanguageRendererArguments } from "./desktop-actual-render-language.mjs";

function trace(message) {
    if (process.env.OAAM_ACTUAL_RENDER_TRACE === "1") process.stdout.write(`OAAM_ACTUAL_RENDER_TRACE ${message}\n`);
}

async function inspectSurfaceLoadingFallback(debuggerApi, entry) {
    const evaluation = await debuggerApi.sendCommand("Runtime.evaluate", {
        expression: `(${async function inspectFallback(
            entryValue,
            assertOrdinarySurfaceLanguage,
            ordinarySurfaceLanguageLexicon,
        ) {
            const deadline = performance.now() + 10_000;
            let surface;
            while (performance.now() < deadline) {
                surface = document.querySelector("[data-oaam-route='startup'][data-oaam-state='surface_loading']");
                if (surface !== null) break;
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            if (!(surface instanceof HTMLElement)) {
                throw new Error(`${entryValue.id}: real Suspense fallback did not render while WorkspacePage was paused`);
            }
            if (surface.getAttribute("aria-busy") !== "true") {
                throw new Error(`${entryValue.id}: real Suspense fallback is not exposed as busy`);
            }
            assertOrdinarySurfaceLanguage(surface, "real Suspense fallback", entryValue.id, ordinarySurfaceLanguageLexicon);
            return true;
        }.toString()})(${JSON.stringify(entry)}, ${ordinaryLanguageRendererArguments()})`,
        awaitPromise: true,
        returnByValue: true,
    });
    if (evaluation.exceptionDetails !== undefined || evaluation.result?.value !== true) {
        throw new Error(
            `${entry.id}: DevTools could not inspect the live Suspense fallback: ` +
                String(evaluation.exceptionDetails?.exception?.description ?? evaluation.exceptionDetails?.text ?? "unknown"),
        );
    }
}

async function inspectSurfaceLoadingCompletion(webContents, entry) {
    return webContents.executeJavaScript(
        `(${async function inspectCompletion(entryValue) {
            const deadline = performance.now() + 10_000;
            let library;
            while (performance.now() < deadline) {
                library = document.querySelector("[data-oaam-route='library'][data-oaam-state='ready']");
                if (library !== null) break;
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            if (!(library instanceof HTMLElement)) {
                throw new Error(`${entryValue.id}: library did not replace the released Suspense fallback`);
            }
            if (document.querySelector("[data-oaam-route='startup'][data-oaam-state='surface_loading']") !== null) {
                throw new Error(`${entryValue.id}: released Suspense fallback remained visible beside the library`);
            }
            return {
                innerWidth,
                innerHeight,
                resolvedTheme: document.documentElement.dataset.oaamTheme,
                resolvedLocale: document.documentElement.lang,
                dialogInventory: JSON.parse(document.documentElement.dataset.oaamDialogInventory ?? "[]"),
                dialogStates: [],
                journeyStates: ["host_startup_and_recovery:surface_loading"],
                routeStates: ["startup:surface_loading", "library:ready"],
                surfaceInventory: JSON.parse(document.documentElement.dataset.oaamSurfaceInventory ?? "[]"),
            };
        }.toString()})(${JSON.stringify(entry)})`,
        true,
    );
}

export async function loadAndInspectSurfaceLoading(browserWindow, url, entry) {
    const debuggerApi = browserWindow.webContents.debugger;
    let pausedRequestId;
    let requestContinued = false;
    let removeListener = () => undefined;
    let loadPromise;
    try {
        const paused = new Promise((resolve, reject) => {
            const timeout = setTimeout(
                () => reject(new Error(`${entry.id}: WorkspacePage chunk was not paused by Electron DevTools`)),
                10_000,
            );
            const listener = (_event, method, parameters) => {
                if (method !== "Fetch.requestPaused") return;
                clearTimeout(timeout);
                debuggerApi.removeListener("message", listener);
                pausedRequestId = parameters.requestId;
                trace(`${entry.id} paused ${String(parameters?.request?.url)}`);
                resolve(parameters);
            };
            removeListener = () => {
                clearTimeout(timeout);
                debuggerApi.removeListener("message", listener);
            };
            debuggerApi.on("message", listener);
        });
        trace(`${entry.id} enabling WorkspacePage interception`);
        await debuggerApi.sendCommand("Fetch.enable", {
            patterns: [{ urlPattern: "*WorkspacePage-*.js", resourceType: "Script", requestStage: "Request" }],
        });
        trace(`${entry.id} WorkspacePage interception enabled`);
        loadPromise = browserWindow.loadURL(url.href);
        await paused;
        trace(`${entry.id} WorkspacePage paused`);
        browserWindow.webContents.setZoomFactor(entry.deviceScaleFactor);
        await inspectSurfaceLoadingFallback(debuggerApi, entry);
        trace(`${entry.id} fallback observed`);
        await debuggerApi.sendCommand("Fetch.continueRequest", { requestId: pausedRequestId });
        requestContinued = true;
        trace(`${entry.id} WorkspacePage released`);
        await loadPromise;
        trace(`${entry.id} load completed`);
        return await inspectSurfaceLoadingCompletion(browserWindow.webContents, entry);
    } finally {
        removeListener();
        if (pausedRequestId !== undefined && !requestContinued) {
            await debuggerApi.sendCommand("Fetch.continueRequest", { requestId: pausedRequestId }).catch(() => undefined);
        }
        await debuggerApi.sendCommand("Fetch.disable").catch(() => undefined);
        void loadPromise?.catch(() => undefined);
    }
}
