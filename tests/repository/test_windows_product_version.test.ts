import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NtExecutable, NtExecutableResource, Resource } from "resedit";
import { expect, it } from "vitest";
import { readWindowsVersionInfo, stampWindowsProductVersion } from "./windows-version-info.mjs";

it("writes the channel mapping into real PE fixed product fields while retaining the readable beta version", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oaam-pe-version-"));
    try {
        const pe = NtExecutable.createEmpty(false, false);
        const resources = NtExecutableResource.from(pe);
        const version = Resource.VersionInfo.create({
            lang: 1033,
            fixedInfo: { fileVersionMS: 1, fileVersionLS: 32768, productVersionMS: 1, productVersionLS: 1 },
            strings: [
                {
                    lang: 1033,
                    codepage: 1200,
                    values: {
                        ProductVersion: "0.1.0-beta.1",
                        FileVersion: "0.1.0.32768",
                        CompanyName: "OAAM contributors",
                        LegalCopyright: "Copyright OAAM contributors",
                    },
                },
            ],
        });
        version.outputToResourceEntries(resources.entries);
        resources.outputResource(pe);
        const executable = path.join(root, "fixture.exe");
        fs.writeFileSync(executable, Buffer.from(pe.generate()));
        expect(readWindowsVersionInfo(executable).productVersion).toBe("0.1.0.1");
        stampWindowsProductVersion(executable, "0.1.0-beta.1");
        expect(readWindowsVersionInfo(executable)).toEqual({
            fileVersion: "0.1.0.32768",
            productVersion: "0.1.0.32768",
            strings: {
                ProductVersion: "0.1.0-beta.1",
                FileVersion: "0.1.0.32768",
                CompanyName: "OAAM contributors",
                LegalCopyright: "Copyright OAAM contributors",
            },
        });
        expect(() => stampWindowsProductVersion(executable, "0.1.0-beta.32768")).toThrow();
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
