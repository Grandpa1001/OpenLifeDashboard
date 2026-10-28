import type { RegistryDto } from "@openlife/contracts/http/registries";
import { LAYOUT_NAMES, type DesignSnapshotDto, type LayoutName, type ScreenDto, type WidgetTypesDto } from "@openlife/contracts/http/screens";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBlocker, useNavigate } from "@tanstack/react-router";
import { useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ApiFailure } from "../../../lib/api-client/request.js";
import { describeFailure } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { newUuid7 } from "../../../lib/ids/uuid7.js";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { useGuardRecheck } from "../../../lib/session/use-guard-recheck.js";
import { fetchRegistries } from "../api/registries.js";
import { fetchWidgetTypes, saveDesign } from "../api/screens.js";
import { designerReducer, isDirty, newWidget, startState } from "../lib/designer-state.js";
import { placeInEveryLayout } from "../lib/layout-edit.js";
import { typeLabelKey } from "../lib/type-label.js";
import { BindingsPanel } from "./bindings-panel.js";
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
  const [layout, setLayout] = useState<LayoutName>("desktop");
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

  function add(type: WidgetType): void {
    setJustSaved(false);
    dispatch({ kind: "add", widget: newWidget(newUuid7(), type.type, type.configVersion, placeInEveryLayout(state.design.widgets, type.defaultSize)) });
  }

  const status = save.isPending ? t("toolbar.saving") : dirty ? t("toolbar.dirty") : justSaved ? t("toolbar.saved") : t("toolbar.clean");
  return (
    <>
      <header className="designer-toolbar">
        <h1>{t("title")}</h1>
        <p className="screen-name">{state.design.name}</p>
        <div role="group" aria-label={t("toolbar.layouts")} className="designer-layouts">
          {LAYOUT_NAMES.map((name) => (
            <button key={name} type="button" className="link-button" aria-pressed={layout === name} onClick={() => setLayout(name)}>
              {t(`toolbar.${name}`)}
            </button>
          ))}
        </div>
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
        <button type="button" onClick={() => void navigate({ to: "/main" })}>
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
      <div className="designer-body">
        <section className="designer-palette" aria-label={t("palette.heading")}>
          <h2>{t("palette.heading")}</h2>
          {types.isPending ? <p role="status">{t("palette.loading")}</p> : null}
          {types.isError ? (
            <>
              <p role="alert">{t("palette.failed")}</p>
              <button type="button" onClick={() => void types.refetch()}>
                {t("retry")}
              </button>
            </>
          ) : null}
          {(types.data ?? []).map((type) => (
            <button key={type.type} type="button" onClick={() => add(type)}>
              {t("palette.add", { type: tw(typeLabelKey(type.type)) })}
            </button>
          ))}
        </section>
        <DesignCanvas
          layout={layout}
          widgets={state.design.widgets}
          registries={registries}
          selectedId={state.selectedId}
          minimumOf={(type) => typeOf(type)?.minSize ?? { w: 1, h: 1 }}
          onSelect={(id) => dispatch({ kind: "select", id })}
          onArranged={(items) => {
            setJustSaved(false);
            dispatch({ kind: "arranged", layout, items });
          }}
        />
        <BindingsPanel
          widget={selected}
          registries={registries}
          registriesFailed={registryList.isError}
          onChange={(change) => {
            if (selected === null) return;
            setJustSaved(false);
            dispatch({ kind: "configured", id: selected.id, ...change });
          }}
        />
      </div>
    </>
  );
}
