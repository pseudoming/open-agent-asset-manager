export async function inspectRendererFailureCase(webContents, entry) {
    return webContents.executeJavaScript(
        `(${async function inspect(entryValue) {
            const deadline = performance.now() + 5000;
            const waitFor = async (predicate, label) => {
                while (performance.now() < deadline) {
                    const value = predicate();
                    if (value) return value;
                    await new Promise((resolve) => setTimeout(resolve, 25));
                }
                throw new Error(`timed out waiting for ${label}`);
            };
            const event = new Event("unhandledrejection", { cancelable: true });
            Object.defineProperty(event, "reason", { value: new Error("private actual-render fixture body") });
            const cancelled = !window.dispatchEvent(event);
            const fallback = await waitFor(
                () => document.querySelector("[data-oaam-renderer-failure-kind='unhandled_rejection']"),
                "renderer failure fallback",
            );
            if (!(fallback instanceof HTMLElement) || !cancelled) throw new Error(`${entryValue.id}: failure was not captured`);
            if (fallback.textContent?.includes("private actual-render fixture body")) {
                throw new Error(`${entryValue.id}: failure body escaped into the product UI`);
            }
            const reload = fallback.querySelector("button");
            if (!(reload instanceof HTMLButtonElement)) throw new Error(`${entryValue.id}: reload action is missing`);
            reload.click();
            await waitFor(
                () => document.documentElement.dataset.oaamWindowAction === "reload_interface",
                "bounded interface reload action",
            );
            await waitFor(() => document.querySelector("[data-oaam-renderer-failure]") === null, "recovered renderer");
            return {
                innerWidth,
                innerHeight,
                resolvedTheme: document.documentElement.dataset.oaamTheme,
                resolvedLocale: document.documentElement.lang,
                dialogInventory: JSON.parse(document.documentElement.dataset.oaamDialogInventory ?? "[]"),
                dialogStates: [],
                journeyStates: [],
                routeStates: [],
                surfaceInventory: JSON.parse(document.documentElement.dataset.oaamSurfaceInventory ?? "[]"),
            };
        }.toString()})(${JSON.stringify(entry)})`,
        true,
    );
}
