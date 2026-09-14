import assert from "node:assert/strict";
import fs from "node:fs";
import { NtExecutable, NtExecutableResource, Resource } from "resedit";
import { windowsProductVersion } from "./product-release.mjs";

/** Packager treats prerelease dots as PE version fields; keep both fixed versions on our channel mapping. */
export function stampWindowsProductVersion(executable, productVersion) {
    const stat = fs.lstatSync(executable);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), "version stamping requires the owned direct executable");
    const pe = NtExecutable.from(fs.readFileSync(executable));
    const resources = NtExecutableResource.from(pe);
    const versions = Resource.VersionInfo.fromEntries(resources.entries);
    assert.equal(versions.length, 1);
    const version = versions[0];
    const [major, minor, patch, revision] = windowsProductVersion(productVersion).split(".").map(Number);
    version.fixedInfo.productVersionMS = (major << 16) | minor;
    version.fixedInfo.productVersionLS = (patch << 16) | revision;
    version.outputToResourceEntries(resources.entries);
    resources.outputResource(pe);
    fs.writeFileSync(executable, Buffer.from(pe.generate()));
}

/** Read the executable's actual VERSIONINFO without launching it or trusting a sidecar. */
export function readWindowsVersionInfo(executable) {
    const pe = NtExecutable.from(fs.readFileSync(executable));
    const versions = Resource.VersionInfo.fromEntries(NtExecutableResource.from(pe).entries);
    assert.equal(versions.length, 1, "expected one PE version resource");
    const version = versions[0];
    const languages = version.getAllLanguagesForStringValues();
    assert.equal(languages.length, 1, "expected one PE version string table");
    const { fileVersionMS, fileVersionLS, productVersionMS, productVersionLS } = version.fixedInfo;
    const numeric = (high, low) => `${high >>> 16}.${high & 0xffff}.${low >>> 16}.${low & 0xffff}`;
    return Object.freeze({
        fileVersion: numeric(fileVersionMS, fileVersionLS),
        productVersion: numeric(productVersionMS, productVersionLS),
        strings: version.getStringValues(languages[0]),
    });
}
