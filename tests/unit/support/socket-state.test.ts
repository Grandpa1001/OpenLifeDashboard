// The Linux path of the shutdown tests' synchronization (tests/support/socket-state.ts) cannot run
// on a developer's Mac, so its parser and decision are checked here on rows in the exact format of
// /proc/net/tcp; CI runs the real thing on Linux.
import { describe, expect, it } from "vitest";
import { parseTcpTable, serverHasRead } from "../../support/socket-state.ts";

const SERVER = 0x1f90; // 8080
const CLIENT = 0xc350; // 50000
const header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
const row = (index: number, local: string, remote: string, state: string, queues: string): string =>
  `   ${index}: ${local} ${remote} ${state} ${queues} 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0`;
const table = (...rows: string[]): string => [header, ...rows, ""].join("\n");

describe("socket-state", () => {
  it("parses ports and queues from the hexadecimal columns", () => {
    const entries = parseTcpTable(table(row(0, "0100007F:1F90", "00000000:0000", "0A", "00000000:00000000"), row(1, "0100007F:1F90", "0100007F:C350", "01", "00000000:0000002D")));
    expect(entries).toEqual([
      { localPort: SERVER, remotePort: 0, txQueue: 0, rxQueue: 0 },
      { localPort: SERVER, remotePort: CLIENT, txQueue: 0, rxQueue: 45 },
    ]);
  });

  const ends = (clientTx: string, serverRx: string): string =>
    table(
      row(0, "0100007F:1F90", "00000000:0000", "0A", "00000000:00000000"),
      row(1, "0100007F:C350", "0100007F:1F90", "01", `${clientTx}:00000000`),
      row(2, "0100007F:1F90", "0100007F:C350", "01", `00000000:${serverRx}`),
    );

  it("is true only when the client has nothing unacknowledged and the server nothing unread", () => {
    expect(serverHasRead(parseTcpTable(ends("00000000", "00000000")), SERVER, CLIENT)).toBe(true);
    expect(serverHasRead(parseTcpTable(ends("00000000", "0000002D")), SERVER, CLIENT)).toBe(false);
    expect(serverHasRead(parseTcpTable(ends("0000002D", "00000000")), SERVER, CLIENT)).toBe(false);
  });

  it("is false while either end of the connection is missing (not accepted or not yet visible)", () => {
    expect(serverHasRead(parseTcpTable(table(row(1, "0100007F:C350", "0100007F:1F90", "01", "00000000:00000000"))), SERVER, CLIENT)).toBe(false);
    expect(serverHasRead(parseTcpTable(table(row(2, "0100007F:1F90", "0100007F:C350", "01", "00000000:00000000"))), SERVER, CLIENT)).toBe(false);
    expect(serverHasRead([], SERVER, CLIENT)).toBe(false);
  });

  it("ignores other connections of the same server", () => {
    const others = table(row(1, "0100007F:C351", "0100007F:1F90", "01", "00000000:00000000"), row(2, "0100007F:1F90", "0100007F:C351", "01", "00000000:00000000"));
    expect(serverHasRead(parseTcpTable(others), SERVER, CLIENT)).toBe(false);
  });
});
