/**
 * The site sits behind Authelia (auth.kvnfritsch.com). When that login expires,
 * nginx answers API calls with 401 + "X-Kvn-Sign-In: required" instead of a
 * redirect a background fetch cannot follow. The fetch wrapper in api.ts reports
 * it here, and the auth module shows a "sign in again" banner.
 */

export const SIGN_IN_REQUIRED_HEADER = 'X-Kvn-Sign-In';

const listeners = new Set<() => void>();
let required = false;

/** Used by api.ts when a response says the proxy login has expired. */
export function reportSignInRequired(): void {
  if (required) return;
  required = true;
  listeners.forEach((listener) => listener());
}

/** Whether a sign-in has been reported as required since the page loaded. */
export function isSignInRequired(): boolean {
  return required;
}

/** Used by the auth module's banner; returns an unsubscribe function. */
export function onSignInRequired(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
