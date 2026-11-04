// D36.1 — the clocks of F01 over real HTTP on the built server (Scope §6.3; Architektura §8.1, §18.5):
// the screen of F01 with its table and its two clocks saved and read back, the clocks ok without any
// binding, and a clock with an unknown zone or a caption too long refused at its configuration.
import { screenDesignPath, screenPath, screenSchema, widgetDataPath, widgetDataSchema } from "@openlife/contracts/http/screens";
import { afterEach, describe, expect, it } from "vitest";
import { send, stopServers } from "../../support/auth-http.ts";
import { booksOverApi, SCREEN, tableWidget } from "../../support/books-http.ts";

afterEach(stopServers);

const clocks = SCREEN.widgets.filter((widget) => widget.type === "clock");

describe("D36.1-AC1 the screen of F01 with its clocks", () => {
  it("the table and the clocks Dom and Nowy Jork are saved and read back as F01 holds them, the clocks ok and without data of their own", async () => {
    const { setup, cookie, registry, screenId } = await booksOverApi("d36-1-clocks");
    expect(clocks.map((clock) => clock.config["label"])).toEqual(["Dom", "Nowy Jork"]);
    const reply = await send(setup.server, "PUT", screenDesignPath(screenId), { name: SCREEN.name, theme: "dark", accent: "blue", widgets: [tableWidget(registry), ...clocks] }, { cookie });
    expect(reply.status).toBe(200);
    const screen = screenSchema.parse((await send(setup.server, "GET", screenPath(screenId), undefined, { cookie })).json());
    const read = screen.widgets.filter((widget) => widget.type === "clock");
    expect(read.map(({ id, config, layout, bindings, state }) => ({ id, config, layout, bindings, state }))).toEqual(clocks.map(({ id, config, layout }) => ({ id, config, layout, bindings: [], state: "ok" })));
    // A clock reads nothing of the server: its data are no registry, no column and no row.
    const data = await send(setup.server, "GET", widgetDataPath(clocks[0]!.id), undefined, { cookie });
    expect(data.status).toBe(200);
    expect(widgetDataSchema.parse(data.json())).toMatchObject({ state: "ok", registry: null, columns: [], rows: [], total: 0 });
  });
});

describe("D36.1-AC2 what a clock may not be", () => {
  it("an unknown zone and a caption over 40 characters are 422 at the configuration, and the screen is as it was", async () => {
    const { setup, cookie, registry, screenId } = await booksOverApi("d36-1-refuse");
    const before = (await send(setup.server, "GET", screenPath(screenId), undefined, { cookie })).json();
    const clock = clocks[1]!;
    for (const config of [{ ...clock.config, timezone: "Mars/Olympus" }, { ...clock.config, label: "x".repeat(41) }, { ...clock.config, format: "36h" }]) {
      const reply = await send(setup.server, "PUT", screenDesignPath(screenId), { name: SCREEN.name, theme: "dark", accent: "blue", widgets: [tableWidget(registry), { ...clock, config }] }, { cookie });
      expect(reply.status, JSON.stringify(config)).toBe(422);
      expect(((reply.json() as { details: { issues: Array<{ path: string; code: string }> } }).details.issues).map((issue) => `${issue.path}:${issue.code}`)).toContain("widgets.1.config:CONFIG_INVALID");
      expect((await send(setup.server, "GET", screenPath(screenId), undefined, { cookie })).json()).toEqual(before);
    }
  });
});
