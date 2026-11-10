// The widgets of the preview (Scope §5.4; D39.3): the design being arranged, drawn as the dashboard draws
// the saved screen. A widget the server has worked out keeps its state; one it has not seen yet (added since
// the last save) has no binding and is a draft, which the preview shows with sample data.
import type { DesignSnapshotDto, ScreenDto, WidgetViewDto } from "@openlife/contracts/http/screens";

export function previewWidgets(design: DesignSnapshotDto, saved: ScreenDto): readonly WidgetViewDto[] {
  const states = new Map(saved.widgets.map((widget) => [widget.id, widget.state]));
  return design.widgets.map((widget) => ({ ...widget, state: states.get(widget.id) ?? "draft" }));
}
