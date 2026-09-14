import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";

const recipeDirectory = fileURLToPath(new URL("./package-assembly/", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sections = ["dependencies", "optionalDependencies", "peerDependencies"];
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function resolveLockedDependency(packages, parent, name) {
    let directory = parent;
    for (;;) {
        const candidate = path.posix.join(directory, "node_modules", name);
        if (Object.hasOwn(packages, candidate)) return candidate;
        if (directory === "") return undefined;
        directory = path.posix.dirname(directory);
        if (directory === ".") directory = "";
    }
}

function externalClosure(graph, directory) {
    const recipe = readJson(path.join(directory, "package.json"));
    const lock = readJson(path.join(directory, "package-lock.json"));
    assert.equal(lock.lockfileVersion, 3, "assembly requires the checked npm v3 lock");
    assert.deepEqual(lock.packages[""].dependencies, recipe.dependencies, "assembly recipe and lock disagree");
    const internalNames = new Set(graph.packages.map((entry) => entry.name));
    const manifests = new Map(
        graph.packages.map((entry) => [
            entry.name,
            readJson(path.join(graph.repositoryRoot, entry.relativePath, "package.json")),
        ]),
    );
    const dependencies = {};
    const selected = new Map();
    const visit = (parent, name, range, optional = false) => {
        const location = resolveLockedDependency(lock.packages, parent, name);
        if (location === undefined && optional) return;
        assert.ok(location !== undefined, `assembly lock is missing ${name}`);
        const entry = lock.packages[location];
        assert.ok(
            location.startsWith("node_modules/") &&
                !location.includes("\\") &&
                !location.split("/").some((part) => part === "." || part === ".." || part === ""),
            "assembly lock has an unsafe package location",
        );
        assert.ok(semver.satisfies(entry.version, range), `assembly lock ${name}@${entry.version} does not satisfy ${range}`);
        if (selected.has(location)) return;
        assert.ok(
            !entry.link && typeof entry.resolved === "string" && entry.resolved.startsWith("https://"),
            `assembly external package has no immutable download: ${location}`,
        );
        assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/u, `assembly integrity is missing: ${location}`);
        selected.set(location, entry);
        for (const section of sections) {
            for (const [child, required] of Object.entries(entry[section] ?? {})) {
                visit(
                    location,
                    child,
                    required,
                    section === "optionalDependencies" || entry.peerDependenciesMeta?.[child]?.optional === true,
                );
            }
        }
    };
    for (const manifest of manifests.values()) {
        for (const section of sections) {
            for (const [name, range] of Object.entries(manifest[section] ?? {})) {
                if (internalNames.has(name)) continue;
                assert.ok(Object.hasOwn(recipe.dependencies, name), `assembly recipe must explicitly pin ${name}`);
                visit("", name, range);
                assert.equal(
                    lock.packages[`node_modules/${name}`].version,
                    recipe.dependencies[name],
                    `assembly recipe must exactly match the locked ${name} version`,
                );
                dependencies[name] = recipe.dependencies[name];
            }
        }
    }
    const packages = Object.fromEntries([...selected].sort(([a], [b]) => a.localeCompare(b, "en")));
    const names = new Set(Object.keys(packages).map((entry) => entry.slice(entry.lastIndexOf("node_modules/") + 13)));
    const overrides = Object.fromEntries(Object.entries(recipe.overrides ?? {}).filter(([name]) => names.has(name)));
    return { manifests, dependencies, overrides, packages };
}

/** Bind newly packed internal bytes while keeping every external resolution and integrity immutable. */
export function prepareLockedPackageConsumer(graph, tarballs, consumerRoot, options = {}) {
    const selected = externalClosure(graph, options.recipeDirectory ?? recipeDirectory);
    assert.equal(tarballs.length, graph.packages.length, "assembly tarball count disagrees with the workspace graph");
    const dependencies = { ...selected.dependencies };
    const packages = { ...selected.packages };
    const seen = new Set();
    for (const tarball of tarballs) {
        const manifest = selected.manifests.get(tarball.name);
        assert.ok(manifest !== undefined && !seen.has(tarball.name), "assembly received a foreign or duplicate tarball");
        seen.add(tarball.name);
        assert.equal(tarball.version, manifest.version, "assembly tarball version changed");
        const stat = fs.lstatSync(tarball.path);
        assert.ok(stat.isFile() && !stat.isSymbolicLink(), "assembly tarball must be a direct file");
        const relative = path.relative(consumerRoot, path.resolve(tarball.path)).split(path.sep).join("/");
        assert.ok(relative !== "" && !path.isAbsolute(relative), "assembly tarball must be on the consumer filesystem");
        const resolved = `file:${relative}`;
        dependencies[tarball.name] = resolved;
        const entry = {
            version: manifest.version,
            resolved,
            integrity: `sha512-${createHash("sha512").update(fs.readFileSync(tarball.path)).digest("base64")}`,
        };
        for (const key of [...sections, "peerDependenciesMeta", "engines", "bin", "os", "cpu", "license"]) {
            if (manifest[key] !== undefined) entry[key] = manifest[key];
        }
        if (manifest.scripts?.install !== undefined || manifest.scripts?.postinstall !== undefined) entry.hasInstallScript = true;
        packages[`node_modules/${tarball.name}`] = entry;
    }
    const manifest = {
        name: "oaam-package-consumer",
        version: "0.0.0",
        private: true,
        dependencies,
        overrides: selected.overrides,
    };
    const lock = {
        name: manifest.name,
        version: manifest.version,
        lockfileVersion: 3,
        requires: true,
        packages: { "": { name: manifest.name, version: manifest.version, dependencies }, ...packages },
    };
    fs.mkdirSync(consumerRoot, { recursive: true });
    fs.writeFileSync(path.join(consumerRoot, "package.json"), `${JSON.stringify(manifest, null, 4)}\n`);
    fs.writeFileSync(path.join(consumerRoot, "package-lock.json"), `${JSON.stringify(lock, null, 4)}\n`);
    return Object.freeze({
        externalPackages: selected.packages,
        externalLockSha256: hash(JSON.stringify(selected.packages)),
        lockSha256: hash(fs.readFileSync(path.join(consumerRoot, "package-lock.json"))),
    });
}

function installedExternalInventory(modules, internalNames, prefix = "node_modules") {
    const result = [];
    const visitPackage = (location, relative, name) => {
        const stat = fs.lstatSync(location);
        assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), `assembly package is not a direct directory: ${relative}`);
        if (internalNames.has(name)) assert.equal(relative, `node_modules/${name}`, "unexpected nested internal package");
        else result.push(relative);
        const nested = path.join(location, "node_modules");
        if (fs.existsSync(nested)) result.push(...installedExternalInventory(nested, internalNames, `${relative}/node_modules`));
    };
    for (const entry of fs.readdirSync(modules, { withFileTypes: true })) {
        if (entry.name === ".bin" || entry.name === ".package-lock.json") continue;
        const location = path.join(modules, entry.name);
        if (entry.name.startsWith("@")) {
            assert.ok(entry.isDirectory() && !entry.isSymbolicLink(), "assembly scope must be a direct directory");
            for (const scoped of fs.readdirSync(location)) {
                visitPackage(path.join(location, scoped), `${prefix}/${entry.name}/${scoped}`, `${entry.name}/${scoped}`);
            }
        } else visitPackage(location, `${prefix}/${entry.name}`, entry.name);
    }
    return result;
}

export function validateInstalledExternalDependencyClosure(graph, consumerRoot, prepared) {
    const expected = Object.keys(prepared.externalPackages).sort();
    const actual = installedExternalInventory(
        path.join(consumerRoot, "node_modules"),
        new Set(graph.packages.map((p) => p.name)),
    ).sort();
    assert.deepEqual(actual, expected, "installed external package graph differs from the assembly lock");
    for (const location of expected) {
        const manifest = readJson(path.join(consumerRoot, ...location.split("/"), "package.json"));
        const entry = prepared.externalPackages[location];
        assert.equal(
            manifest.name,
            location.slice(location.lastIndexOf("node_modules/") + 13),
            `installed external identity changed: ${location}`,
        );
        assert.equal(manifest.version, entry.version, `installed external version changed: ${location}`);
    }
    assert.equal(
        hash(fs.readFileSync(path.join(consumerRoot, "package-lock.json"))),
        prepared.lockSha256,
        "npm ci changed the prepared assembly lock",
    );
    return Object.freeze({ packageCount: expected.length, externalLockSha256: prepared.externalLockSha256 });
}
