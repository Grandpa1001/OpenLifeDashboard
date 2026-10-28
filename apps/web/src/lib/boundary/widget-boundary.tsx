import { Component, type ReactNode } from "react";

type Props = Readonly<{ children: ReactNode; fallback: (reset: () => void) => ReactNode }>;
type State = Readonly<{ failed: boolean }>;

/**
 * The boundary of one widget (Architektura §7.3): an error while a widget is drawn is its own, and
 * the screen and the other widgets stay. The fallback may offer to try again, which draws the widget anew.
 */
export class WidgetBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  reset = (): void => this.setState({ failed: false });

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback(this.reset) : this.props.children;
  }
}
