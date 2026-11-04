import type { RegistryDto } from "@openlife/contracts/http/registries";
import { LAYOUT_NAMES, type DesignSnapshotDto, type LayoutName, type ScreenDto, type WidgetDesignDto, type WidgetTypesDto } from "@openlife/contracts/http/screens";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useBlocker, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useReducer, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { describeFailure } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { newUuid7 } from "../../../lib/ids/uuid7.js";
import { useBreakpoint } from "../../../lib/layout/use-breakpoint.js";
import { useWindowWidth } from "../../../lib/layout/use-window-width.js";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { useGuardRecheck } from "../../../lib/session/use-guard-recheck.js";
import { useOwnerDisplay } from "../../../lib/session/use-owner-display.js";
import { fetchRegistries } from "../api/registries.js";
import { fetchScreen, fetchWidgetTypes } from "../api/screens.js";
import type { SaveState } from "../lib/autosave.js";
import { canRedo, canUndo, changedElsewhere, designerReducer, HISTORY_LIMIT, isDirty, newWidget, startState, toSnapshot } from "../lib/designer-state.js";
import { placeCopy, placeInEveryLayout } from "../lib/layout-edit.js";
import { previewWidth } from "../lib/preview-width.js";
import { typeLabelKey } from "../lib/type-label.js";
import { useAutosave } from "../lib/use-autosave.js";
import { AddWidgetDialog } from "./add-widget-dialog.js";
import { ContextBar } from "./context-bar.js";
import { DesignCanvas } from "./design-canvas.js";
import { UndoBar } from "./undo-bar.js";

type WidgetType = WidgetTypesDto["types"][number];
/** The grid of the layout being arranged, which takes the focus when the bar of a deletion is closed. */
const FRAME_SELECTOR = ".designer-frame";
/** How long the word that the layout came from another device stays (it takes no focus). */
const REFRESHED_NOTICE_MS = 6000;
/** How many frames a tile that is to take the focus is waited for. */
const TILE_FRAMES = 10;

/**
 * The Designer of the first screen (Scope §5.4, D18.2): the layout being arranged, the widgets of
 * the catalog to add, the canvas and the bindings of the selected widget. Every change saves itself
 * (D35.1); leaving waits for the save and asks only when it could not be made. A refused or
 * unreachable save leaves every change in place.
 */
export function DesignerEditor({ screen }: Readonly<{ screen: ScreenDto }>) {
  const { t } = useTranslation("designer");
  const { t: tw } = useTranslation("widgets");
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [state, dispatch] = useReducer(designerReducer, screen, startState);
  const [chosen, setChosen] = useState<LayoutName>("desktop");
  // On a phone the Designer arranges the layout of the phone only (Scope §5.4): the window cannot show another.
  const onPhone = useBreakpoint() === "phone";
  const layout: LayoutName = onPhone ? "phone" : chosen;
  const width = previewWidth(layout, useWindowWidth());
  const layoutButtons = useRef<Partial<Record<LayoutName, HTMLButtonElement | null>>>({});
  const display = useOwnerDisplay();
  const dirty = isDirty(state);
  const dirtyNow = useRef(dirty);
  dirtyNow.current = dirty;

  const types = useQuery({
    queryKey: queryKeys.screens.widgetTypes,
    queryFn: async ({ signal }) => {
      const result = await fetchWidgetTypes(signal);
      if (!result.ok) throw result.failure.kind === "aborted" ? new DOMException("aborted", "AbortError") : new Error("request failed");
      return result.value.types;
    },
  });
  const registryList = useQuery({
    queryKey: queryKeys.registries.list,
    queryFn: async ({ signal }) => {
      const result = await fetchRegistries(signal);
      if (!result.ok) throw result.failure.kind === "aborted" ? new DOMException("aborted", "AbortError") : new Error("request failed");
      return result.value.registries;
    },
  });
  const registries: readonly RegistryDto[] = registryList.data ?? [];

  const [gateLost, setGateLost] = useState(false);
  useGuardRecheck(gateLost);
  const onSaved = useCallback(
    (sent: DesignSnapshotDto, received: ScreenDto) => {
      dispatch({ kind: "saved", sent, received: { name: received.name, theme: received.theme, accent: received.accent, widgets: received.widgets.map(({ id, type, config, layout: placed, bindings }) => ({ id, type, config, layout: placed, bindings })) } });
      queryClient.setQueryData(queryKeys.screens.list, received);
      void queryClient.invalidateQueries({ queryKey: queryKeys.screens.allWidgetData });
    },
    [queryClient],
  );
  const autosave = useAutosave({ screenId: screen.id, design: state.design, dirty, onSaved, onGateLost: () => setGateLost(true) });
  const failure = autosave.state.kind === "refused" ? autosave.state.failure : null;

  // Another tab saved this screen (D35.3; until the events of D38): asked when this tab comes back or takes the focus.
  // A clean design takes the newer one with a passing word; a design with changes asks, and its changes still save.
  const [elsewhere, setElsewhere] = useState<Readonly<{ design: DesignSnapshotDto; at: string }> | null>(null);
  const [refreshed, setRefreshed] = useState(false);
  const stateNow = useRef(state);
  stateNow.current = state;
  const saving = useRef(false);
  saving.current = autosave.state.kind === "saving";
  useEffect(() => {
    let inFlight: AbortController | null = null;
    const check = async (): Promise<void> => {
      if (document.visibilityState !== "visible" || saving.current) return;
      inFlight?.abort();
      const controller = new AbortController();
      inFlight = controller;
      const read = await fetchScreen(screen.id, controller.signal);
      if (!read.ok || controller.signal.aborted || saving.current) return;
      const there = toSnapshot(read.value);
      if (!changedElsewhere(there, stateNow.current)) return;
      queryClient.setQueryData(queryKeys.screens.list, read.value);
      if (!dirtyNow.current) {
        dispatch({ kind: "loaded", design: there });
        setElsewhere(null);
        setRefreshed(true);
      } else setElsewhere({ design: there, at: read.value.updatedAt });
    };
    const onFocus = (): void => void check();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      inFlight?.abort();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [screen.id, queryClient]);
  useEffect(() => {
    if (!refreshed) return;
    const timer = setTimeout(() => setRefreshed(false), REFRESHED_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [refreshed]);

  // Leaving by any route first saves what is not saved; only a save that cannot be made asks (closing the tab warns, best effort).
  const blocker = useBlocker({ shouldBlockFn: async () => (dirtyNow.current ? !(await autosave.flush()) : false), enableBeforeUnload: () => dirtyNow.current, withResolver: true });

  const typeOf = (type: string): WidgetType | undefined => types.data?.find((candidate) => candidate.type === type);
  const selected = state.design.widgets.find((widget) => widget.id === state.selectedId) ?? null;

  /** The switch of the layout is one stop of Tab; the arrows go to the next layout and choose it (Scope §5.4). */
  function onLayoutKey(event: KeyboardEvent<HTMLButtonElement>): void {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = LAYOUT_NAMES[(LAYOUT_NAMES.indexOf(layout) + step + LAYOUT_NAMES.length) % LAYOUT_NAMES.length]!;
    setChosen(next);
    layoutButtons.current[next]?.focus();
  }

  const [adding, setAdding] = useState(false);
  const registryField = useRef<HTMLSelectElement>(null);
  // A widget just added: once it is drawn, the focus goes to the field of its registry (makieta 45).
  const [focusRegistryOf, setFocusRegistryOf] = useState<string | null>(null);
  useEffect(() => {
    if (focusRegistryOf !== null && state.selectedId === focusRegistryOf) {
      registryField.current?.focus();
      setFocusRegistryOf(null);
    }
  }, [focusRegistryOf, state.selectedId]);

  function add(type: WidgetType): void {
    setAdding(false);
    const id = newUuid7();
    dispatch({ kind: "add", widget: newWidget(id, type.type, type.configVersion, placeInEveryLayout(state.design.widgets, type.defaultSize)) });
    setFocusRegistryOf(id);
  }

  /** The tile of a widget takes the focus back, as Escape and Gotowe leave the settings. */
  const focusTile = (id: string): void => document.querySelector<HTMLButtonElement>(`[data-widget-id="${CSS.escape(id)}"] .designer-handle`)?.focus();
  // A tile that is to take the focus once it is drawn: the copy of Duplicate, a widget an undo brought back.
  const [focusTileOf, setFocusTileOf] = useState<string | null>(null);
  // The grid draws a widget that is new to it a frame later than the design has it, so the tile is looked for over a few frames.
  useEffect(() => {
    if (focusTileOf === null || !state.design.widgets.some((widget) => widget.id === focusTileOf)) return;
    let frames = 0;
    let frame = 0;
    const attempt = (): void => {
      const handle = document.querySelector<HTMLButtonElement>(`[data-widget-id="${CSS.escape(focusTileOf)}"] .designer-handle`);
      if (handle !== null || frames >= TILE_FRAMES) {
        handle?.focus();
        setFocusTileOf(null);
        return;
      }
      frames += 1;
      frame = requestAnimationFrame(attempt);
    };
    attempt();
    return () => cancelAnimationFrame(frame);
  }, [focusTileOf, state.design.widgets]);

  const titleOf = (widget: WidgetDesignDto): string => (typeof widget.config["title"] === "string" && widget.config["title"] !== "" ? widget.config["title"] : tw(typeLabelKey(widget.type)));

  function duplicate(widget: WidgetDesignDto): void {
    const copy: WidgetDesignDto = { ...widget, id: newUuid7(), config: { ...widget.config, title: `${titleOf(widget)} ${t("bar.copySuffix")}`.slice(0, 80) }, layout: placeCopy(state.design.widgets, widget.layout) };
    dispatch({ kind: "add", widget: copy });
    setFocusTileOf(copy.id);
  }

  // The bar "Undo" of the last deletion; any later step of the history closes it, since Undo would no longer take that deletion back.
  const [removed, setRemoved] = useState<Readonly<{ id: string; name: string; steps: number }> | null>(null);
  useEffect(() => {
    if (removed !== null && state.past.length !== removed.steps) setRemoved(null);
  }, [removed, state.past.length]);

  function undo(): void {
    dispatch({ kind: "undo" });
  }
  function redo(): void {
    dispatch({ kind: "redo" });
  }

  // Ctrl/⌘+Z and Ctrl/⌘+Shift+Z, except in a field that takes text, where they belong to the field.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "z") return;
      const target = event.target;
      if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable)) return;
      if (target instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit"].includes(target.type)) return;
      event.preventDefault();
      dispatch({ kind: event.shiftKey ? "redo" : "undo" });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const status = t(statusKey(autosave.state, dirty), { time: autosave.state.kind === "saved" ? new Intl.DateTimeFormat(display.locale, { hour: "2-digit", minute: "2-digit", timeZone: display.timeZone }).format(autosave.state.at) : "" });
  return (
    <>
      <header className="designer-toolbar">
        <h1>{t("title")}</h1>
        <p className="screen-name">{state.design.name}</p>
        {onPhone ? (
          <p className="designer-badge">{t("toolbar.phoneOnly")}</p>
        ) : (
          <div role="group" aria-label={t("toolbar.layouts")} className="designer-layouts">
            {LAYOUT_NAMES.map((name) => (
              <button
                key={name}
                ref={(element) => {
                  layoutButtons.current[name] = element;
                }}
                type="button"
                className="link-button"
                aria-pressed={layout === name}
                tabIndex={layout === name ? 0 : -1}
                onClick={() => setChosen(name)}
                onKeyDown={onLayoutKey}
              >
                {t(`toolbar.${name}`)}
              </button>
            ))}
          </div>
        )}
        <div className="designer-history" role="group" aria-label={t("toolbar.history")}>
          <button type="button" className="link-button" disabled={!canUndo(state)} onClick={undo} aria-keyshortcuts="Control+Z Meta+Z">
            {t("toolbar.undo")}
          </button>
          <button type="button" className="link-button" disabled={!canRedo(state)} onClick={redo} aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z">
            {t("toolbar.redo")}
          </button>
        </div>
        <p role="status" className="designer-status" data-dirty={dirty} data-save={autosave.state.kind}>
          {status}
        </p>
        <button type="button" onClick={() => void navigate({ to: "/" })}>
          {t("toolbar.finish")}
        </button>
      </header>
      {refreshed ? (
        <p className="designer-notice" role="status">
          {t("elsewhere.refreshed")}
        </p>
      ) : null}
      {elsewhere === null ? null : (
        <div className="designer-elsewhere" role="region" aria-label={t("elsewhere.label")}>
          <p>{t("elsewhere.changed", { time: new Intl.DateTimeFormat(display.locale, { hour: "2-digit", minute: "2-digit", timeZone: display.timeZone }).format(Date.parse(elsewhere.at)) })}</p>
          <button
            type="button"
            onClick={() => {
              dispatch({ kind: "loaded", design: elsewhere.design });
              setElsewhere(null);
            }}
          >
            {t("elsewhere.load")}
          </button>
          <button type="button" className="link-button" onClick={() => setElsewhere(null)}>
            {t("elsewhere.keep")}
          </button>
        </div>
      )}
      {failure === null ? null : (
        <div className="designer-save-failed">
          <FailureAlert message={describeFailure(failure)} />
          <button type="button" onClick={autosave.retryNow}>
            {t("retry")}
          </button>
        </div>
      )}
      {blocker.status === "blocked" ? (
        <div className="card designer-leave" role="alertdialog" aria-labelledby="designer-leave-heading" aria-describedby="designer-leave-text">
          <h2 id="designer-leave-heading">{t("leave.heading")}</h2>
          <p id="designer-leave-text">{t("leave.text")}</p>
          <button type="button" autoFocus onClick={blocker.reset}>
            {t("leave.stay")}
          </button>
          <button type="button" onClick={blocker.proceed}>
            {t("leave.discard")}
          </button>
        </div>
      ) : null}
      <ContextBar
        sheet={onPhone}
        widget={selected}
        layout={layout}
        minimum={selected === null ? { w: 1, h: 1 } : (typeOf(selected.type)?.minSize ?? { w: 1, h: 1 })}
        registries={registries}
        registriesFailed={registryList.isError}
        registryRef={registryField}
        onAdd={() => setAdding(true)}
        onBind={(change) => {
          if (selected === null) return;
          dispatch({ kind: "configured", id: selected.id, ...change });
        }}
        onConfigure={(config, field) => {
          if (selected === null) return;
          dispatch({ kind: "configured", id: selected.id, config, bindings: selected.bindings, ...(field === undefined ? {} : { field: `${selected.id}:${field}` }) });
        }}
        onSettle={() => dispatch({ kind: "settle" })}
        restored={state.restored}
        onPlace={(rect) => {
          if (selected === null) return;
          dispatch({ kind: "placed", layout, id: selected.id, rect, minimum: typeOf(selected.type)?.minSize ?? { w: 1, h: 1 } });
        }}
        onDuplicate={() => {
          if (selected !== null) duplicate(selected);
        }}
        onDelete={() => {
          if (selected === null) return;
          setRemoved({ id: selected.id, name: titleOf(selected), steps: Math.min(state.past.length + 1, HISTORY_LIMIT) });
          dispatch({ kind: "remove", id: selected.id });
        }}
        onDeselect={() => {
          const id = state.selectedId;
          dispatch({ kind: "select", id: null });
          if (id !== null) focusTile(id);
        }}
      />
      {removed === null ? null : (
        <UndoBar
          key={removed.id}
          name={removed.name}
          onUndo={() => {
            setRemoved(null);
            undo();
            setFocusTileOf(removed.id);
          }}
          onClose={(byEscape) => {
            setRemoved(null);
            if (byEscape) document.querySelector<HTMLElement>(FRAME_SELECTOR)?.focus();
          }}
        />
      )}
      {adding ? <AddWidgetDialog types={types.data ?? []} loading={types.isPending} failed={types.isError} onRetry={() => void types.refetch()} onPick={add} onClose={() => setAdding(false)} /> : null}
      <div className="designer-body">
        <DesignCanvas
          layout={layout}
          width={width}
          widgets={state.design.widgets}
          registries={registries}
          selectedId={state.selectedId}
          minimumOf={(type) => typeOf(type)?.minSize ?? { w: 1, h: 1 }}
          onSelect={(id) => dispatch({ kind: "select", id })}
          onPlace={(id, rect) => {
            const widget = state.design.widgets.find((each) => each.id === id);
            if (widget === undefined) return;
              dispatch({ kind: "placed", layout, id, rect, minimum: typeOf(widget.type)?.minSize ?? { w: 1, h: 1 } });
          }}
        />
      </div>
    </>
  );
}

/** What the bar says of the saving (makieta 29): a waiting change is being saved, "Saved" only after the server answered. */
function statusKey(state: SaveState, dirty: boolean): "toolbar.saving" | "toolbar.savedAt" | "toolbar.retrying" | "toolbar.offline" | "toolbar.refused" | "toolbar.clean" {
  switch (state.kind) {
    case "offline":
      return "toolbar.offline";
    case "retrying":
      return "toolbar.retrying";
    case "refused":
      return "toolbar.refused";
    case "saving":
      return "toolbar.saving";
    case "saved":
      return dirty ? "toolbar.saving" : "toolbar.savedAt";
    case "clean":
      return dirty ? "toolbar.saving" : "toolbar.clean";
  }
}
