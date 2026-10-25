// What the kernel says about a TCP connection between this test process and a server process on
// the loopback address. A test that must know the server has READ the bytes it was sent (not only
// that they arrived) cannot learn it from the server, and a fixed wait fails on a loaded machine.
// On Linux /proc/net/tcp has both ends of the connection: nothing is left unacknowledged on the
// client's side (tx_queue) and nothing is left unread on the server's side (rx_queue). Elsewhere
// there is no such table and only a pause is possible: a local convenience, not a proof.
import { readFileSync } from "node:fs";

const PROC_TCP = "/proc/net/tcp";
const POLL_MS = 5;
const FALLBACK_PAUSE_MS = 500;

export type TcpEntry = Readonly<{ localPort: number; remotePort: number; txQueue: number; rxQueue: number }>;

/** The rows of a /proc/net/tcp table: ports and the two queue lengths (hexadecimal in the file). */
export function parseTcpTable(table: string): TcpEntry[] {
  return table
    .split("\n")
    .slice(1)
    .flatMap((line) => {
      const fields = line.trim().split(/\s+/);
      const [local, remote, queues] = [fields[1], fields[2], fields[4]];
      if (local === undefined || remote === undefined || queues === undefined) return [];
      const [tx, rx] = queues.split(":");
      return [
        {
          localPort: parseInt(local.split(":")[1] ?? "", 16),
          remotePort: parseInt(remote.split(":")[1] ?? "", 16),
          txQueue: parseInt(tx ?? "", 16),
          rxQueue: parseInt(rx ?? "", 16),
        },
      ];
    });
}

/** Both ends found, nothing unacknowledged at the client and nothing unread at the server. */
export function serverHasRead(entries: readonly TcpEntry[], serverPort: number, clientPort: number): boolean {
  const client = entries.find((entry) => entry.localPort === clientPort && entry.remotePort === serverPort);
  const server = entries.find((entry) => entry.localPort === serverPort && entry.remotePort === clientPort);
  return client?.txQueue === 0 && server?.rxQueue === 0;
}

/**
 * Resolves true when the connection between our `clientPort` and the server's `serverPort` has
 * all bytes acknowledged by the server's kernel AND read by the server process; false after
 * `timeoutMs`. Without /proc/net/tcp it only pauses.
 */
export async function serverHasReadEverything(serverPort: number, clientPort: number, timeoutMs: number): Promise<boolean> {
  if (process.platform !== "linux") {
    await new Promise((resolve) => setTimeout(resolve, FALLBACK_PAUSE_MS));
    return true;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (serverHasRead(parseTcpTable(readFileSync(PROC_TCP, "utf8")), serverPort, clientPort)) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return false;
}
