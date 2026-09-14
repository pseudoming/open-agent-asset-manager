import { selectedWslTargetTransactions } from "../../packages/core/src/deployment/selected-wsl-target-transaction";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it } from "vitest";
import { executeDeployment } from "../../packages/core/src/deployment/deployment-executor";
import { readJournal, scanJournals } from "../../packages/core/src/deployment/deployment-journal";
import { createRestrictedTargetChannel } from "../../packages/core/src/orchestration/restricted-target-channel";
import { createRestrictedTargetService } from "../../packages/core/src/orchestration/restricted-target-service";
import { getDeployment } from "../../packages/core/src/persistence/state-db";
import { createExecutorComparisonFixture } from "./fixtures/deployment-executor-comparison";
import { recoverRetainedExecutorCase, type RetainedExecutorRecoveryCase } from "./fixtures/deployment-executor-recovery";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const hash = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

it("reopens two original journals after actual lost write responses, restores one and refuses an independent third value", async () => {
    const cases: RetainedExecutorRecoveryCase[] = [];
    for (const mode of ["restore-old", "third-value"] as const) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-retained-recovery-"));
        roots.push(root);
        const h = await createExecutorComparisonFixture({
            stateRoot: path.join(root, "state"),
            targetRoot: path.join(root, "target"),
            schemaPath: path.resolve(__dirname, "../../packages/core/schema/schema.sql"),
            platform: "wsl",
            platformInstanceId: "test-selected",
        });
        let transactionId: string, committedTransactionId: string;
        const binding = {
            bindingId: crypto.randomUUID(),
            deploymentId: h.deploymentId,
            platformInstanceId: "test-selected",
            targetRootPath: path.join(root, "target"),
            executionRootPath: path.join(root, "target"),
        };
        const session = { hostInstanceId: crypto.randomUUID(), sessionId: crypto.randomUUID() };
        const service = createRestrictedTargetService({ ...session, bindings: [binding], deadlineAt: Date.now() + 60_000 });
        try {
            h.execute(await h.compile("# Old\n"), "# Old\n");
            committedTransactionId = getDeployment(h.db, h.deploymentId)!.committedTransactionId;
            let lostWriteResponses = 0;
            h.opts.targetExecution = selectedWslTargetTransactions(
                createRestrictedTargetChannel(session, (request) => {
                    const response = service.handle(request);
                    if (response.result.kind === "execute_graph" && response.result.step.kind === "executed") {
                        lostWriteResponses++;
                        throw new Error("response lost after real CAS");
                    }
                    return response;
                }).bind(binding),
            );
            expect(executeDeployment(h.opts, await h.compile("# New\n")).outcome).toBe("blocked");
            expect(lostWriteResponses).toBe(1);
            expect(fs.readFileSync(path.join(root, "target/AGENTS.md"), "utf8")).toBe("# New\n");
            [transactionId] = scanJournals(h.opts.transactionsRoot, h.deploymentId).matchingTxnIds;
            expect(readJournal(h.opts.transactionsRoot, transactionId!)).not.toBeNull();
        } finally {
            h.close();
        }
        cases.push({
            mode,
            stateRoot: path.join(root, "state"),
            ...binding,
            transactionId: transactionId!,
            committedTransactionId: committedTransactionId!,
            databaseSha256: hash(h.databasePath),
            journalSha256: hash(path.join(h.opts.transactionsRoot, transactionId!, "journal.json")),
            targetSha256: hash(path.join(root, "target/AGENTS.md")),
        });
    }
    const session = { hostInstanceId: crypto.randomUUID(), sessionId: crypto.randomUUID() };
    const bindings = cases.map(({ deploymentId, platformInstanceId, targetRootPath, executionRootPath }) => ({
        bindingId: crypto.randomUUID(),
        deploymentId,
        platformInstanceId,
        targetRootPath,
        executionRootPath,
    }));
    const service = createRestrictedTargetService({ ...session, bindings, deadlineAt: Date.now() + 60_000 });
    const channel = createRestrictedTargetChannel(session, (request) => service.handle(request));
    const restored = recoverRetainedExecutorCase(cases[0]!, channel.bind(bindings[0]!));
    const refused = recoverRetainedExecutorCase(cases[1]!, channel.bind(bindings[1]!));
    expect(restored.recovered.outcome).toBe("recovered_to_old");
    expect(refused.recovered.reasonCode).toBe("blocked_by_recovery_target_changed");
    expect(restored.transactionId).not.toBe(refused.transactionId);
});
