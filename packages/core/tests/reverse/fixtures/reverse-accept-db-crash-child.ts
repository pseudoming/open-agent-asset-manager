import * as fs from "node:fs";
import {
    commitReverseAcceptSuccessCrashDurableForTest,
    type CommitReverseAcceptSuccessCrashDurableInput,
} from "../../../src/deployment/deployment-state-authority";

const [, , inputPath, signalPath, killPoint] = process.argv;
if (inputPath === undefined || signalPath === undefined) {
    throw new Error("reverse-accept crash child requires input and signal paths");
}
if (killPoint !== "before_commit" && killPoint !== "after_commit") {
    throw new Error("reverse-accept crash child kill point is invalid");
}

const input = JSON.parse(fs.readFileSync(inputPath, "utf-8")) as CommitReverseAcceptSuccessCrashDurableInput;
const stopForParentKill = (): never => {
    fs.writeFileSync(signalPath, killPoint, { flag: "wx" });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    throw new Error("unreachable after infinite Atomics.wait");
};

commitReverseAcceptSuccessCrashDurableForTest(input, {
    fullTransaction: killPoint === "before_commit" ? { beforeCommit: stopForParentKill } : { afterCommit: stopForParentKill },
});
