import { launchProductionHost } from "@oaam/app-server-bootstrap";
import { HostProcessRuntime } from "./host-process-runtime";

const parentPort = process.parentPort;
if (parentPort === undefined || parentPort === null) {
    throw new Error("OAAM Desktop Host entry requires an Electron utility parent port");
}

new HostProcessRuntime(parentPort, {
    launchHost: launchProductionHost,
    stopProcess() {
        setImmediate(() => process.exit(0));
    },
}).start();
