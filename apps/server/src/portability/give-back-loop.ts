// A pause that gives the event loop back (D46.3): the requests that are waiting run before the work goes on.
export const giveBackLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
