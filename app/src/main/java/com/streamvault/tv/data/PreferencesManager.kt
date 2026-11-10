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

    var lastFullSyncTimestamp: Long
        get() = prefs.getLong("last_full_sync_ts", 0L)
        set(value) = prefs.edit().putLong("last_full_sync_ts", value).apply()

    fun shouldRunAutoDeltaSync(): Boolean {
        val last = lastFullSyncTimestamp
        if (last == 0L) return true
        val elapsedHours = (System.currentTimeMillis() - last) / (1000L * 60 * 60)
        // Enforce 24-hour interval so we never bother the IPTV server unnecessarily
        return elapsedHours >= 24
    }

    fun getRecentSearches(): List<String> {
        val raw = prefs.getString("recent_searches", "") ?: ""
        return raw.split("||").filter { it.isNotBlank() }.take(8)
    }

    fun addRecentSearch(query: String) {
        val clean = query.trim()
        if (clean.length < 2) return
        val updated = (listOf(clean) + getRecentSearches().filterNot { it.equals(clean, ignoreCase = true) }).take(8)
        prefs.edit().putString("recent_searches", updated.joinToString("||")).commit()
    }

    fun clearRecentSearches() {
        prefs.edit().remove("recent_searches").commit()
    }

    fun removeRecentSearch(query: String) {
        val clean = query.trim()
        val updated = getRecentSearches().filterNot { it.equals(clean, ignoreCase = true) }
        prefs.edit().putString("recent_searches", updated.joinToString("||")).commit()
    }

    // --- Parental Controls (Hashed PIN, attempt-limited, per-device) ---
    private fun getPinSalt(): String {
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
        val defaultHash = hashPin("0000")
        val currentHash = prefs.getString("parental_pin_hash", defaultHash) ?: defaultHash
        return currentHash != defaultHash
    }

    fun verifyParentalPin(inputPin: String): Boolean {
        val failedAttempts = prefs.getInt("pin_failed_attempts", 0)
        val lockoutUntil = prefs.getLong("pin_lockout_until", 0L)
        val now = System.currentTimeMillis()
        if (now < lockoutUntil) return false

        val defaultHash = hashPin("0000")
        val storedHash = prefs.getString("parental_pin_hash", defaultHash) ?: defaultHash
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

    fun setParentalPin(currentPin: String, newPin: String): Boolean {
        if (!verifyParentalPin(currentPin)) return false
        if (newPin.trim().length != 4) return false
        val newHash = hashPin(newPin.trim())
        return prefs.edit().putString("parental_pin_hash", newHash).commit()
    }

    fun isParentalLocked(): Boolean {
        return prefs.getBoolean("parental_is_locked", true)
    }

    fun setParentalLocked(locked: Boolean) {
        prefs.edit().putBoolean("parental_is_locked", locked).apply()
    }

    fun isAdultVaultUnlocked(): Boolean {
        return !isParentalLocked() && prefs.getBoolean("parental_show_adult", false)
    }

    fun setAdultVaultUnlocked(unlocked: Boolean) {
        prefs.edit()
            .putBoolean("parental_is_locked", !unlocked)
            .putBoolean("parental_show_adult", unlocked)
            .apply()
    }
}
