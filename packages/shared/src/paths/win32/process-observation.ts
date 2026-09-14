import {
    type LocalProcessExecutableIdentity,
    type LocalProcessObservation,
    validateLocalProcessExecutableObservationInput,
    validateLocalProcessObservationInput,
    validateLocalProcessTableEntryLimit,
} from "../path-environment";
import { loadWin32NativeFilesystemAddon, type Win32NativeFilesystemAddon } from "./native-addon";

type NativeLoader = () => Win32NativeFilesystemAddon;

export interface Win32LocalProcessObservationMechanics {
    readonly listLocalProcessIdsBounded: (maximumEntries: number) => number[];
    readonly listLocalProcessExecutableCandidateIdsBounded: (expectedExecutablePath: string, maximumEntries: number) => number[];
    readonly observeLocalProcessBounded: (
        processId: number,
        expectedExecutableIdentity: LocalProcessExecutableIdentity,
        maximumCommandLineBytes: number,
    ) => LocalProcessObservation | null;
    readonly observeLocalProcessExecutableBounded: (
        processId: number,
        expectedExecutablePath: string,
        expectedExecutableIdentity: LocalProcessExecutableIdentity,
        maximumCommandLineBytes: number,
    ) => LocalProcessObservation | null;
}

export function createWin32LocalProcessObservationMechanics(
    loadNative: NativeLoader = loadWin32NativeFilesystemAddon,
): Win32LocalProcessObservationMechanics {
    let native: Win32NativeFilesystemAddon | null = null;
    const getNative = (): Win32NativeFilesystemAddon => {
        native ??= loadNative();
        return native;
    };
    const mechanics: Win32LocalProcessObservationMechanics = {
        listLocalProcessIdsBounded(maximumEntries: number) {
            validateLocalProcessTableEntryLimit(maximumEntries);
            return getNative().listLocalProcessIdsBounded(maximumEntries);
        },
        listLocalProcessExecutableCandidateIdsBounded(expectedExecutablePath: string, maximumEntries: number) {
            validateLocalProcessExecutableObservationInput(expectedExecutablePath);
            validateLocalProcessTableEntryLimit(maximumEntries);
            return getNative().listLocalProcessExecutableCandidateIdsBounded(expectedExecutablePath, maximumEntries);
        },
        observeLocalProcessBounded(
            processId: number,
            expectedExecutableIdentity: LocalProcessExecutableIdentity,
            maximumCommandLineBytes: number,
        ) {
            validateLocalProcessObservationInput(processId, expectedExecutableIdentity, maximumCommandLineBytes);
            return getNative().observeLocalProcessBounded(processId, expectedExecutableIdentity, maximumCommandLineBytes);
        },
        observeLocalProcessExecutableBounded(
            processId: number,
            expectedExecutablePath: string,
            expectedExecutableIdentity: LocalProcessExecutableIdentity,
            maximumCommandLineBytes: number,
        ) {
            validateLocalProcessObservationInput(processId, expectedExecutableIdentity, maximumCommandLineBytes);
            validateLocalProcessExecutableObservationInput(expectedExecutablePath);
            return getNative().observeLocalProcessExecutableBounded(
                processId,
                expectedExecutablePath,
                expectedExecutableIdentity,
                maximumCommandLineBytes,
            );
        },
    };
    return Object.freeze(mechanics);
}

const mechanics = createWin32LocalProcessObservationMechanics();

export const listLocalProcessIdsBounded = mechanics.listLocalProcessIdsBounded;
export const listLocalProcessExecutableCandidateIdsBounded = mechanics.listLocalProcessExecutableCandidateIdsBounded;
export const observeLocalProcessBounded = mechanics.observeLocalProcessBounded;
export const observeLocalProcessExecutableBounded = mechanics.observeLocalProcessExecutableBounded;
