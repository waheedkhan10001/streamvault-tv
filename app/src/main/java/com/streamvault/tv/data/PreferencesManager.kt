package com.streamvault.tv.data

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Manages IPTV credentials, preferred/hidden languages, recent searches,
 * and the strict "1-Connection Playback Lock" that prevents background IPTV
 * requests while a movie, episode, or live stream is actively playing.
 */
class PreferencesManager(context: Context) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences("streamvault_prefs", Context.MODE_PRIVATE)

    // Strict 1-Connection Lock: true whenever ExoPlayer is actively streaming
    val isPlaybackActive = AtomicBoolean(false)

    // Last time the person did something on screen (opened a tab, a title, a filter...). Background work such as the
    // details lookup waits while this is recent, so the app stays quick under the remote. Status polling does not count.
    @Volatile var lastUiActivityAt: Long = 0L
    fun getFlag(name: String): Boolean = prefs.getBoolean("flag_$name", false)
    fun setFlag(name: String) { prefs.edit().putBoolean("flag_$name", true).apply() }
    fun noteUiActivity() { lastUiActivityAt = System.currentTimeMillis() }
    fun msSinceUiActivity(): Long = System.currentTimeMillis() - lastUiActivityAt

    // Session-only 18+ Vault Unlock (Never persisted to disk, localStorage or cloud!)
    private val adultVaultUnlockedSession = AtomicBoolean(false)
    private val extrasUnlockedSession = AtomicBoolean(false)

    private val _credentialsFlow = MutableStateFlow(loadCredentials())
    val credentialsFlow: StateFlow<XtreamCredentials> = _credentialsFlow

    // Live remote search pushed from the Phone/PC Wi-Fi QR Companion Web Page
    private val _remoteSearchCommand = MutableStateFlow<String?>(null)
    val remoteSearchCommand: StateFlow<String?> = _remoteSearchCommand

    fun pushRemoteSearchFromPhone(query: String) {
        _remoteSearchCommand.value = query
    }

    fun consumeRemoteSearchCommand() {
        _remoteSearchCommand.value = null
    }

    fun loadCredentials(): XtreamCredentials {
        val prefLangs = prefs.getStringSet(
            "preferred_langs",
            setOf("English", "Hindi", "Urdu", "Multi-Audio")
        ) ?: setOf("English", "Hindi", "Urdu", "Multi-Audio")
        val hiddenLangs = prefs.getStringSet("hidden_langs", emptySet()) ?: emptySet()
        val subLangsStr = prefs.getString("sub_langs", "en,ur,hi,ar") ?: "en,ur,hi,ar"

        return XtreamCredentials(
            playlistName = prefs.getString("playlist_name", "My IPTV") ?: "My IPTV",
            serverUrl = prefs.getString("server_url", "") ?: "",
            username = prefs.getString("username", "") ?: "",
            password = prefs.getString("password", "") ?: "",
            tmdbApiKey = prefs.getString("tmdb_api_key", XtreamCredentials.DEFAULT_TMDB_KEY)
                ?.takeIf { it.isNotBlank() } ?: XtreamCredentials.DEFAULT_TMDB_KEY,
            preferredLanguages = prefLangs,
            hiddenLanguages = hiddenLangs,
            preferredSubtitleLanguages = subLangsStr.split(",").map { it.trim() }.filter { it.isNotBlank() }
        )
    }

    fun saveCredentials(creds: XtreamCredentials) {
        prefs.edit()
            .putString("playlist_name", creds.playlistName.trim())
            .putString("server_url", creds.serverUrl.trim())
            .putString("username", creds.username.trim())
            .putString("password", creds.password.trim())
            .putString("tmdb_api_key", creds.tmdbApiKey.trim().ifBlank { XtreamCredentials.DEFAULT_TMDB_KEY })
            .putStringSet("preferred_langs", creds.preferredLanguages)
            .putStringSet("hidden_langs", creds.hiddenLanguages)
            .putString("sub_langs", creds.preferredSubtitleLanguages.joinToString(","))
            .commit()
        _credentialsFlow.value = creds
    }

    // --- Cloud Session & Authentication ---
    fun getCloudSyncBaseUrl(): String {
        return prefs.getString("cloud_sync_base_url", "https://streamvault-sync.streamvault-app.workers.dev")
            ?: "https://streamvault-sync.streamvault-app.workers.dev"
    }

    fun setCloudSyncBaseUrl(url: String) {
        prefs.edit().putString("cloud_sync_base_url", url.trim().trimEnd('/')).apply()
    }

    fun getAuthToken(): String? {
        return prefs.getString("auth_token", null)?.takeIf { it.isNotBlank() }
    }

    fun setAuthToken(token: String?) {
        if (token.isNullOrBlank()) {
            prefs.edit().remove("auth_token").apply()
        } else {
            prefs.edit().putString("auth_token", token.trim()).apply()
        }
    }

    fun getAccountEmail(): String? {
        return prefs.getString("account_email", null)
    }

    fun setAccountEmail(email: String?) {
        if (email.isNullOrBlank()) {
            prefs.edit().remove("account_email").apply()
        } else {
            prefs.edit().putString("account_email", email.trim()).apply()
        }
    }

    fun getAccountDisplayName(): String {
        val email = getAccountEmail() ?: ""
        return prefs.getString("display_name", null)?.takeIf { it.isNotBlank() }
            ?: if (email.contains("@")) email.substringBefore("@") else "User"
    }

    fun setAccountDisplayName(name: String?) {
        if (name.isNullOrBlank()) {
            prefs.edit().remove("display_name").apply()
        } else {
            prefs.edit().putString("display_name", name.trim()).apply()
        }
    }

    fun hasActiveSession(): Boolean {
        return !getAuthToken().isNullOrBlank()
    }

    fun clearAuthSession() {
        prefs.edit()
            .remove("auth_token")
            .remove("account_email")
            .remove("display_name")
            .remove("account_id")
            .remove("active_profile_id")
            .remove("parental_pin_hash")
            .remove("parental_pin_salt")
            .remove("pin_failed_attempts")
            .remove("pin_lockout_until")
            .apply()
        adultVaultUnlockedSession.set(false)
        extrasUnlockedSession.set(false)
    }

    var lastFullSyncTimestamp: Long
        get() = prefs.getLong("last_full_sync_ts", 0L)
        set(value) = prefs.edit().putLong("last_full_sync_ts", value).apply()

    /** Short description of the last time the app closed by itself (set by the crash recorder, shown in Settings). */
    var lastCrash: String?
        get() = prefs.getString("last_crash", null)
        set(value) { if (value == null) prefs.edit().remove("last_crash").apply() else prefs.edit().putString("last_crash", value).apply() }

    /** When the last provider refresh STARTED (finished or not): an interrupted refresh must not restart on every launch. */
    var lastSyncAttemptTimestamp: Long
        get() = prefs.getLong("last_sync_attempt_ts", 0L)
        set(value) = prefs.edit().putLong("last_sync_attempt_ts", value).apply()

    fun shouldRunAutoDeltaSync(): Boolean {
        val now = System.currentTimeMillis()
        val last = lastFullSyncTimestamp
        val attemptHours = (now - lastSyncAttemptTimestamp) / (1000L * 60 * 60)
        // A refresh that was started recently is not started again (it was probably cut short; saved titles are kept)
        if (lastSyncAttemptTimestamp != 0L && attemptHours < 3) return false
        if (last == 0L) return true
        val elapsedHours = (now - last) / (1000L * 60 * 60)
        // Enforce 24-hour interval so we never bother the IPTV server unnecessarily
        return elapsedHours >= 24
    }

    fun getActiveProfileId(): String {
        return prefs.getString("active_profile_id", "") ?: ""
    }

    fun setActiveProfileId(profileId: String) {
        prefs.edit().putString("active_profile_id", profileId.trim()).apply()
    }

    fun getRecentSearches(profileId: String = ""): List<String> {
        val key = if (profileId.isNotBlank()) "recent_searches_$profileId" else "recent_searches"
        val raw = prefs.getString(key, "") ?: ""
        return raw.split("||").filter { it.isNotBlank() }.take(8)
    }

    fun addRecentSearch(query: String, profileId: String = "") {
        val pid = profileId.ifBlank { getActiveProfileId() }
        val clean = query.trim()
        if (clean.length < 2) return
        val key = if (pid.isNotBlank()) "recent_searches_$pid" else "recent_searches"
        val current = getRecentSearches(pid)
        val updated = (listOf(clean) + current.filterNot { it.equals(clean, ignoreCase = true) }).take(8)
        prefs.edit().putString(key, updated.joinToString("||")).commit()
    }

    fun clearRecentSearches(profileId: String = "") {
        val pid = profileId.ifBlank { getActiveProfileId() }
        val key = if (pid.isNotBlank()) "recent_searches_$pid" else "recent_searches"
        prefs.edit().remove(key).commit()
    }

    fun removeRecentSearch(query: String, profileId: String = "") {
        val pid = profileId.ifBlank { getActiveProfileId() }
        val clean = query.trim()
        val key = if (pid.isNotBlank()) "recent_searches_$pid" else "recent_searches"
        val updated = getRecentSearches(pid).filterNot { it.equals(clean, ignoreCase = true) }
        prefs.edit().putString(key, updated.joinToString("||")).commit()
    }

    // --- Parental Controls (Hashed PIN, attempt-limited, per-device) ---
    fun getPinSalt(): String {
        var salt = prefs.getString("parental_pin_salt", null)
        if (salt == null) {
            salt = java.util.UUID.randomUUID().toString()
            prefs.edit().putString("parental_pin_salt", salt).commit()
        }
        return salt
    }

    private fun hashPin(pin: String): String {
        val salt = getPinSalt()
        val md = java.security.MessageDigest.getInstance("SHA-256")
        val bytes = md.digest("$pin:$salt".toByteArray(Charsets.UTF_8))
        return bytes.joinToString("") { "%02x".format(it) }
    }

    fun hasCustomParentalPin(): Boolean {
        val hash = prefs.getString("parental_pin_hash", null)
        return !hash.isNullOrBlank()
    }

    fun isPinConfigured(): Boolean = hasCustomParentalPin()

    fun getPinHash(): String? = prefs.getString("parental_pin_hash", null)

    fun getPinLockoutUntil(): Long = prefs.getLong("pin_lockout_until", 0L)

    fun verifyParentalPin(inputPin: String): Boolean {
        val failedAttempts = prefs.getInt("pin_failed_attempts", 0)
        val lockoutUntil = prefs.getLong("pin_lockout_until", 0L)
        val now = System.currentTimeMillis()
        if (now < lockoutUntil) return false

        val storedHash = prefs.getString("parental_pin_hash", null)
        if (storedHash.isNullOrBlank()) {
            return false
        }
        val inputHash = hashPin(inputPin.trim())

        if (inputHash == storedHash) {
            prefs.edit().putInt("pin_failed_attempts", 0).putLong("pin_lockout_until", 0L).apply()
            return true
        } else {
            val newAttempts = failedAttempts + 1
            val editor = prefs.edit().putInt("pin_failed_attempts", newAttempts)
            if (newAttempts >= 5) {
                editor.putLong("pin_lockout_until", now + 60_000L) // 60s cooldown
            }
            editor.apply()
            return false
        }
    }

    fun setParentalPin(currentPin: String?, newPin: String): Boolean {
        if (newPin.trim().length != 4) return false
        if (hasCustomParentalPin()) {
            if (currentPin == null || !verifyParentalPin(currentPin)) return false
        }
        val newHash = hashPin(newPin.trim())
        return prefs.edit()
            .putString("parental_pin_hash", newHash)
            .putInt("pin_failed_attempts", 0)
            .putLong("pin_lockout_until", 0L)
            .commit()
    }

    fun restorePinHash(hash: String?, salt: String? = null) {
        if (hash.isNullOrBlank()) return
        val editor = prefs.edit().putString("parental_pin_hash", hash)
        if (!salt.isNullOrBlank()) {
            editor.putString("parental_pin_salt", salt)
        }
        editor.putInt("pin_failed_attempts", 0)
            .putLong("pin_lockout_until", 0L)
            .apply()
    }

    fun resetParentalPinWithAuth(newPin: String): Boolean {
        if (newPin.trim().length != 4) return false
        val newHash = hashPin(newPin.trim())
        prefs.edit()
            .putString("parental_pin_hash", newHash)
            .putInt("pin_failed_attempts", 0)
            .putLong("pin_lockout_until", 0L)
            .apply()
        return true
    }

    fun isParentalLocked(): Boolean {
        return !adultVaultUnlockedSession.get()
    }

    fun isAdultVaultUnlocked(): Boolean {
        return adultVaultUnlockedSession.get()
    }

    fun setAdultVaultUnlocked(unlocked: Boolean) {
        adultVaultUnlockedSession.set(unlocked)
        // Session-only! Never persisted to disk.
    }

    fun isExtrasUnlocked(): Boolean = extrasUnlockedSession.get()

    fun setExtrasUnlocked(unlocked: Boolean) {
        extrasUnlockedSession.set(unlocked)
        // Session-only! Never persisted to disk.
    }

    /** Locks both the 18+ Vault and Extras (profile switch, app background, TV standby, sign-out). */
    fun lockAllVaults() {
        adultVaultUnlockedSession.set(false)
        extrasUnlockedSession.set(false)
    }
}
