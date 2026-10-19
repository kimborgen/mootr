// The credit poll hook that budgets.ts calls when a reserve needs a fresh balance (S-1183). credits.ts
// registers its poll here at module load. This module imports nothing, so budgets.ts and credits.ts can
// both import it without an import cycle: a registration can't run before the holder has initialized.
let poll: (() => void) | null = null;

export function setCreditPoller(fn: () => void): void {
  poll = fn;
}

// Asks for a fresh credit balance if a poller is registered; a no-op before credits.ts loads.
export function pollCreditsIfAny(): void {
  poll?.();
}
