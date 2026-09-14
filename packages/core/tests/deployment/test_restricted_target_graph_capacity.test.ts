/** Real wire/graph preparation must retain the ordinary local capacity for reviewed resource bytes. */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it } from "vitest";
import { captureDeploymentPreWritePreview } from "../../src/deployment/deployment-prewrite-preview";
import { buildDeployEntries, populateOldBytes } from "../../src/deployment/deployment-target-entries";
import { createTargetIo } from "../../src/deployment/deployment-target-io";
import { applyRuntimeReplacementAuthority } from "../../src/deployment/deployment-target-replacement";
import { preflightExecutableTransitions } from "../../src/deployment/deployment-target-cas";
import { encodeRestrictedGraphPreparation } from "../../src/deployment/restricted-target-graph-codec";
import { RESTRICTED_TARGET_MAX_FRAME_BYTES } from "../../src/deployment/restricted-target-contract";
import { createRestrictedTargetChannel } from "../../src/orchestration/restricted-target-channel";
import { createRestrictedTargetService } from "../../src/orchestration/restricted-target-service";
import { sha256Bytes } from "../../src/foundation/crypto-bytes";
import type { TargetPlan } from "../../src/deployment/deployment-target-plan";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it("prepares a reviewed one-MiB Skill resource through the real channel at the ordinary local capacity", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-restricted-graph-capacity-"));
    roots.push(root);
    const target = path.join(root, "target");
    fs.mkdirSync(path.join(target, "skill/resources"), { recursive: true });
    const entryText = "# Complete Skill\n";
    const current = Buffer.alloc(1024 * 1024, 97);
    const desired = Buffer.alloc(1024 * 1024, 98);
    fs.writeFileSync(path.join(target, "skill/SKILL.md"), entryText);
    fs.writeFileSync(path.join(target, "skill/resources/data.txt"), current);
    const fingerprint = sha256Bytes(Buffer.from("large resource review"));
    const deploymentId = randomUUID();
    const directories = ["skill", "skill/resources"];
    const targetPlan: TargetPlan = {
        schemaVersion: 1,
        targetFiles: [
            { relativePath: "skill/SKILL.md", text: entryText },
            { relativePath: "skill/resources/data.txt", text: desired.toString("utf8") },
        ].map((file) => ({
            relativePath: file.relativePath,
            content: { contentKind: "text", text: file.text },
            executable: false,
            outputUnitFingerprint: fingerprint,
            materializationFingerprint: fingerprint,
            semanticRefFingerprints: [fingerprint],
            sectionBindings: [],
        })),
        managedDirectoryBoundaries: [
            { relativePath: "skill", outputUnitFingerprint: fingerprint, desiredDirectoryPaths: directories },
        ],
    };
    const preview = captureDeploymentPreWritePreview({
        deploymentId,
        targetRootPath: target,
        targetPlan,
        baseline: [],
        renderInputFingerprint: fingerprint,
        selectionFingerprint: fingerprint,
        compilationFingerprint: fingerprint,
    });
    const input = {
        publicationTransactionId: randomUUID(),
        compilationFingerprint: fingerprint,
        entries: buildDeployEntries(targetPlan, new Map()).map((entry) => ({
            ...entry,
            newProvenanceFingerprint: fingerprint,
            newMaterializationFingerprint: fingerprint,
        })),
        managedDirectoryBoundaries: ["skill"],
        desiredDirectoryPaths: directories,
        runtimeReplacementAuthority: preview.runtimeReplacementAuthority,
    };
    const localEntries = structuredClone(input.entries);
    const io = createTargetIo(target);
    expect(populateOldBytes(localEntries, io).kind).toBe("ok");
    expect(applyRuntimeReplacementAuthority(localEntries, io, preview.runtimeReplacementAuthority, directories).status).not.toBe(
        "conflict",
    );
    expect(preflightExecutableTransitions(localEntries, io)).toBeNull();

    const wire = encodeRestrictedGraphPreparation(input);
    expect(Buffer.byteLength(JSON.stringify(wire))).toBeLessThan(RESTRICTED_TARGET_MAX_FRAME_BYTES - 16_384);
    const binding = {
        bindingId: randomUUID(),
        deploymentId,
        platformInstanceId: "capacity-fixture",
        targetRootPath: target,
        executionRootPath: target,
    };
    const session = { hostInstanceId: randomUUID(), sessionId: randomUUID() };
    const service = createRestrictedTargetService({ ...session, deadlineAt: Date.now() + 30_000, bindings: [binding] });
    let transmitted = false;
    const channel = createRestrictedTargetChannel(session, (request) => {
        const encoded = JSON.stringify(request);
        expect(Buffer.byteLength(encoded)).toBeLessThan(RESTRICTED_TARGET_MAX_FRAME_BYTES);
        transmitted = true;
        const response = service.handle(JSON.parse(encoded));
        expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(RESTRICTED_TARGET_MAX_FRAME_BYTES);
        return JSON.parse(JSON.stringify(response));
    });
    const result = channel.bind(binding).graph!.prepare(input);
    expect(transmitted).toBe(true);
    expect(result.outcome).toBe("ready");
    if (result.outcome !== "ready") throw new Error("real wire preparation was rejected");
    expect(result.prepared.entries).toEqual(
        localEntries.map((entry) => ({ ...entry, entryAuthority: entry.entryAuthority ?? "managed_baseline" })),
    );
    expect(fs.readFileSync(path.join(target, "skill/resources/data.txt"))).toEqual(current);
});
