/**
 * One-shot hint for where the next opened session should go in the workspace
 * split view. The sidebar sets it just before selecting a session or starting
 * a new one ("Open beside", Alt+click); the project-workspace split layout
 * reads it when the router's session changes. Unclaimed hints expire so a
 * stale one never affects a later, unrelated navigation.
 */

/** `beside` opens the session next to the focused pane instead of replacing it. */
export type SessionPlacement = 'beside';

const PLACEMENT_TTL_MS = 3_000;

let pendingPlacement: { placement: SessionPlacement; expiresAt: number } | null = null;

/** Used by the sidebar to ask that the session it is about to open goes beside the current one. */
export function requestSessionPlacement(placement: SessionPlacement): void {
  pendingPlacement = { placement, expiresAt: Date.now() + PLACEMENT_TTL_MS };
}

/** Used by the split layout: returns the pending placement (if still fresh) and clears it. */
export function consumeSessionPlacement(): SessionPlacement | null {
  const current = pendingPlacement;
  pendingPlacement = null;
  return current && current.expiresAt > Date.now() ? current.placement : null;
}
