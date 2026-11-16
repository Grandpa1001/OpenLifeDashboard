// Protocol constants of the check of the releases in the process (Architektura §11.1; D53.3). They pace the job: how
// often the clock is looked at, and the first look after the start. When a check is due is the policy of the core and
// the option `updates.checkEnabled`, not a constant here.

/** How often the job looks at the clock; a look costs a comparison, a request is made only when one is due. */
export const RELEASE_CHECK_TICK_MS = 10 * 60 * 1000;

/** The first look waits this long after the start, so the start itself is not slowed down by the network. */
export const RELEASE_CHECK_FIRST_DELAY_MS = 2 * 60 * 1000;
