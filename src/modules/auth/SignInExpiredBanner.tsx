import { useEffect, useState } from 'react';
import { LogIn } from 'lucide-react';

import { isSignInRequired, onSignInRequired } from '@/shared/signInRequired';

/**
 * Rendered once at the app root: a bar shown when the Authelia login behind the
 * site has expired. Reloading goes through the login page and lands back here.
 */
export default function SignInExpiredBanner() {
  const [visible, setVisible] = useState(isSignInRequired);

  useEffect(() => onSignInRequired(() => setVisible(true)), []);

  if (!visible) return null;
  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-0 z-[1000] flex items-center justify-center gap-3 border-b border-amber-500/30 bg-amber-500/15 px-4 py-2 text-sm text-amber-100 backdrop-blur"
      style={{ paddingTop: 'calc(0.5rem + env(safe-area-inset-top))' }}
    >
      <span>Your sign-in expired.</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="inline-flex items-center gap-1.5 rounded-md bg-amber-400 px-3 py-1 text-xs font-semibold text-black transition-colors hover:bg-amber-300"
      >
        <LogIn className="h-3.5 w-3.5" />
        Sign in again
      </button>
    </div>
  );
}
