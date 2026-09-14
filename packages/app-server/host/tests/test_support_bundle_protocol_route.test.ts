import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fakeCoreWith, host, initializeRequest, provider, recordingSink } from "./support/host-test-fixtures";

describe("Host support-bundle Protocol route", () => {
    it("binds support export to the exact reviewed ZIP and a one-shot new-file destination", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-support-route-"));
        const destination = path.join(root, "support.zip");
        const existingDestination = path.join(root, "existing.zip");
        const replayDestination = path.join(root, "replay.zip");
        const listAdapterProviders = vi.fn(() => ({
            status: "complete" as const,
            value: [provider],
            diagnostics: [],
        }));
        const runtime = host(fakeCoreWith({ listAdapterProviders }));
        const sink = recordingSink();
        const connection = runtime.openConnection(sink);
        try {
            connection.receive(initializeRequest());
            connection.receive({
                id: "inspect",
                method: "diagnostics.support_bundle.inspect",
                params: { mode: "standard" },
            });

            await vi.waitFor(() =>
                expect(
                    sink.messages.find(
                        (message) =>
                            "method" in message &&
                            message.method === "operation.terminal" &&
                            message.params.operation === "diagnostics.support_bundle.inspect",
                    ),
                ).toBeDefined(),
            );
            const inspectTerminal = sink.messages.find(
                (message) =>
                    "method" in message &&
                    message.method === "operation.terminal" &&
                    message.params.operation === "diagnostics.support_bundle.inspect",
            );
            const review = (
                inspectTerminal as {
                    params: {
                        outcome: {
                            status: "complete";
                            value: {
                                supportBundleReviewToken: string;
                                archiveByteLength: number;
                                entries: readonly unknown[];
                            };
                        };
                    };
                }
            ).params.outcome.value;
            expect(review.archiveByteLength).toBeGreaterThan(0);
            expect(review.entries).toHaveLength(6);

            connection.receive({
                id: "missing-path",
                method: "diagnostics.support_bundle.export",
                params: {
                    supportBundleReviewToken: review.supportBundleReviewToken,
                    localPathSelectionToken: "missing-selection",
                    userActionId: "missing-path-action",
                },
            });
            await vi.waitFor(() =>
                expect(sink.messages).toContainEqual({
                    method: "operation.terminal",
                    params: {
                        operationId: "operation-2",
                        sequence: 1,
                        operation: "diagnostics.support_bundle.export",
                        outcome: {
                            status: "failed",
                            diagnostics: [expect.objectContaining({ code: "host.path_selection_unavailable" })],
                        },
                    },
                }),
            );

            fs.writeFileSync(existingDestination, "keep");
            const existingToken = connection.registerLocalPathSelection("support_bundle_file", existingDestination);
            connection.receive({
                id: "existing",
                method: "diagnostics.support_bundle.export",
                params: {
                    supportBundleReviewToken: review.supportBundleReviewToken,
                    localPathSelectionToken: existingToken,
                    userActionId: "existing-file-action",
                },
            });
            await vi.waitFor(() =>
                expect(sink.messages).toContainEqual({
                    method: "operation.terminal",
                    params: {
                        operationId: "operation-3",
                        sequence: 1,
                        operation: "diagnostics.support_bundle.export",
                        outcome: {
                            status: "failed",
                            diagnostics: [expect.objectContaining({ code: "host.core_invocation_failed" })],
                        },
                    },
                }),
            );
            expect(fs.readFileSync(existingDestination, "utf8")).toBe("keep");

            const destinationToken = connection.registerLocalPathSelection("support_bundle_file", destination);
            connection.receive({
                id: "export",
                method: "diagnostics.support_bundle.export",
                params: {
                    supportBundleReviewToken: review.supportBundleReviewToken,
                    localPathSelectionToken: destinationToken,
                    userActionId: "support-export-action",
                },
            });

            await vi.waitFor(() =>
                expect(
                    sink.messages.find(
                        (message) =>
                            "method" in message &&
                            message.method === "operation.terminal" &&
                            message.params.operation === "diagnostics.support_bundle.export" &&
                            message.params.outcome.status === "complete",
                    ),
                ).toBeDefined(),
            );
            const exportTerminal = sink.messages.find(
                (message) =>
                    "method" in message &&
                    message.method === "operation.terminal" &&
                    message.params.operation === "diagnostics.support_bundle.export" &&
                    message.params.outcome.status === "complete",
            );
            expect(exportTerminal).toMatchObject({
                params: {
                    outcome: {
                        status: "complete",
                        value: {
                            mode: "standard",
                            archiveByteLength: review.archiveByteLength,
                            entryCount: 6,
                        },
                    },
                },
            });
            expect(fs.readFileSync(destination).subarray(0, 2).toString("utf8")).toBe("PK");
            expect(listAdapterProviders).toHaveBeenCalledTimes(1);

            const replayToken = connection.registerLocalPathSelection("support_bundle_file", replayDestination);
            connection.receive({
                id: "replay",
                method: "diagnostics.support_bundle.export",
                params: {
                    supportBundleReviewToken: review.supportBundleReviewToken,
                    localPathSelectionToken: replayToken,
                    userActionId: "replay-action",
                },
            });
            await vi.waitFor(() =>
                expect(sink.messages).toContainEqual({
                    method: "operation.terminal",
                    params: {
                        operationId: "operation-5",
                        sequence: 1,
                        operation: "diagnostics.support_bundle.export",
                        outcome: {
                            status: "failed",
                            diagnostics: [
                                expect.objectContaining({
                                    code: "host.review_record_unavailable",
                                }),
                            ],
                        },
                    },
                }),
            );
            expect(fs.existsSync(replayDestination)).toBe(false);
        } finally {
            await runtime.shutdown();
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
