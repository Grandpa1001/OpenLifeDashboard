// D57.2 — what the state of an update says to the owner (Scope §5.9, S14; Architektura §11.2.2 step 8): when the page asks again, at which stage the operation is,
// and what became of it once it is over, told from the state alone; every code the updater ends an operation with has a sentence in both languages.
import type { UpdatesStatusDto } from "@openlife/contracts/http/updates";
import { UPDATE_STATES } from "@openlife/contracts/updates/state";
import { describe, expect, it } from "vitest";
import { isGoingOn, KNOWN_RESULT_CODES, resultOf, shouldPoll, UPDATE_STAGES, type OperationDto } from "../../../apps/web/src/lib/updates/operation-view.js";
import en from "../../../apps/web/src/locales/en/settings.json" with { type: "json" };
import pl from "../../../apps/web/src/locales/pl/settings.json" with { type: "json" };

const ID = "11111111-1111-4111-8111-111111111111";
const status = (operation: OperationDto | null, current = "1.1.0"): UpdatesStatusDto => ({ configured: true, enabled: true, current, available: true, latest: null, checkedAt: null, nextCheckAt: null, error: null, retryAt: null, operation });
const operation = (state: OperationDto["state"], over: Partial<OperationDto> = {}): OperationDto => ({ operationId: ID, state, targetRelease: "1.2.0", error: null, ...over });

describe("D57.2-AC1 the page asks again exactly while an update goes on, and says where it is", () => {
  it("goes on in every state that the updater works in or waits in, and in none that is over", () => {
    const going = UPDATE_STATES.filter((state) => isGoingOn(operation(state)));
    expect(going).toEqual(["checking", "pulling", "quiescing", "backing_up", "switching", "verifying", "committing", "rolling_back"]);
    expect(isGoingOn(null)).toBe(false);
    expect(isGoingOn(undefined)).toBe(false);
  });

  it("polls on the state of an update that goes on, and on nothing else", () => {
    expect(shouldPoll(status(operation("pulling")))).toBe(true);
    expect(shouldPoll(status(operation("completed")))).toBe(false);
    expect(shouldPoll(status(null))).toBe(false);
    expect(shouldPoll(undefined)).toBe(false);
  });

  it("names a stage for every state of the way forward, in order", () => {
    expect(UPDATE_STAGES).toEqual(["checking", "pulling", "quiescing", "backing_up", "switching", "verifying", "committing"]);
  });
});

describe("D57.2-AC2 the result is told from the state, and every code has its sentence", () => {
  it("is a success only when the application that answers is the release the operation was for", () => {
    expect(resultOf(status(operation("completed"), "1.2.0"), null)).toEqual({ kind: "updated", operationId: ID, version: "1.2.0" });
    // Completed, but the application still answering is the old one: nothing is said yet (the state is read again).
    expect(resultOf(status(operation("completed"), "1.1.0"), null)).toBeNull();
  });

  it("is a return with the code for an operation that ended idle or rolled back with one, and nothing for one that has none", () => {
    expect(resultOf(status(operation("idle", { error: { code: "B_MIGRATION_FAILED" } })), null)).toEqual({ kind: "returned", operationId: ID, code: "B_MIGRATION_FAILED" });
    expect(resultOf(status(operation("rolled_back", { error: { code: "START_TIMEOUT" } })), null)).toEqual({ kind: "returned", operationId: ID, code: "START_TIMEOUT" });
    expect(resultOf(status(operation("idle")), null)).toBeNull();
  });

  it("holds the installation for recovery_failed, with or without a code, and is never closed by the owner's earlier choice", () => {
    expect(resultOf(status(operation("recovery_failed", { error: { code: "RESTORE_FAILED" } })), null)).toEqual({ kind: "stuck", operationId: ID, code: "RESTORE_FAILED" });
    expect(resultOf(status(operation("recovery_failed")), null)).toEqual({ kind: "stuck", operationId: ID, code: null });
  });

  it("says nothing of an operation the owner has closed, nor of one that goes on, nor when there is none", () => {
    expect(resultOf(status(operation("completed"), "1.2.0"), ID)).toBeNull();
    expect(resultOf(status(operation("verifying")), null)).toBeNull();
    expect(resultOf(status(null), null)).toBeNull();
    expect(resultOf(undefined, null)).toBeNull();
  });

  it("has a sentence in Polish and in English for every code the updater ends an operation with, and for an unknown one", () => {
    for (const texts of [en, pl]) {
      const codes = texts.updates.result.codes as Record<string, string>;
      for (const code of [...KNOWN_RESULT_CODES, "UNKNOWN"]) expect(codes[code]?.length, code).toBeGreaterThan(10);
      expect(Object.keys(codes).sort()).toEqual([...KNOWN_RESULT_CODES, "UNKNOWN"].sort());
    }
    for (const texts of [en, pl]) for (const stage of [...UPDATE_STAGES, "rolling_back"]) expect((texts.updates.progress.stage as Record<string, string>)[stage]?.length, stage).toBeGreaterThan(5);
  });
});
