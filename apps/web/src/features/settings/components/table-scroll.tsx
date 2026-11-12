import type { ReactNode } from "react";

/**
 * A table that may be wider than the screen scrolls on its own. A region that scrolls must be reachable by the
 * keyboard, so it is focusable and named, as a group, by the heading of its section.
 */
export function TableScroll({ labelledBy, children }: Readonly<{ labelledBy: string; children: ReactNode }>) {
  return (
    <div className="table-scroll" role="group" aria-labelledby={labelledBy} tabIndex={0}>
      {children}
    </div>
  );
}
