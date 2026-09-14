import * as crypto from "node:crypto";
import type { Writable } from "node:stream";
import { launchProductionHost, type ProductionHostLaunchOptions } from "@oaam/app-server-bootstrap";
import type { ProductionHost } from "@oaam/app-server-host";
import { createClientConnection } from "@oaam/client-framework";
import { parseHeadlessArguments } from "./config";
import { HeadlessChannelError, type HeadlessExitCode, HeadlessInputError, HeadlessProtocolSession } from "./headless-session";
import { InProcessHostTransport } from "./in-process-transport";
import { HeadlessNdjsonError, readBoundedNdjsonLines, SerializedProtocolWriter } from "./ndjson";

export interface HeadlessProcessOptions {
    readonly argv: readonly string[];
    readonly input: AsyncIterable<Uint8Array | string>;
    readonly stdout: Writable;
    readonly stderr: Writable;
}

/** @internal Injectable process boundary used by the Headless fault-injection tests. */
export interface HeadlessProcessDependencies {
    readonly launchHost: (options: ProductionHostLaunchOptions) => ProductionHost;
    readonly createRequestId: () => string;
}

const DEFAULT_DEPENDENCIES: HeadlessProcessDependencies = Object.freeze({
    launchHost: launchProductionHost,
    createRequestId: () => crypto.randomUUID(),
});

async function writeDiagnostic(stderr: Writable, message: string): Promise<void> {
    if (Buffer.byteLength(message, "utf8") > 256) throw new RangeError("Headless diagnostic exceeded its fixed bound");
    await new Promise<void>((resolve, reject) => {
        try {
            stderr.write(`${message}\n`, "utf8", (error) => {
                if (error === null || error === undefined) resolve();
                else reject(error);
            });
        } catch (error) {
            reject(error);
        }
    });
}

/** @internal Verifies the same bounded diagnostic writer used by the process entry. */
export async function writeHeadlessDiagnosticForTest(stderr: Writable, message: string): Promise<void> {
    await writeDiagnostic(stderr, message);
}

async function safeDiagnostic(stderr: Writable, message: string): Promise<boolean> {
    try {
        await writeDiagnostic(stderr, message);
        return true;
    } catch {
        return false;
    }
}

export async function runHeadlessProcess(
    options: HeadlessProcessOptions,
    dependencies: HeadlessProcessDependencies = DEFAULT_DEPENDENCIES,
): Promise<HeadlessExitCode> {
    let launchOptions: ProductionHostLaunchOptions;
    try {
        launchOptions = parseHeadlessArguments(options.argv);
    } catch {
        return (await safeDiagnostic(options.stderr, "oaam-headless: invalid launch configuration")) ? 2 : 3;
    }

    let host: ProductionHost;
    try {
        host = dependencies.launchHost(launchOptions);
    } catch {
        await safeDiagnostic(options.stderr, "oaam-headless: Host startup failed");
        return 3;
    }

    const transport = new InProcessHostTransport(host);
    const client = createClientConnection(transport, {
        createRequestId: dependencies.createRequestId,
        reportListenerError: transport.close.bind(transport),
    });
    const writer = new SerializedProtocolWriter(options.stdout);
    const session = new HeadlessProtocolSession(client, writer);
    let processExit: HeadlessExitCode = 0;
    try {
        for await (const line of readBoundedNdjsonLines(options.input)) {
            await session.acceptLine(line);
        }
        processExit = await session.finish();
    } catch (error) {
        if (error instanceof HeadlessInputError || error instanceof HeadlessNdjsonError) {
            processExit = 2;
            if (!(await safeDiagnostic(options.stderr, "oaam-headless: invalid Protocol input"))) processExit = 3;
        } else {
            processExit = 3;
            await safeDiagnostic(
                options.stderr,
                error instanceof HeadlessChannelError
                    ? "oaam-headless: Host channel unavailable"
                    : "oaam-headless: transport delivery uncertain",
            );
        }
        try {
            const completedExit = await session.finish();
            if (completedExit > processExit) processExit = completedExit;
        } catch {
            processExit = 3;
        }
    } finally {
        session.close();
        transport.close();
        try {
            await host.shutdown();
        } catch {
            processExit = 3;
            await safeDiagnostic(options.stderr, "oaam-headless: Host shutdown failed");
        }
    }
    return processExit;
}
