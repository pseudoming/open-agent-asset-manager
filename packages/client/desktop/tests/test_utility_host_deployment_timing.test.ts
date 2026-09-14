import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
const trace = vi.hoisted(() => ({ enabled: true }));
vi.mock("node:util", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:util")>();
    return { ...actual, default: { ...actual, debuglog: () => trace }, debuglog: () => trace };
});
import { forwardUtilityDeploymentTiming } from "../src/main/utility-host-deployment-timing";
const line = "OAAM-DEPLOYMENT 123: stage=publication start_ms=10.000 end_ms=12.000 duration_ms=2.000";
afterEach(() => {
    trace.enabled = true;
});

describe("utility Host deployment timing pipe", () => {
    it("forwards split timing lines while discarding other Host output and incomplete data", () => {
        const stream = new PassThrough(),
            write = vi.fn();
        const detach = forwardUtilityDeploymentTiming(stream, write);
        stream.write("A Host diagnostic with private content\n" + line.slice(0, 31));
        stream.write(line.slice(31) + "\n" + line + " path=/private/source\n" + line.slice(0, 18));
        expect(write.mock.calls).toEqual([[line + "\n"]]);
        detach();
        stream.write(line + "\n");
        expect(write).toHaveBeenCalledOnce();
        expect(stream.listenerCount("data")).toBe(0);
        stream.destroy();
    });
    it("discards an overlong line across chunks and recovers at the next newline", () => {
        const stream = new PassThrough(),
            write = vi.fn();
        const detach = forwardUtilityDeploymentTiming(stream, write);
        stream.write("x".repeat(600));
        stream.write(line + "\n" + line + "\n");
        expect(write.mock.calls).toEqual([[line + "\n"]]);
        detach();
        stream.destroy();
    });
    it("does not attach when disabled or when the pipe is unavailable", () => {
        trace.enabled = false;
        const stream = new PassThrough(),
            write = vi.fn();
        forwardUtilityDeploymentTiming(stream, write)();
        forwardUtilityDeploymentTiming(null, write)();
        expect(stream.listenerCount("data")).toBe(0);
        expect(write).not.toHaveBeenCalled();
        stream.destroy();
    });
    it("keeps the Host stream usable when the outer diagnostic sink fails", () => {
        const stream = new PassThrough();
        const detach = forwardUtilityDeploymentTiming(stream, () => {
            throw new Error("sink failed");
        });
        expect(() => stream.write(line + "\n")).not.toThrow();
        detach();
        stream.destroy();
    });
});
