// D32.2 — what the cards of the registries show, over real HTTP on the built server (Scope §5.5,
// makieta 06): the records of each active registry and the widgets bound to it, on Książki of F01 and
// its table widget made through the API, beside a registry with no widget.
import { REGISTRIES_PATH, REGISTRY_SUMMARIES_PATH, registrySummaryListSchema, structurePath, structurePreviewPath, structurePreviewSchema } from "@openlife/contracts/http/registries";
import { afterEach, describe, expect, it } from "vitest";
import { post, send, stopServers, type Installation } from "../../support/auth-http.ts";
import { booksOverApi } from "../../support/books-http.ts";

afterEach(stopServers);

const summaries = async (setup: Installation, cookie: string) => {
  const reply = await send(setup.server, "GET", REGISTRY_SUMMARIES_PATH, undefined, { cookie });
  expect(reply.status).toBe(200);
  expect(reply.headers.get("cache-control")).toBe("no-store");
  return registrySummaryListSchema.parse(reply.json()).summaries.map(({ symbol, records, widgets }) => ({ symbol, records, widgets }));
};

describe("D32.2-AC1 the cards of the registries", () => {
  it("count the 25 records and the one widget of Książki, nothing for a registry without them, and forget a deleted registry", async () => {
    const { setup, cookie, registry } = await booksOverApi("d32-2");
    expect((await post(setup.server, REGISTRIES_PATH, { symbol: "waga", displayName: "Waga", columns: [{ symbol: "kg", displayName: "Kg", type: "number" }] }, { cookie })).status).toBe(201);
    expect(await summaries(setup, cookie)).toEqual([
      { symbol: "ksiazki", records: 25, widgets: 1 },
      { symbol: "waga", records: 0, widgets: 0 },
    ]);

    const preview = structurePreviewSchema.parse((await send(setup.server, "POST", structurePreviewPath(registry.symbol), { change: { kind: "deleteRegistry" } }, { cookie })).json());
    expect((await send(setup.server, "POST", structurePath(registry.symbol), { change: { kind: "deleteRegistry" }, planToken: preview.planToken }, { cookie })).status).toBe(200);
    expect(await summaries(setup, cookie)).toEqual([{ symbol: "waga", records: 0, widgets: 0 }]);
  });
});
