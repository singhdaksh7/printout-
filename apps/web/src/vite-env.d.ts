/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FIREBASE_API_KEY?: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FIREBASE_APP_ID?: string;
  /** Build-time e2e driver only; the production bundle check fails if it ships. */
  readonly VITE_PHONE_AUTH_MOCK?: string;
  /** '1' mounts the customer marketplace at /app (default off). */
  readonly VITE_MARKETPLACE?: string;
}
