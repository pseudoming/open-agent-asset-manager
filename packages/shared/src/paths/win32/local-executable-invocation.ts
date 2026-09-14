import {
    type LocalExecutableEnvironmentEntry,
    type LocalExecutableTreeInvocationResult,
    type LocalProcessExecutableIdentity,
    validateLocalExecutableTreeInvocationInput,
} from "../path-environment";
import { invokeLocalExecutableInWorker } from "./local-executable-worker-client";
import { loadWin32NativeFilesystemAddon, type Win32NativeFilesystemAddon } from "./native-addon";

type NativeLoader = () => Win32NativeFilesystemAddon;

export interface Win32LocalExecutableInvocationMechanics {
    readonly invokeLocalExecutableTreeBounded: (
        executablePath: string,
        expectedExecutableIdentity: LocalProcessExecutableIdentity,
        arguments_: readonly string[],
        workingDirectory: string,
        environmentEntries: readonly LocalExecutableEnvironmentEntry[],
        invocationToken: string,
        timeoutMilliseconds: number,
        maximumOutputBytes: number,
    ) => Promise<LocalExecutableTreeInvocationResult>;
}

export function createWin32LocalExecutableInvocationMechanics(
    loadNative: NativeLoader = loadWin32NativeFilesystemAddon,
): Win32LocalExecutableInvocationMechanics {
    let native: Win32NativeFilesystemAddon | null = null;
    const getNative = (): Win32NativeFilesystemAddon => {
        native ??= loadNative();
        return native;
    };
    const mechanics: Win32LocalExecutableInvocationMechanics = {
        async invokeLocalExecutableTreeBounded(
            executablePath,
            expectedExecutableIdentity,
            arguments_,
            workingDirectory,
            environmentEntries,
            invocationToken,
            timeoutMilliseconds,
            maximumOutputBytes,
        ) {
            validateLocalExecutableTreeInvocationInput(
                executablePath,
                expectedExecutableIdentity,
                arguments_,
                workingDirectory,
                environmentEntries,
                invocationToken,
                timeoutMilliseconds,
                maximumOutputBytes,
            );
            return getNative().invokeLocalExecutableTreeBounded(
                executablePath,
                expectedExecutableIdentity,
                arguments_,
                workingDirectory,
                environmentEntries,
                invocationToken,
                timeoutMilliseconds,
                maximumOutputBytes,
            );
        },
    };
    return Object.freeze(mechanics);
}

export const invokeLocalExecutableTreeBounded: Win32LocalExecutableInvocationMechanics["invokeLocalExecutableTreeBounded"] = (
    ...input
) => invokeLocalExecutableInWorker(input);
