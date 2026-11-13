// A request body read up to a limit that is known only when the request comes (D46.2): the declared length
// refuses a body that is too large before the first byte is read, and a body that does not declare one (or
// declares less than it sends) is counted as it arrives and abandoned at the limit, so a body of any size
// costs at most the limit in memory.

export type LimitedBody = Readonly<{ ok: true; bytes: Uint8Array }> | Readonly<{ ok: false }>;

export async function readBodyUpTo(request: Request, maxBytes: number): Promise<LimitedBody> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) return { ok: false };
  if (request.body === null) return { ok: true, bytes: new Uint8Array(0) };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false };
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return { ok: true, bytes };
}
