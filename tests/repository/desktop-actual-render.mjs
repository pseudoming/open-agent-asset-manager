#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveDesktopElectronExecutable } from "./desktop-electron-executable.mjs";
import { EXPECTED_ACTUAL_RENDER_CASE_COUNT, EXPECTED_ACTUAL_RENDER_SURFACE_GAPS } from "./desktop-actual-render-scenarios.mjs";

function fail(message) {
    throw new Error(message);
}

export function runDesktopActualRender(repositoryRoot = process.cwd(), options = {}) {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-desktop-actual-render-"));
    const outputRoot = path.join(temporaryRoot, "webview");
    const environment = {
        ...process.env,
        OAAM_ACTUAL_RENDER_OUTPUT: outputRoot,
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        TEMP: process.env.TEMP ?? "/tmp",
        TMP: process.env.TMP ?? "/tmp",
        ELECTRON_DISABLE_SANDBOX: "1",
    };
    try {
        const vite = path.join(repositoryRoot, "packages", "client", "desktop", "node_modules", "vite", "bin", "vite.js");
        const configuration = path.join(
            repositoryRoot,
            "tests",
            "repository",
            "fixtures",
            "desktop-actual-render.vite.config.mjs",
        );
        const built = (options.spawn ?? spawnSync)(process.execPath, [vite, "build", "--config", configuration], {
            cwd: repositoryRoot,
            env: environment,
            encoding: "utf8",
            stdio: options.capture === true ? "pipe" : "inherit",
            timeout: 120_000,
        });
        if (built.status !== 0) fail(`actual-render Vite build failed with ${String(built.status)}`);

        const electron = resolveDesktopElectronExecutable(repositoryRoot, { env: environment });
        const main = path.join(repositoryRoot, "tests", "repository", "fixtures", "desktop-actual-render-main.mjs");
        const profileArgument = `--user-data-dir=${path.join(temporaryRoot, "profile")}`;
        const invocation =
            process.platform === "linux"
                ? [
                      "xvfb-run",
                      [
                          "-a",
                          "-s",
                          "-screen 0 4096x2304x24",
                          electron,
                          "--no-sandbox",
                          "--disable-setuid-sandbox",
                          profileArgument,
                          main,
                      ],
                  ]
                : [electron, [profileArgument, main]];
        const rendered = (options.spawn ?? spawnSync)(invocation[0], invocation[1], {
            cwd: repositoryRoot,
            env: environment,
            encoding: "utf8",
            stdio: "pipe",
            timeout: 180_000,
        });
        if (options.capture !== true) {
            if (rendered.stdout) process.stdout.write(rendered.stdout);
            if (rendered.stderr) process.stderr.write(rendered.stderr);
        }
        if (rendered.status !== 0) fail(`actual Electron renderer verification failed with ${String(rendered.status)}`);
        const marker = /^OAAM_ACTUAL_RENDER verified=(\d+)$/mu.exec(rendered.stdout ?? "");
        if (marker?.[1] === undefined) fail("actual Electron renderer did not report a verified case count");
        const caseCount = Number.parseInt(marker[1], 10);
        if (!Number.isSafeInteger(caseCount) || caseCount <= 0) {
            fail(`actual Electron renderer reported an invalid case count: ${marker[1]}`);
        }
        if (caseCount !== EXPECTED_ACTUAL_RENDER_CASE_COUNT) {
            fail(
                `actual Electron renderer verified ${String(caseCount)} cases; expected ${String(EXPECTED_ACTUAL_RENDER_CASE_COUNT)}`,
            );
        }
        const gapMarker = /^OAAM_ACTUAL_RENDER surface_gaps=([^\r\n]+)$/mu.exec(rendered.stdout ?? "");
        if (gapMarker?.[1] === undefined) fail("actual Electron renderer did not report reviewed surface gaps");
        const surfaceGaps = gapMarker[1] === "none" ? [] : gapMarker[1].split(",").sort();
        if (JSON.stringify(surfaceGaps) !== JSON.stringify([...EXPECTED_ACTUAL_RENDER_SURFACE_GAPS].sort())) {
            fail(
                `actual Electron renderer reported surface gaps ${JSON.stringify(surfaceGaps)}; expected ` +
                    JSON.stringify(EXPECTED_ACTUAL_RENDER_SURFACE_GAPS),
            );
        }
        const dialogGapMarker = /^OAAM_ACTUAL_RENDER dialog_gaps=([^\r\n]+)$/mu.exec(rendered.stdout ?? "");
        if (dialogGapMarker?.[1] === undefined) fail("actual Electron renderer did not report reviewed dialog gaps");
        const dialogGaps = dialogGapMarker[1] === "none" ? [] : dialogGapMarker[1].split(",").sort();
        if (dialogGaps.length !== 0) {
            fail(`actual Electron renderer reported dialog gaps ${JSON.stringify(dialogGaps)}`);
        }
        const journeyStateGapMarker = /^OAAM_ACTUAL_RENDER journey_state_gaps=([^\r\n]+)$/mu.exec(rendered.stdout ?? "");
        if (journeyStateGapMarker?.[1] === undefined) {
            fail("actual Electron renderer did not report reviewed journey-state gaps");
        }
        const journeyStateGaps = journeyStateGapMarker[1] === "none" ? [] : journeyStateGapMarker[1].split(",").sort();
        if (journeyStateGaps.length !== 0) {
            fail(`actual Electron renderer reported journey-state gaps ${JSON.stringify(journeyStateGaps)}`);
        }
        return Object.freeze({
            caseCount,
            dialogGaps: Object.freeze(dialogGaps),
            journeyStateGaps: Object.freeze(journeyStateGaps),
            surfaceGaps: Object.freeze(surfaceGaps),
        });
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(path.resolve(process.argv[1])).href;
if (import.meta.url === invokedPath) {
    try {
        runDesktopActualRender();
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
