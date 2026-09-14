import type { HostConnection, ProductionHost } from "@oaam/app-server-host";

export interface HostMessagePort {
    on(event: "message", listener: (event: { readonly data: unknown }) => void): this;
    on(event: "close", listener: () => void): this;
    postMessage(message: unknown): void;
    start(): void;
    close(): void;
}

export function bindHostConnection(host: ProductionHost, port: HostMessagePort): HostConnection {
    let connection: HostConnection;
    connection = host.openConnection({
        send(message) {
            port.postMessage(message);
        },
        close() {
            port.close();
        },
    });
    port.on("message", (event) => {
        connection.receive(event.data);
    });
    port.on("close", () => {
        connection.close();
    });
    port.start();
    return connection;
}
