import { afterEach, describe, expect, it, vi } from "vitest";
const trace = vi.hoisted(() => Object.assign(vi.fn(), { enabled: true }));
vi.mock("node:util", () => ({ debuglog: () => trace }));
import { measureDeploymentStage } from "../../src/deployment/deployment-stage-timing";
afterEach(() => {
    trace.mockReset();
    trace.enabled = true;
});

describe("optional deployment stage timing", () => {
    it("preserves the exact result and records only stage and monotonic numbers", () => {
        const result = { privateContent: "kept out of diagnostics" };
        expect(measureDeploymentStage("publication", () => result)).toBe(result);
        const [format, stage, started, ended, elapsed] = trace.mock.calls[0]!;
        expect(format).toBe("stage=%s start_ms=%s end_ms=%s duration_ms=%s");
        expect(stage).toBe("publication");
        for (const value of [started, ended, elapsed]) expect(value).toMatch(/^\d+\.\d{3}$/u);
        expect(Number(ended)).toBeGreaterThanOrEqual(Number(started));
        expect(Math.abs(Number(elapsed) - (Number(ended) - Number(started)))).toBeLessThanOrEqual(0.002);
        expect(JSON.stringify(trace.mock.calls)).not.toContain(result.privateContent);
    });
    it("records a failed stage and rethrows the original exception even if diagnostic output fails", () => {
        const failure = new Error("stage failure");
        trace.mockImplementation(() => {
            throw new Error("diagnostic sink unavailable");
        });
        expect(() =>
            measureDeploymentStage("verification", () => {
                throw failure;
            }),
        ).toThrow(failure);
        expect(trace).toHaveBeenCalledOnce();
        expect(trace.mock.calls[0]![1]).toBe("verification");
    });
    it("does not record when the debug section is disabled", () => {
        trace.enabled = false;
        const result = Symbol("result");
        expect(measureDeploymentStage("commit", () => result)).toBe(result);
        expect(trace).not.toHaveBeenCalled();
    });
});
