/** Fixed Linux helper invocation for kernel no-replace directory publication. */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { dirname } from "node:path";
import { samePhysicalPathIdentity } from "../../filesystem/filesystem-facts";
import {
    DurableFilesystemMutationError,
    type DurableMutationState,
    type PhysicalPathIdentity,
    type SafeFilesystemFailureKind,
    type StableRegularFileRead,
} from "../../filesystem/filesystem-types";
import { buildRequest, helperFailureKind, parseReceipt } from "../linux-mutation-framing";
import { resolveLinuxPhysicalHelperPath } from "./linux-helper-path";

const HELPER_MAXIMUM_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MILLISECONDS = 5_000;
const RECEIPT_BYTES = 200;

export interface LinuxEntryPublication {
    readonly sourcePath: string;
    readonly destinationPath: string;
    readonly sourceIdentity: PhysicalPathIdentity;
    readonly sourceParentIdentity: PhysicalPathIdentity;
    readonly destinationParentIdentity: PhysicalPathIdentity;
}

interface PublicationDependencies {
    readonly helperPath: string;
    readonly readHelper: (filePath: string, maximumBytes: number) => StableRegularFileRead;
    readonly invoke: typeof spawnSync;
    readonly now: () => number;
}

export function invokeLinuxEntryPublication(
    input: LinuxEntryPublication,
    readHelper: PublicationDependencies["readHelper"],
): PhysicalPathIdentity {
    return invokeLinuxEntryPublicationForTest(input, {
        helperPath: resolveLinuxPhysicalHelperPath(),
        readHelper,
        invoke: spawnSync,
        now: () => performance.now(),
    });
}

/** Private seam; callers cannot choose an executable through the package API. */
export function invokeLinuxEntryPublicationForTest(
    input: LinuxEntryPublication,
    dependencies: PublicationDependencies,
): PhysicalPathIdentity {
    const operation = input.sourceIdentity.entryKind === "directory" ? "publish_directory" : "publish_file";
    const safeOperation = operation === "publish_directory" ? "durable_publish_directory" : "durable_publish_file";
    const deadline = dependencies.now() + TIMEOUT_MILLISECONDS;
    const fail = (
        code: string,
        state: DurableMutationState = "not_applied",
        failureKind: SafeFilesystemFailureKind = "io_error",
    ): never => {
        throw new DurableFilesystemMutationError({
            operation: safeOperation,
            targetPath: input.destinationPath,
            failureKind,
            systemCode: code,
            mutationState: state,
            message: "Linux directory publication did not establish its exact postcondition",
        });
    };
    let before: StableRegularFileRead | undefined, after: StableRegularFileRead | undefined;
    let request: Buffer | undefined;
    let result: ReturnType<typeof spawnSync> | undefined;
    let invoked = false;
    let nonce: Buffer | undefined;
    try {
        before = dependencies.readHelper(dependencies.helperPath, HELPER_MAXIMUM_BYTES);
        if (
            !before.executable ||
            before.bytes.byteLength < 4 ||
            !Buffer.from(before.bytes.subarray(0, 4)).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
        )
            fail("LINUX_PUBLICATION_HELPER_INVALID");
        const helperHash = createHash("sha256").update(before.bytes).digest("hex");
        nonce = randomBytes(32);
        const payload = Buffer.from(input.destinationPath, "utf8");
        try {
            request = buildRequest(
                operation,
                {
                    hostPath: input.sourcePath,
                    runtimeRootPath: dirname(input.sourcePath),
                    runtimeTargetPath: input.sourcePath,
                },
                payload,
                nonce,
                input.sourceIdentity,
                { source: input.sourceParentIdentity, destination: input.destinationParentIdentity },
            );
        } finally {
            payload.fill(0);
        }
        const remaining = Math.floor(deadline - dependencies.now());
        if (remaining <= 0) fail("LINUX_PUBLICATION_HELPER_TIMEOUT");
        // spawnSync owns and reaps this exact OS child, including on timeout. The
        // fixed static helper accepts no program/command input and cannot fork.
        // No shell, ambient executable search or inherited loader environment.
        const birth = ownProcessBirth();
        invoked = true;
        result = dependencies.invoke(dependencies.helperPath, ["--owned-parent", String(process.pid), birth], {
            cwd: dirname(dependencies.helperPath),
            env: {},
            shell: false,
            input: request,
            encoding: "buffer",
            timeout: remaining,
            killSignal: "SIGKILL",
            maxBuffer: RECEIPT_BYTES,
        });
        if (
            result.error !== undefined ||
            result.status !== 0 ||
            result.signal !== null ||
            !Buffer.isBuffer(result.stdout) ||
            !Buffer.isBuffer(result.stderr) ||
            result.stderr.byteLength !== 0
        )
            fail("LINUX_PUBLICATION_HELPER_UNCERTAIN", "may_have_applied");
        after = dependencies.readHelper(dependencies.helperPath, HELPER_MAXIMUM_BYTES);
        if (
            dependencies.now() > deadline ||
            !after.executable ||
            !samePhysicalPathIdentity(before.identity, after.identity) ||
            !Buffer.from(before.bytes).equals(Buffer.from(after.bytes))
        )
            fail("LINUX_PUBLICATION_HELPER_CHANGED", "may_have_applied", "stale");
        let receipt: ReturnType<typeof parseReceipt>;
        try {
            receipt = parseReceipt(result.stdout as Buffer, nonce);
        } catch {
            return fail("LINUX_PUBLICATION_RECEIPT_INVALID", "may_have_applied");
        }
        if (
            receipt.operation !== operation ||
            receipt.helperSha256 !== helperHash ||
            BigInt(`0x${receipt.helperIdentity.deviceId}`) !== BigInt(before.identity.deviceId) ||
            receipt.helperIdentity.fileId !== before.identity.fileId
        )
            fail("LINUX_PUBLICATION_RECEIPT_IDENTITY_CHANGED", "may_have_applied", "stale");
        if (receipt.status === "failed")
            return fail(
                `LINUX_PUBLICATION_${receipt.failure.toUpperCase()}`,
                receipt.certainty === "not_applied" ? "not_applied" : "may_have_applied",
                helperFailureKind(receipt.failure),
            );
        if (
            !samePhysicalPathIdentity(receipt.parentBefore, input.sourceParentIdentity) ||
            !samePhysicalPathIdentity(receipt.parentAfter, input.sourceParentIdentity) ||
            !samePhysicalPathIdentity(receipt.targetBefore, input.sourceIdentity) ||
            !samePhysicalPathIdentity(receipt.targetAfter, input.sourceIdentity) ||
            receipt.contentSha256 !== createHash("sha256").update(input.destinationPath).digest("hex") ||
            receipt.byteSize !== Buffer.byteLength(input.destinationPath)
        )
            fail("LINUX_PUBLICATION_POSTCONDITION_CHANGED", "may_have_applied", "stale");
        return receipt.targetAfter;
    } catch (error) {
        if (error instanceof DurableFilesystemMutationError) throw error;
        return fail("LINUX_PUBLICATION_OBSERVATION_FAILED", invoked ? "may_have_applied" : "not_applied");
    } finally {
        before?.bytes.fill(0);
        after?.bytes.fill(0);
        request?.fill(0);
        nonce?.fill(0);
        if (Buffer.isBuffer(result?.stdout)) result.stdout.fill(0);
        if (Buffer.isBuffer(result?.stderr)) result.stderr.fill(0);
    }
}

function ownProcessBirth(): string {
    // Fixed kernel metadata for this process only; no command line/environment.
    const descriptor = fs.openSync("/proc/self/stat", fs.constants.O_RDONLY);
    const bytes = Buffer.alloc(8193);
    try {
        const count = fs.readSync(descriptor, bytes, 0, bytes.byteLength, null);
        if (count === 0 || count === bytes.byteLength) throw new Error("own process stat exceeds its bound");
        const stat = bytes.subarray(0, count).toString("utf8");
        const boundary = stat.lastIndexOf(") ");
        const birth = stat.slice(boundary + 2).split(" ")[19];
        if (!stat.startsWith(`${process.pid} (`) || boundary < 0 || birth === undefined || !/^[1-9][0-9]*$/u.test(birth))
            throw new Error("own process identity is unavailable");
        return birth;
    } finally {
        bytes.fill(0);
        fs.closeSync(descriptor);
    }
}
