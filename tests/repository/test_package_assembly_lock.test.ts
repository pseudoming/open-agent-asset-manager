import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareLockedPackageConsumer, validateInstalledExternalDependencyClosure } from "./package-assembly-lock.mjs";
import { resolveWorkspaceGraph } from "./workspace-graph.mjs";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
function write(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
}
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-assembly-lock-"));
    roots.push(root);
    write(path.join(root, "package.json"), { name: "test", workspaces: ["packages/*"] });
    const internal = path.join(root, "packages/example/package.json");
    write(internal, { name: "@oaam/example", version: "0.1.0", dependencies: { external: "^1.0.0" } });
    const recipeDirectory = path.join(root, "recipe");
    const manifest = {
        name: "assembly",
        version: "0.0.0",
        dependencies: { external: "1.2.3" },
        overrides: { external: "1.2.3", transitive: "2.1.0" },
    };
    const packages = {
        "": manifest,
        "node_modules/external": {
            version: "1.2.3",
            resolved: "https://registry.npmjs.org/external/-/external-1.2.3.tgz",
            integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
            dependencies: { transitive: "^2.0.0" },
        },
        "node_modules/transitive": {
            version: "2.1.0",
            resolved: "https://registry.npmjs.org/transitive/-/transitive-2.1.0.tgz",
            integrity: `sha512-${Buffer.alloc(64, 2).toString("base64")}`,
        },
    };
    write(path.join(recipeDirectory, "package.json"), manifest);
    const lockFile = path.join(recipeDirectory, "package-lock.json");
    write(lockFile, { ...manifest, lockfileVersion: 3, packages });
    const tarballs = [{ name: "@oaam/example", version: "0.1.0", path: path.join(root, "example.tgz") }];
    fs.writeFileSync(tarballs[0]!.path, "first internal payload");
    const graph = resolveWorkspaceGraph(root);
    const consumer = path.join(root, "consumer");
    const prepare = () => prepareLockedPackageConsumer(graph, tarballs, consumer, { recipeDirectory });
    const installFixture = () => {
        for (const [location, entry] of Object.entries(packages)) {
            if (location === "") continue;
            write(path.join(consumer, location, "package.json"), { name: path.basename(location), version: entry.version });
        }
        // This is a package-owned example, never a separately installed dependency.
        write(path.join(consumer, "node_modules/external/example/package.json"), { name: "example-only", version: "9.9.9" });
    };
    return { root, graph, internal, recipeDirectory, lockFile, tarballs, consumer, prepare, installFixture };
}

describe("locked package assembly", () => {
    it("binds changed internal tarball bytes without changing any external resolution", () => {
        const f = fixture();
        const first = f.prepare();
        const firstLock = read(path.join(f.consumer, "package-lock.json"));
        fs.writeFileSync(f.tarballs[0]!.path, "changed internal payload");
        const second = f.prepare();
        const secondLock = read(path.join(f.consumer, "package-lock.json"));
        expect(first.externalLockSha256).toBe(second.externalLockSha256);
        expect(first.lockSha256).not.toBe(second.lockSha256);
        expect(firstLock.packages["node_modules/@oaam/example"].integrity).not.toBe(
            secondLock.packages["node_modules/@oaam/example"].integrity,
        );
        expect(firstLock.packages["node_modules/external"]).toEqual(secondLock.packages["node_modules/external"]);
        expect(secondLock.packages["node_modules/@oaam/example"].resolved).toBe("file:../example.tgz");
    });
    it("validates the actual node_modules graph without inventing a dependency from an owned example", () => {
        const f = fixture();
        const prepared = f.prepare();
        f.installFixture();
        expect(validateInstalledExternalDependencyClosure(f.graph, f.consumer, prepared).packageCount).toBe(2);
        write(path.join(f.consumer, "node_modules/external/node_modules/foreign/package.json"), {
            name: "foreign",
            version: "1.0.0",
        });
        expect(() => validateInstalledExternalDependencyClosure(f.graph, f.consumer, prepared)).toThrow(/graph differs/);
    });
    it.each(["missing", "version", "identity", "lock"])("rejects installed %s drift", (kind) => {
        const f = fixture();
        const prepared = f.prepare();
        f.installFixture();
        const external = path.join(f.consumer, "node_modules/external");
        if (kind === "missing") fs.rmSync(external, { recursive: true });
        if (kind === "version") write(path.join(external, "package.json"), { name: "external", version: "1.2.4" });
        if (kind === "identity") write(path.join(external, "package.json"), { name: "different", version: "1.2.3" });
        if (kind === "lock") fs.appendFileSync(path.join(f.consumer, "package-lock.json"), " ");
        expect(() => validateInstalledExternalDependencyClosure(f.graph, f.consumer, prepared)).toThrow();
    });
    it.each(["missing", "range", "integrity", "recipe"])("rejects %s dependency-lock mismatch before installation", (kind) => {
        const f = fixture();
        const lock = read(f.lockFile);
        if (kind === "missing") delete lock.packages["node_modules/transitive"];
        if (kind === "range") lock.packages["node_modules/external"].version = "2.0.0";
        if (kind === "integrity") delete lock.packages["node_modules/transitive"].integrity;
        if (kind === "recipe") lock.packages[""].dependencies.external = "1.2.4";
        write(f.lockFile, lock);
        expect(f.prepare).toThrow();
    });
    it.each(["missing", "foreign", "duplicate", "version"])("rejects %s internal tarball input", (kind) => {
        const f = fixture();
        if (kind === "missing") fs.unlinkSync(f.tarballs[0]!.path);
        if (kind === "foreign") f.tarballs[0]!.name = "@oaam/foreign";
        if (kind === "duplicate") f.tarballs.push(f.tarballs[0]!);
        if (kind === "version") f.tarballs[0]!.version = "9.9.9";
        expect(f.prepare).toThrow();
    });
    it("selects only the external dependencies used by a consumer workspace subset", () => {
        const f = fixture();
        write(f.internal, { name: "@oaam/example", version: "0.1.0", dependencies: {} });
        expect(f.prepare().externalPackages).toEqual({});
        expect(read(path.join(f.consumer, "package.json")).overrides).toEqual({});
    });
});
