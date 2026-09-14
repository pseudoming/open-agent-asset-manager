export async function sendNativeKeyAndWait(webContents, keyCode, expectedStateSource, label, options = {}) {
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    const deadline = now() + (options.timeoutMs ?? 5_000);
    let observedKeyUp = false;
    const observeInput = (_event, input) => {
        if (input.type === "keyUp" && input.key === keyCode) observedKeyUp = true;
    };
    webContents.on("before-input-event", observeInput);
    try {
        webContents.focus();
        while (!webContents.isFocused() && now() < deadline) await sleep(25);
        if (!webContents.isFocused()) throw new Error(`${label}: renderer did not receive focus`);
        // sendInputEvent returns void; observing input arrival alone does not prove its DOM effect.
        webContents.sendInputEvent({ type: "keyDown", keyCode });
        webContents.sendInputEvent({ type: "keyUp", keyCode });
        while (now() < deadline) {
            if (observedKeyUp && (await webContents.executeJavaScript(expectedStateSource, true)) === true) return;
            await sleep(25);
        }
        throw new Error(`${label}: native ${keyCode} did not reach the expected state (keyUp=${String(observedKeyUp)})`);
    } finally {
        webContents.removeListener("before-input-event", observeInput);
    }
}
