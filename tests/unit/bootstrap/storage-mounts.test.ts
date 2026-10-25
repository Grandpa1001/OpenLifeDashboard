// D07.2-AC2 (decision part) — in a container the data and maintenance roots must be mount points,
// judged on the kernel's mount table; a process outside a container never asks for mounts. The
// real containers started without a mount are in tests/system/compose-persistence.ts.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { installationWorkingPaths, type WorkingPaths } from "../../../apps/server/src/adapters/filesystem/installation-paths.js";
import { parseMountPoints, readMountPoints } from "../../../apps/server/src/adapters/filesystem/mounts.js";
import { runStoragePreflight } from "../../../apps/server/src/adapters/filesystem/storage-preflight.js";

const scratch = mkdtempSync(path.join(os.tmpdir(), "openlife-mounts-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const MOUNTINFO = [
  "22 1 0:21 / / rw,relatime shared:1 - overlay overlay rw,lowerdir=/x",
  "30 22 8:1 /srv/openlife/data /data rw,relatime - ext4 /dev/sda1 rw",
  "31 22 8:1 /srv/openlife/control/maintenance /control/maintenance rw,relatime - ext4 /dev/sda1 rw",
  "32 22 8:1 /srv/with\\040space /mnt/with\\040space rw,relatime - ext4 /dev/sda1 rw",
  "33 22 0:50 / /proc rw - proc proc rw",
].join("\n");

describe("D07.2-AC2 reading the mount table", () => {
  it("takes the fifth field of each line and unescapes spaces", () => {
    const points = parseMountPoints(MOUNTINFO);
    expect([...points].sort()).toEqual(["/", "/control/maintenance", "/data", "/mnt/with space", "/proc"]);
    expect(points.has("/data/backup")).toBe(false);
  });

  it("an unreadable table is undefined, not an empty one", () => {
    expect(readMountPoints(path.join(scratch, "no-such-table"))).toBeUndefined();
  });
});

/** An installation folder with the layout of §15.1, used as the "container" paths of this test. */
function containerLike(): WorkingPaths {
  const dir = mkdtempSync(path.join(scratch, "installation-"));
  for (const parts of [["data", "backup"], ["data", "logs", "app"], ["data", "tmp"], ["control", "maintenance"]]) mkdirSync(path.join(dir, ...parts), { recursive: true });
  writeFileSync(path.join(dir, "control", "instance.json"), "{}");
  return { ...installationWorkingPaths(dir), requireMounts: true };
}

describe("D07.2-AC2 the preflight and mounts", () => {
  const RESERVE_MIB = 1;

  it("every root mounted → the usual checks run and pass", () => {
    const paths = containerLike();
    expect(runStoragePreflight(paths, RESERVE_MIB, () => new Set([paths.roots.data, paths.roots.maintenance]))).toEqual({ ok: true, degraded: [] });
  });

  it.each([
    ["no data mount", (paths: WorkingPaths) => new Set([paths.roots.maintenance]), ["data"]],
    ["no maintenance mount", (paths: WorkingPaths) => new Set([paths.roots.data]), ["maintenance"]],
    ["no mount at all", () => new Set<string>(), ["data", "maintenance"]],
  ])("%s → STORAGE_NOT_MOUNTED with the missing roles, before anything is probed or created", (_name, mounts, fields) => {
    const paths = containerLike();
    expect(runStoragePreflight(paths, RESERVE_MIB, () => mounts(paths))).toEqual({ ok: false, code: "STORAGE_NOT_MOUNTED", fields });
  });

  it("a mount table that cannot be read counts as not mounted", () => {
    const paths = containerLike();
    expect(runStoragePreflight(paths, RESERVE_MIB, () => undefined)).toEqual({ ok: false, code: "STORAGE_NOT_MOUNTED", fields: ["data", "maintenance"] });
  });

  it("a subfolder of a mount is not the mount: only the root itself counts", () => {
    const paths = containerLike();
    const result = runStoragePreflight(paths, RESERVE_MIB, () => new Set([path.join(paths.roots.data, "backup"), paths.roots.maintenance]));
    expect(result).toEqual({ ok: false, code: "STORAGE_NOT_MOUNTED", fields: ["data"] });
  });

  it("a process outside a container does not ask for mounts", () => {
    const paths = { ...containerLike(), requireMounts: false };
    expect(runStoragePreflight(paths, RESERVE_MIB, () => new Set<string>())).toEqual({ ok: true, degraded: [] });
  });
});
