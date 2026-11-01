export { AuthProvider, useAuth } from '@/modules/auth/context/AuthContext';
export { default as ProtectedRoute } from '@/modules/auth/ProtectedRoute';
// Used by App: the "sign in again" bar shown when the Authelia login behind the site expires.
export { default as SignInExpiredBanner } from '@/modules/auth/SignInExpiredBanner';
