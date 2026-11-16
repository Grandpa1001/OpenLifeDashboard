// What the updater may do with Docker (Architektura §11.2.1; D52.4). It has the socket, which in practice is the
// host, so the code does not rely on the care of its caller: every container it acts on is looked up by the labels of
// the Compose project it was configured with and checked again by inspection before each action, so the id of a
// container of another installation, of a container of the same project that is not the app, or of one with no labels
// is refused (`OUT_OF_SCOPE`) and nothing is sent to it. The images are named by a digest (a repository with a digest,
// or the id of an image already on the host), and a command to a helper holds a name of a package that matches the
// shape of one, never a path or a shell word. The scope is not a sandbox of Docker; it keeps the updater to its own
// project and to the few things an update needs.
import { randomBytes } from "node:crypto";
import { demuxLog, jsonOf, type EngineClient } from "./engine-client.js";

const PROJECT_LABEL = "com.docker.compose.project";
const SERVICE_LABEL = "com.docker.compose.service";
const WORKING_DIR_LABEL = "com.docker.compose.project.working_dir";
export const HELPER_LABEL = "com.openlife.updater.helper";
const PINNED_IMAGE = /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/;
const LOCAL_IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const PACKAGE_NAME = /^\d{8}T\d{6}Z-[a-z_]+-[0-9a-f-]{36}$/;
const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]*$/;
/** The path of the command the helper runs in the app image, fixed here and never from a request. */
const RESTORE_COMMAND_PATH = "apps/server/dist/cli/restore-instance.js";

export type ScopeCode = "OUT_OF_SCOPE" | "APP_NOT_FOUND" | "APP_AMBIGUOUS" | "IMAGE_INVALID" | "PACKAGE_INVALID" | "SOCKET_MOUNT_REFUSED" | "UNHEALTHY" | "SWITCH_FAILED";
export class ScopeError extends Error {
  readonly code: ScopeCode;
  constructor(code: ScopeCode) {
    super(code);
    this.code = code;
  }
}

export type ProjectScopeOptions = Readonly<{
  client: EngineClient;
  /** The Compose project of this installation (`COMPOSE_PROJECT_NAME`), a trusted setting of the installation. */
  project: string;
  /** The folder of the installation on the host, when known: a container of another folder under the same name is refused too. */
  workingDir?: string;
  newId?: () => string;
}>;

type Inspect = Readonly<{
  Id: string;
  Name: string;
  Image: string;
  Config: Readonly<Record<string, unknown>> & { Labels?: Record<string, string>; Env?: string[]; User?: string };
  HostConfig: Readonly<Record<string, unknown>> & { Mounts?: Array<{ Source?: string }>; Binds?: string[] };
  State: Readonly<{ Running: boolean; Status: string; ExitCode: number; StartedAt: string; Health?: { Status: string } }>;
  NetworkSettings: Readonly<{ Networks: Record<string, { Aliases?: string[] | null }> }>;
}>;

export type OwnApp = Readonly<{ id: string; name: string }>;
export type Replacement = Readonly<{ previousId: string; previousName: string; nextId: string; name: string }>;
export type RecoveryResult = Readonly<{ exitCode: number; event: Readonly<Record<string, unknown>> | null }>;

export const isPinnedImage = (image: string): boolean => PINNED_IMAGE.test(image) || LOCAL_IMAGE_ID.test(image);

export function createProjectScope(options: ProjectScopeOptions) {
  if (!PROJECT_NAME.test(options.project)) throw new ScopeError("OUT_OF_SCOPE");
  const { client, project } = options;
  const newId = options.newId ?? ((): string => randomBytes(4).toString("hex"));
  const enc = encodeURIComponent;

  const inspect = async (id: string): Promise<Inspect> => jsonOf<Inspect>(await client.request("GET", `/containers/${enc(id)}/json`));

  /** The container must carry this project and this service, and the folder of the installation when it is known. */
  async function own(id: string, service: string): Promise<Inspect> {
    let found: Inspect;
    try {
      found = await inspect(id);
    } catch {
      throw new ScopeError("OUT_OF_SCOPE");
    }
    const labels = found.Config.Labels ?? {};
    if (labels[PROJECT_LABEL] !== project || labels[SERVICE_LABEL] !== service) throw new ScopeError("OUT_OF_SCOPE");
    if (options.workingDir !== undefined && labels[WORKING_DIR_LABEL] !== options.workingDir) throw new ScopeError("OUT_OF_SCOPE");
    return found;
  }

  async function findApp(): Promise<OwnApp> {
    const filters = JSON.stringify({ label: [`${PROJECT_LABEL}=${project}`, `${SERVICE_LABEL}=app`] });
    const list = jsonOf<Array<{ Id: string; Names: string[]; Labels?: Record<string, string> }>>(await client.request("GET", `/containers/json?all=1&filters=${enc(filters)}`));
    // The filter is a request to the Engine, not a check: what comes back is inspected again.
    const mine = list.filter((container) => !(container.Labels ?? {})[HELPER_LABEL]);
    if (mine.length === 0) throw new ScopeError("APP_NOT_FOUND");
    if (mine.length > 1) throw new ScopeError("APP_AMBIGUOUS");
    const app = await own(mine[0]!.Id, "app");
    return { id: app.Id, name: app.Name.replace(/^\//, "") };
  }

  async function pull(image: string): Promise<void> {
    if (!isPinnedImage(image)) throw new ScopeError("IMAGE_INVALID");
    if (LOCAL_IMAGE_ID.test(image)) return;
    const reply = await client.request("POST", `/images/create?fromImage=${enc(image)}`);
    if (reply.status !== 200) jsonOf(reply);
    // A pull is a stream of lines; a failure is a line with an error, the status stays 200.
    for (const line of reply.body.toString("utf8").split("\n")) {
      if (line.trim() === "") continue;
      const parsed = JSON.parse(line) as { error?: unknown };
      if (typeof parsed.error === "string") throw new ScopeError("IMAGE_INVALID");
    }
  }

  async function imageIdOf(image: string): Promise<string> {
    if (!isPinnedImage(image)) throw new ScopeError("IMAGE_INVALID");
    return jsonOf<{ Id: string }>(await client.request("GET", `/images/${enc(image)}/json`)).Id;
  }

  /** The body of a container that is the same as an existing one but for the image, as Compose would have made it. */
  function copyOf(old: Inspect, image: string): Record<string, unknown> {
    const config = old.Config as Record<string, unknown>;
    const networks = Object.fromEntries(Object.entries(old.NetworkSettings.Networks).map(([name, network]) => [name, { Aliases: (network.Aliases ?? []).filter((alias) => !old.Id.startsWith(alias)) }]));
    return {
      Image: image,
      Env: config["Env"],
      Cmd: config["Cmd"],
      Entrypoint: config["Entrypoint"],
      User: config["User"],
      WorkingDir: config["WorkingDir"],
      Labels: config["Labels"],
      Healthcheck: config["Healthcheck"],
      ExposedPorts: config["ExposedPorts"],
      StopSignal: config["StopSignal"],
      StopTimeout: config["StopTimeout"],
      HostConfig: old.HostConfig,
      NetworkingConfig: { EndpointsConfig: networks },
    };
  }

  async function waitHealthy(id: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const state = (await own(id, "app")).State;
      if (state.Running && state.Health?.Status === "healthy") return;
      if (!state.Running && state.Status === "exited") throw new ScopeError("UNHEALTHY");
      if (Date.now() > deadline) throw new ScopeError("UNHEALTHY");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  /**
   * The app of this project replaced by a container of the same configuration and another image. The new one is made
   * first under the name of the old, which is renamed aside and then stopped, so the switch is one stop and one start;
   * a failure puts the old one back. The old container is kept (stopped) for the way back until `discard` is called.
   */
  async function replaceApp(app: OwnApp, image: string): Promise<Replacement> {
    if (!isPinnedImage(image)) throw new ScopeError("IMAGE_INVALID");
    const old = await own(app.id, "app");
    const name = old.Name.replace(/^\//, "");
    const previousName = `${name}-previous-${newId()}`;
    let nextId: string | undefined;
    let renamed = false;
    let stopped = false;
    try {
      jsonOf(await client.request("POST", `/containers/${enc(old.Id)}/rename?name=${enc(previousName)}`), [204]);
      renamed = true;
      nextId = jsonOf<{ Id: string }>(await client.request("POST", `/containers/create?name=${enc(name)}`, copyOf(old, image))).Id;
      jsonOf(await client.request("POST", `/containers/${enc(old.Id)}/stop`), [204, 304]);
      stopped = true;
      jsonOf(await client.request("POST", `/containers/${enc(nextId)}/start`), [204, 304]);
      return { previousId: old.Id, previousName, nextId, name };
    } catch (error) {
      if (nextId !== undefined) await client.request("DELETE", `/containers/${enc(nextId)}?force=1`).catch(() => undefined);
      if (renamed) await client.request("POST", `/containers/${enc(old.Id)}/rename?name=${enc(name)}`).catch(() => undefined);
      if (stopped || !old.State.Running) await client.request("POST", `/containers/${enc(old.Id)}/start`).catch(() => undefined);
      if (error instanceof ScopeError) throw error;
      throw new ScopeError("SWITCH_FAILED");
    }
  }

  /** The way back of a replacement: the new app is removed, the old one gets its name again and starts. */
  async function rollbackApp(replacement: Replacement): Promise<void> {
    await own(replacement.nextId, "app");
    await own(replacement.previousId, "app");
    jsonOf(await client.request("POST", `/containers/${enc(replacement.nextId)}/stop`), [204, 304]);
    jsonOf(await client.request("DELETE", `/containers/${enc(replacement.nextId)}`), [204]);
    jsonOf(await client.request("POST", `/containers/${enc(replacement.previousId)}/rename?name=${enc(replacement.name)}`), [204]);
    jsonOf(await client.request("POST", `/containers/${enc(replacement.previousId)}/start`), [204, 304]);
  }

  /** The old app after a replacement that is committed: it is not needed any more. */
  async function discardPrevious(replacement: Replacement): Promise<void> {
    await own(replacement.previousId, "app");
    jsonOf(await client.request("DELETE", `/containers/${enc(replacement.previousId)}?force=1`), [204]);
  }

  async function stopApp(app: OwnApp): Promise<void> {
    await own(app.id, "app");
    jsonOf(await client.request("POST", `/containers/${enc(app.id)}/stop`), [204, 304]);
  }

  async function startApp(app: OwnApp): Promise<void> {
    await own(app.id, "app");
    jsonOf(await client.request("POST", `/containers/${enc(app.id)}/start`), [204, 304]);
  }

  /**
   * A short-lived container of a pinned image that restores the database of this installation from a package by the
   * command of the app image, with the environment and the folders of the app (so it opens the same keys and writes the
   * same data) and nothing else: no port, no network, a read-only root, no capability, and a command that holds a name
   * of a package of the shape the store makes. The app must be stopped: the command takes the lease.
   */
  async function runRecovery(app: OwnApp, image: string, snapshot: string): Promise<RecoveryResult> {
    if (!isPinnedImage(image)) throw new ScopeError("IMAGE_INVALID");
    if (!PACKAGE_NAME.test(snapshot)) throw new ScopeError("PACKAGE_INVALID");
    const old = await own(app.id, "app");
    if (old.State.Running) throw new ScopeError("SWITCH_FAILED");
    const mounts = (old.HostConfig.Mounts ?? []).map((mount) => mount.Source ?? "").concat((old.HostConfig.Binds ?? []).map((bind) => bind.split(":")[0] ?? ""));
    if (mounts.some((source) => /docker\.sock$/.test(source))) throw new ScopeError("SOCKET_MOUNT_REFUSED");
    const input = JSON.stringify({ snapshot, confirm: "replace-current-database" });
    const name = `${project}-recovery-${newId()}`;
    const body = {
      Image: image,
      User: old.Config.User,
      Env: old.Config.Env,
      Entrypoint: ["sh", "-c"],
      Cmd: [`printf '%s' '${input}' | node ${RESTORE_COMMAND_PATH}`],
      Labels: { [PROJECT_LABEL]: project, [SERVICE_LABEL]: "recovery-helper", [HELPER_LABEL]: "1" },
      NetworkDisabled: true,
      HostConfig: {
        Mounts: old.HostConfig.Mounts,
        Binds: old.HostConfig.Binds,
        NetworkMode: "none",
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        Tmpfs: { "/tmp": "size=64m,mode=1777" },
        RestartPolicy: { Name: "no" },
        AutoRemove: false,
      },
    };
    const id = jsonOf<{ Id: string }>(await client.request("POST", `/containers/create?name=${enc(name)}`, body)).Id;
    try {
      jsonOf(await client.request("POST", `/containers/${enc(id)}/start`), [204]);
      const exit = jsonOf<{ StatusCode: number }>(await client.request("POST", `/containers/${enc(id)}/wait?condition=not-running`));
      const log = demuxLog((await client.request("GET", `/containers/${enc(id)}/logs?stdout=1&stderr=1`)).body);
      let event: Record<string, unknown> | null = null;
      for (const line of log.split("\n")) {
        try {
          const parsed: unknown = JSON.parse(line);
          if (typeof parsed === "object" && parsed !== null && "event" in parsed) event = parsed as Record<string, unknown>;
        } catch {
          // Not a line of JSON.
        }
      }
      return { exitCode: exit.StatusCode, event };
    } finally {
      await client.request("DELETE", `/containers/${enc(id)}?force=1`).catch(() => undefined);
    }
  }

  return { findApp, pull, imageIdOf, waitHealthy, replaceApp, rollbackApp, discardPrevious, stopApp, startApp, runRecovery, inspectApp: (id: string) => own(id, "app"), own };
}

export type ProjectScope = ReturnType<typeof createProjectScope>;
