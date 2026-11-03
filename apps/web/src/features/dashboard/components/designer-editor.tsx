import type { RegistryDto } from "@openlife/contracts/http/registries";
import { LAYOUT_NAMES, type DesignSnapshotDto, type LayoutName, type ScreenDto, type WidgetDesignDto, type WidgetTypesDto } from "@openlife/contracts/http/screens";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBlocker, useNavigate } from "@tanstack/react-router";
import { useEffect, useReducer, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ApiFailure } from "../../../lib/api-client/request.js";
import { describeFailure } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { newUuid7 } from "../../../lib/ids/uuid7.js";
import { useBreakpoint } from "../../../lib/layout/use-breakpoint.js";
import { useWindowWidth } from "../../../lib/layout/use-window-width.js";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { useGuardRecheck } from "../../../lib/session/use-guard-recheck.js";
import { fetchRegistries } from "../api/registries.js";
import { fetchWidgetTypes, saveDesign } from "../api/screens.js";
import { designerReducer, isDirty, newWidget, startState } from "../lib/designer-state.js";
import { placeCopy, placeInEveryLayout } from "../lib/layout-edit.js";
import { previewWidth } from "../lib/preview-width.js";
import { typeLabelKey } from "../lib/type-label.js";
import { AddWidgetDialog } from "./add-widget-dialog.js";
import { ContextBar } from "./context-bar.js";
import { DesignCanvas } from "./design-canvas.js";

class SaveFailure extends Error {
  readonly failure: ApiFailure;

  constructor(failure: ApiFailure) {
    super("design not saved");
    this.name = "SaveFailure";
    this.failure = failure;
  }
}

type WidgetType = WidgetTypesDto["types"][number];

/**
 * The Designer of the first screen (Scope §5.4, D18.2): the layout being arranged, the widgets of
 * the catalog to add, the canvas and the bindings of the selected widget. The owner saves
 * explicitly; leaving with unsaved changes asks first. A refused or unreachable save leaves every
 * change in place and can be repeated.
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
  const [justSaved, setJustSaved] = useState(false);
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

  const save = useMutation({
    mutationFn: async (design: DesignSnapshotDto) => {
      const result = await saveDesign(screen.id, design);
      if (!result.ok) throw new SaveFailure(result.failure);
      return result.value;
    },
    onSuccess: (received, sent) => {
      dispatch({ kind: "saved", sent, received: { name: received.name, theme: received.theme, accent: received.accent, widgets: received.widgets.map(({ id, type, config, layout: placed, bindings }) => ({ id, type, config, layout: placed, bindings })) } });
      queryClient.setQueryData(queryKeys.screens.list, received);
      void queryClient.invalidateQueries({ queryKey: queryKeys.screens.allWidgetData });
      setJustSaved(true);
    },
  });
  const failure = save.error instanceof SaveFailure ? save.error.failure : null;
  useGuardRecheck(failure !== null && failure.kind === "api" && (failure.status === 401 || failure.status === 403));

  // Leaving by any route (the button, a link, the back button, closing the tab) asks first while changes are unsaved.
  const blocker = useBlocker({ shouldBlockFn: () => dirtyNow.current, enableBeforeUnload: () => dirtyNow.current, withResolver: true });

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
    setJustSaved(false);
    setAdding(false);
    const id = newUuid7();
    dispatch({ kind: "add", widget: newWidget(id, type.type, type.configVersion, placeInEveryLayout(state.design.widgets, type.defaultSize)) });
    setFocusRegistryOf(id);
  }

  /** The tile of a widget takes the focus back, as Escape and Gotowe leave the settings. */
  const focusTile = (id: string): void => document.querySelector<HTMLButtonElement>(`[data-widget-id="${CSS.escape(id)}"] .designer-handle`)?.focus();

  function duplicate(widget: WidgetDesignDto): void {
    setJustSaved(false);
    const title = typeof widget.config["title"] === "string" && widget.config["title"] !== "" ? widget.config["title"] : tw(typeLabelKey(widget.type));
    const copy: WidgetDesignDto = { ...widget, id: newUuid7(), config: { ...widget.config, title: `${title} ${t("bar.copySuffix")}`.slice(0, 80) }, layout: placeCopy(state.design.widgets, widget.layout) };
    dispatch({ kind: "add", widget: copy });
  }

  const status = save.isPending ? t("toolbar.saving") : dirty ? t("toolbar.dirty") : justSaved ? t("toolbar.saved") : t("toolbar.clean");
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
        <button
          type="button"
          disabled={!dirty || save.isPending}
          onClick={() => {
            setJustSaved(false);
            save.mutate(state.design);
          }}
        >
          {t("toolbar.save")}
        </button>
        <p role="status" className="designer-status" data-dirty={dirty}>
          {status}
        </p>
        <button type="button" onClick={() => void navigate({ to: "/" })}>
          {t("toolbar.finish")}
        </button>
      </header>
      {failure === null || failure.kind === "aborted" ? null : <FailureAlert message={describeFailure(failure)} />}
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
        widget={selected}
        layout={layout}
        minimum={selected === null ? { w: 1, h: 1 } : (typeOf(selected.type)?.minSize ?? { w: 1, h: 1 })}
        registries={registries}
        registriesFailed={registryList.isError}
        registryRef={registryField}
        onAdd={() => setAdding(true)}
        onBind={(change) => {
          if (selected === null) return;
          setJustSaved(false);
          dispatch({ kind: "configured", id: selected.id, ...change });
        }}
        onConfigure={(config) => {
          if (selected === null) return;
          setJustSaved(false);
          dispatch({ kind: "configured", id: selected.id, config, bindings: selected.bindings });
        }}
        onPlace={(rect) => {
          if (selected === null) return;
          setJustSaved(false);
          dispatch({ kind: "placed", layout, id: selected.id, rect, minimum: typeOf(selected.type)?.minSize ?? { w: 1, h: 1 } });
        }}
        onDuplicate={() => {
          if (selected !== null) duplicate(selected);
        }}
        onDelete={() => {
          if (selected === null) return;
          setJustSaved(false);
          dispatch({ kind: "remove", id: selected.id });
        }}
        onDeselect={() => {
          const id = state.selectedId;
          dispatch({ kind: "select", id: null });
          if (id !== null) focusTile(id);
        }}
      />
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
            setJustSaved(false);
            dispatch({ kind: "placed", layout, id, rect, minimum: typeOf(widget.type)?.minSize ?? { w: 1, h: 1 } });
          }}
        />
      </div>
    </>
  );
}
