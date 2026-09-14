/** Serialized Target observations over an owned Linux tree; no actual WSL process is claimed. */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, vi } from "vitest";
import { sha256Bytes } from "../../../src/foundation/crypto-bytes";
import type { RestrictedTargetRequest, RestrictedTargetResponse } from "../../../src/deployment/restricted-target-contract";
import type { AssetUsageTargetExpectation } from "../../../src/orchestration/asset-usage-target-observation";
import { createRestrictedTargetChannel } from "../../../src/orchestration/restricted-target-channel";
import { createRestrictedTargetService } from "../../../src/orchestration/restricted-target-service";

const roots: string[] = [];
afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

export function usageExpectation(relativePath = "AGENTS.md", text = "# Current\n"): AssetUsageTargetExpectation {
    return {
        files: [
            { relativePath, contentHash: sha256Bytes(Buffer.from(text)), byteSize: Buffer.byteLength(text), executable: false },
        ],
        directoryBoundaries: [],
        sourceIdentityFingerprints: [],
    };
}

export function usageFixture(rewrite?: (response: RestrictedTargetResponse) => void) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-target-usage-"));
    roots.push(root);
    const target = path.join(root, "target");
    fs.mkdirSync(target);
    const binding = {
        kind: "asset_usage" as const,
        bindingId: randomUUID(),
        platformInstanceId: "usage-test",
        targetRootPath: `\\\\wsl.localhost\\usage-test${target.replaceAll("/", "\\")}`,
        executionRootPath: target,
    };
    const session = { hostInstanceId: randomUUID(), sessionId: randomUUID() };
    const service = createRestrictedTargetService({ ...session, bindings: [binding], deadlineAt: Date.now() + 60_000 });
    const requests: RestrictedTargetRequest[] = [];
    const channel = createRestrictedTargetChannel(session, (input) => {
        requests.push(structuredClone(input));
        const response = service.handle(JSON.parse(JSON.stringify(input)));
        rewrite?.(response);
        return JSON.parse(JSON.stringify(response));
    });
    return { root, target, binding, session, service, requests, channel, review: channel.bindUsage(binding).review };
}
