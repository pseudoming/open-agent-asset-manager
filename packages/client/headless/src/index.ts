#!/usr/bin/env node

export { parseHeadlessArguments, HeadlessConfigurationError } from "./config";
export type { HeadlessExitCode } from "./headless-session";
export { runHeadlessProcess } from "./run-headless";
export type { HeadlessProcessOptions } from "./run-headless";

if (require.main === module) {
    void import("./run-headless")
        .then(({ runHeadlessProcess }) =>
            runHeadlessProcess({
                argv: process.argv.slice(2),
                input: process.stdin,
                stdout: process.stdout,
                stderr: process.stderr,
            }),
        )
        .then(
            (exitCode) => {
                process.exitCode = exitCode;
            },
            () => {
                process.stderr.write("oaam-headless: fatal launcher failure\n");
                process.exitCode = 3;
            },
        );
}
