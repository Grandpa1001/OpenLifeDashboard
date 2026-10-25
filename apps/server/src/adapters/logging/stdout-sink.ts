import process from "node:process";
import type { LogSink } from "./technical-logger.js";

/** Standard output stays available when the log folder is not (Architektura §15.2). */
export const stdoutSink: LogSink = {
  write(line) {
    process.stdout.write(line);
  },
};
