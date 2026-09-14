import { join } from "node:path";

/** One build-selected resource beside the Shared entry or the bundled Linux service. */
export function resolveLinuxPhysicalHelperPath(): string {
    const helper = join(__dirname, "oaam_linux_file_mutation");
    const marker = "/app.asar/";
    const index = helper.indexOf(marker);
    if (index < 0) return helper;
    if (helper.indexOf(marker, index + marker.length) >= 0) throw new Error("ambiguous Linux helper archive boundary");
    return `${helper.slice(0, index)}/app.asar.unpacked/${helper.slice(index + marker.length)}`;
}
