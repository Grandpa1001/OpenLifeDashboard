// Bounded read of a CLI's standard input.
export class StdinTooLargeError extends Error {
  constructor() {
    super("input exceeds the allowed size");
    this.name = "StdinTooLargeError";
  }
}

/** The whole stream as UTF-8 text; more than `maxBytes` rejects before it is held in memory. */
export async function readStdin(stream: AsyncIterable<Buffer | string>, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    size += buffer.length;
    if (size > maxBytes) {
      throw new StdinTooLargeError();
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
