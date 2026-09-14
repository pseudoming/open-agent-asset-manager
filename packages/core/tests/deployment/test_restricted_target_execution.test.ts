import { selectedWslTargetTransactions } from "../../src/deployment/selected-wsl-target-transaction";
import { localTargetTransactions } from "../../src/deployment/local-target-transaction";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExecutorComparisonFixture } from "../../../../tests/repository/fixtures/deployment-executor-comparison";
import { executeDeployment, executeDeploymentForTest } from "../../src/deployment/deployment-executor";
import { recoverDeployment } from "../../src/deployment/deployment-recovery";
import { readJournal, scanJournals } from "../../src/deployment/deployment-journal";
import { getDeployment } from "../../src/persistence/state-db";
import { createRestrictedTargetBinding, createRestrictedTargetChannel } from "../../src/orchestration/restricted-target-channel";
import { createRestrictedTargetService } from "../../src/orchestration/restricted-target-service";
import type { RestrictedTargetRequest } from "../../src/deployment/restricted-target-contract";
import * as targetCas from "../../src/deployment/deployment-target-cas";
import { openValidatedCompiledDeploymentPlan } from "../../src/render/render-compiler";

const roots: string[] = [];
const opened: Array<Awaited<ReturnType<typeof createExecutorComparisonFixture>>> = [];
afterEach(() => {
    vi.restoreAllMocks();
    for (const fixture of opened.splice(0)) fixture.close();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-restricted-target-"));
    roots.push(root);
    const h = await createExecutorComparisonFixture({
        stateRoot: path.join(root, "state"),
        targetRoot: path.join(root, "target"),
        schemaPath: path.resolve(__dirname, "../../schema/schema.sql"),
        platform: "wsl",
        platformInstanceId: "test-selected",
    });
    opened.push(h);
    return { ...h, root, target: path.join(root, "target", "AGENTS.md") };
}

function connect(
    h: Awaited<ReturnType<typeof fixture>>,
    intercept?: (request: RestrictedTargetRequest, response: unknown) => unknown,
) {
    const session = { hostInstanceId: crypto.randomUUID(), sessionId: crypto.randomUUID() };
    const binding = {
        bindingId: crypto.randomUUID(),
        deploymentId: h.deploymentId,
        platformInstanceId: "test-selected",
        targetRootPath: path.dirname(h.target),
        executionRootPath: path.dirname(h.target),
    };
    const requests: RestrictedTargetRequest[] = [];
    const service = createRestrictedTargetService({ ...session, bindings: [binding], deadlineAt: Date.now() + 60_000 });
    const channel = createRestrictedTargetChannel(session, (request) => {
        const detached = JSON.parse(JSON.stringify(request)) as RestrictedTargetRequest;
        requests.push(detached);
        const result = service.handle(detached);
        return intercept === undefined ? result : intercept(detached, result);
    });
    const execution = channel.bind(binding);
    h.opts.targetExecution = selectedWslTargetTransactions(execution);
    return { service, execution, requests, session, binding };
}

describe("restricted target execution preserves Windows-side transaction authority", () => {
    it("binds the selected Deployment and rejects foreign, escaped or invalid target contexts before process admission", () => {
        const bindingId = crypto.randomUUID();
        const request = {
            deploymentId: crypto.randomUUID(),
            targetRootPath: "\\\\wsl.localhost\\Ubuntu\\home\\oaam\\target",
            platformContext: {
                platform: "wsl" as const,
                platformInstanceId: "Ubuntu",
                accessRootPath: "\\\\wsl.localhost\\Ubuntu\\home\\oaam",
            },
        };
        expect(createRestrictedTargetBinding(request, bindingId)).toEqual({
            bindingId,
            deploymentId: request.deploymentId,
            platformInstanceId: "Ubuntu",
            targetRootPath: request.targetRootPath,
            executionRootPath: "/home/oaam/target",
        });
        expect(() => createRestrictedTargetBinding(request, "invalid")).toThrow();
        for (const invalid of [
            { ...request, platformContext: { ...request.platformContext, platform: "win32" as const } },
            { ...request, deploymentId: "invalid" },
            { ...request, targetRootPath: "relative/target" },
            { ...request, targetRootPath: "\\\\wsl.localhost\\Debian\\home\\oaam\\target" },
            { ...request, targetRootPath: "\\\\wsl.localhost\\Ubuntu\\home\\other\\target" },
        ])
            expect(() => createRestrictedTargetBinding(invalid, bindingId)).toThrow();
    });

    it("uses production compiled plans for create, rewrite and no-op through one bound service", async () => {
        const h = await fixture();
        const connection = connect(h);
        const first = h.execute(await h.compile("# First\n"), "# First\n");
        const second = h.execute(await h.compile("# Second\n"), "# Second\n");
        const noOp = h.execute(await h.compile("# Second\n"), "# Second\n");
        expect(second.beforeTransactionId).toBe(first.transactionId);
        expect(noOp.beforeTransactionId).toBe(second.transactionId);
        expect(connection.requests.map((request) => request.operation.kind)).toEqual([
            "prepare_graph",
            "execute_graph",
            "prepare_graph",
            "execute_graph",
            "prepare_graph",
            "execute_graph",
        ]);
        expect(connection.requests[0]!.operation).not.toHaveProperty("transactionId");
        expect(() => connection.service.handle(connection.requests[1])).toThrow(/rejected/);
    });

    it("retains a real written transaction after response loss, recovers it, and separately refuses a third value", async () => {
        const h = await fixture();
        const initial = h.execute(await h.compile("# Baseline\n"), "# Baseline\n");
        const loseResponse = (request: RestrictedTargetRequest, response: unknown) => {
            if (request.operation.kind === "execute_graph") throw new Error("lost after actual target write");
            return response;
        };
        connect(h, loseResponse);
        expect(executeDeployment(h.opts, await h.compile("# Written before lost response\n")).outcome).toBe("blocked");
        expect(fs.readFileSync(h.target, "utf8")).toBe("# Written before lost response\n");
        const [transactionId] = scanJournals(h.opts.transactionsRoot, h.deploymentId).matchingTxnIds;
        expect(transactionId).toBeTruthy();
        expect(getDeployment(h.db, h.deploymentId)!.committedTransactionId).toBe(initial.transactionId);
        const recovered = connect(h);
        const retainedBeforeMalformedRecovery = readJournal(h.opts.transactionsRoot, transactionId!);
        expect(
            recoverDeployment(
                h.db,
                h.opts.transactionsRoot,
                transactionId!,
                selectedWslTargetTransactions({
                    ...recovered.execution,
                    graph: undefined,
                } as never),
            ),
        ).toEqual({ outcome: "blocked", reasonCode: "blocked_by_recovery_state_unavailable", journalResolved: false });
        expect(readJournal(h.opts.transactionsRoot, transactionId!)).toEqual(retainedBeforeMalformedRecovery);
        expect(fs.readFileSync(h.target, "utf8")).toBe("# Written before lost response\n");
        expect(getDeployment(h.db, h.deploymentId)!.committedTransactionId).toBe(initial.transactionId);
        expect(recovered.requests).toHaveLength(0);

        expect(
            recoverDeployment(h.db, h.opts.transactionsRoot, transactionId!, selectedWslTargetTransactions(recovered.execution)),
        ).toEqual({
            outcome: "recovered_to_old",
            reasonCode: "",
            journalResolved: true,
        });
        expect(fs.readFileSync(h.target, "utf8")).toBe("# Baseline\n");
        expect(readJournal(h.opts.transactionsRoot, transactionId!)).toBeNull();

        connect(h, loseResponse);
        expect(executeDeployment(h.opts, await h.compile("# Another interrupted write\n")).outcome).toBe("blocked");
        const [otherTransactionId] = scanJournals(h.opts.transactionsRoot, h.deploymentId).matchingTxnIds;
        expect(otherTransactionId).not.toBe(transactionId);
        fs.writeFileSync(h.target, "# External third value\n");
        const refusal = connect(h);
        expect(
            recoverDeployment(
                h.db,
                h.opts.transactionsRoot,
                otherTransactionId!,
                selectedWslTargetTransactions(refusal.execution),
            ),
        ).toEqual({
            outcome: "blocked",
            reasonCode: "blocked_by_recovery_target_changed",
            journalResolved: false,
        });
        expect(fs.readFileSync(h.target, "utf8")).toBe("# External third value\n");
        expect(readJournal(h.opts.transactionsRoot, otherTransactionId!)).not.toBeNull();
        expect(getDeployment(h.db, h.deploymentId)!.committedTransactionId).toBe(initial.transactionId);
    });

    it("recovers a committed native-WSL v2 journal in unchanged physical coordinates", async () => {
        const h = await fixture();
        const compiled = openValidatedCompiledDeploymentPlan(await h.compile("# Committed\n"));
        const result = executeDeploymentForTest(h.opts, compiled.targetPlan, compiled.executionAuthority, {
            deleteJournal: () => {
                throw new Error("retain committed native journal");
            },
        });
        expect(result.outcome).toBe("committed");
        const [transactionId] = scanJournals(h.opts.transactionsRoot, h.deploymentId).matchingTxnIds;
        expect(transactionId).toBe(result.transactionId);
        expect(readJournal(h.opts.transactionsRoot, transactionId!)?.schemaVersion).toBe(2);
        const committed = getDeployment(h.db, h.deploymentId);
        const retained = readJournal(h.opts.transactionsRoot, transactionId!)!;
        const retired = connect(h);
        for (const operation of [
            { kind: "prepare", entries: retained.entries },
            { kind: "execute", journal: retained },
            { kind: "recover", journal: retained, side: "old" },
        ]) {
            expect(() =>
                retired.service.handle({
                    protocol: "oaam.restricted-target.v2",
                    ...retired.session,
                    operationId: crypto.randomUUID(),
                    sequence: 1,
                    bindingId: retired.binding.bindingId,
                    operation,
                }),
            ).toThrow("rejected");
            expect(readJournal(h.opts.transactionsRoot, transactionId!)).toEqual(retained);
            expect(fs.readFileSync(h.target, "utf8")).toBe("# Committed\n");
            expect(getDeployment(h.db, h.deploymentId)).toEqual(committed);
        }
        expect(
            recoverDeployment(h.db, h.opts.transactionsRoot, transactionId!, selectedWslTargetTransactions(retired.execution)),
        ).toMatchObject({
            outcome: "blocked",
            reasonCode: "blocked_by_recovery_state_unavailable",
            journalResolved: false,
        });
        expect(readJournal(h.opts.transactionsRoot, transactionId!)).toEqual(retained);
        expect(retired.requests).toHaveLength(0);

        expect(recoverDeployment(h.db, h.opts.transactionsRoot, transactionId!, localTargetTransactions)).toEqual({
            outcome: "recovered_to_new",
            reasonCode: "",
            journalResolved: true,
        });
        expect(fs.readFileSync(h.target, "utf8")).toBe("# Committed\n");
        expect(getDeployment(h.db, h.deploymentId)).toEqual(committed);
        expect(readJournal(h.opts.transactionsRoot, transactionId!)).toBeNull();
    });

    it("rejects mismatched responses before State commit even after the remote write succeeded", async () => {
        const h = await fixture();
        connect(h, (request, response) =>
            request.operation.kind === "execute_graph" ? { ...(response as object), operationId: crypto.randomUUID() } : response,
        );
        expect(executeDeployment(h.opts, await h.compile("# Written but unacknowledged\n")).outcome).toBe("blocked");
        expect(fs.readFileSync(h.target, "utf8")).toBe("# Written but unacknowledged\n");
        expect(getDeployment(h.db, h.deploymentId)!.committedTransactionId).toBe("");
        expect(scanJournals(h.opts.transactionsRoot, h.deploymentId).matchingTxnIds).toHaveLength(1);
    });

    it("does not accept a replaced approved root or another Deployment binding", async () => {
        const h = await fixture();
        const connection = connect(h);
        const plan = await h.compile("# Desired\n");
        fs.renameSync(path.dirname(h.target), path.join(h.root, "retained-old-target"));
        fs.mkdirSync(path.dirname(h.target));
        expect(executeDeployment(h.opts, plan).outcome).toBe("blocked");
        expect(fs.readdirSync(path.dirname(h.target))).toEqual([]);
        expect(connection.requests).toHaveLength(1);
        h.opts.targetExecution = selectedWslTargetTransactions({
            ...connection.execution,
            binding: { ...connection.binding, deploymentId: crypto.randomUUID() },
        });
        expect(executeDeployment(h.opts, plan).reasonCode).toBe("blocked_needs_support");
        expect(connection.requests).toHaveLength(1);
    });

    it("rejects success when the root changes during the real target write", async () => {
        const h = await fixture();
        connect(h);
        const original = targetCas.casWriteAll;
        vi.spyOn(targetCas, "casWriteAll").mockImplementation((entries, ctx) => {
            const result = original(entries, ctx);
            fs.renameSync(path.dirname(h.target), path.join(h.root, "retained-written-target"));
            fs.mkdirSync(path.dirname(h.target));
            fs.writeFileSync(h.target, "# Desired\n");
            return result;
        });
        expect(executeDeployment(h.opts, await h.compile("# Desired\n")).outcome).toBe("blocked");
        expect(fs.readFileSync(path.join(h.root, "retained-written-target", "AGENTS.md"), "utf8")).toBe("# Desired\n");
        expect(getDeployment(h.db, h.deploymentId)!.committedTransactionId).toBe("");
        expect(scanJournals(h.opts.transactionsRoot, h.deploymentId).matchingTxnIds).toHaveLength(1);
    });

    it.each([
        "graph",
        "review",
    ] as const)("rejects a malformed execution without mandatory %s before target writes", async (field) => {
        const h = await fixture();
        const connection = connect(h);
        h.opts.targetExecution = selectedWslTargetTransactions({ ...connection.execution, [field]: undefined } as never);
        expect(executeDeployment(h.opts, await h.compile("# Must remain absent\n")).outcome).toBe("blocked");
        expect(connection.requests).toHaveLength(0);
        expect(fs.existsSync(h.target)).toBe(false);
        expect(getDeployment(h.db, h.deploymentId)!.committedTransactionId).toBe("");
    });

    it("binds an exact selected-distro UNC projection and rejects another root or distro", async () => {
        const h = await fixture();
        const { binding, session } = connect(h);
        const targetRootPath = `\\\\wsl.localhost\\test-selected\\${binding.executionRootPath.slice(1).replaceAll("/", "\\")}`;
        const config = { ...session, bindings: [{ ...binding, targetRootPath }], deadlineAt: Date.now() + 60_000 };
        expect(() => createRestrictedTargetService(config)).not.toThrow();
        expect(() =>
            createRestrictedTargetService({ ...config, bindings: [{ ...binding, targetRootPath: targetRootPath + "-other" }] }),
        ).toThrow(/mapping/);
        expect(() =>
            createRestrictedTargetService({
                ...config,
                bindings: [{ ...binding, targetRootPath, platformInstanceId: "another-selected" }],
            }),
        ).toThrow(/mapping/);
    });
});
