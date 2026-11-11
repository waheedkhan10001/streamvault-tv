package com.streamvault.tv

/**
 * Decides whether a request made by the TV page is answered by the on-TV router.
 *
 * Only the app's own local page (file:// scheme) is answered locally. Anything on the internet,
 * including the cloud Worker's https://...workers.dev/api/... calls (sign-up, login, pairing code,
 * sync), must go out to the network untouched. Intercepting those made the welcome screen stuck on
 * "SV-...." with no QR code, and would have broken every cloud call.
 */
internal fun isLocalApiRequest(scheme: String?, url: String): Boolean =
    scheme.equals("file", ignoreCase = true) && url.contains("/api/")
