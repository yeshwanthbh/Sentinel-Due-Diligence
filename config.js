/* Sentinel DD — deployment configuration.
 * These values are meant to live in client code (they are not secrets).
 *
 * To enable "Sign in with Google", paste your Google OAuth Client ID below, once.
 *   1. Google Cloud Console → APIs & Services → Credentials
 *   2. Create credentials → OAuth client ID → Application type: "Web application"
 *   3. Under "Authorized JavaScript origins" add the URL you serve this app from,
 *      e.g. http://localhost:4599  (Google sign-in will NOT work from a file:// page)
 *   4. Copy the Client ID (looks like 1234567890-abc123.apps.googleusercontent.com)
 *      and paste it between the quotes below.
 *
 * Once set, the official Google button renders automatically for every visitor —
 * no per-user setup, exactly like other sites.
 */
window.SENTINEL_CONFIG = {
  googleClientId: ""
};
