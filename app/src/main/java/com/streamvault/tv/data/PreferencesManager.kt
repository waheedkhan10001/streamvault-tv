package com.streamvault.tv.data

import android.content.Context
import android.content.SharedPreferences
import android.os.SystemClock
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.security.KeyStore
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec

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
    @Volatile private var pinLockoutElapsedUntil: Long = 0L

    private object SecretCipher {
        private const val ALIAS = "streamvault_prefs_v1"
        private const val PREFIX = "enc_v1:"

        private fun getOrCreateKey(): SecretKey? = runCatching {
            val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            (ks.getKey(ALIAS, null) as? SecretKey) ?: run {
                val kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
                kg.init(
                    KeyGenParameterSpec.Builder(
                        ALIAS,
                        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
                    )
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.PADDING_NONE)
                        .setKeySize(256)
                        .build()
                )
                kg.generateKey()
            }
        }.getOrNull()

        fun encrypt(plain: String): String {
            if (plain.isEmpty()) return ""
            val key = getOrCreateKey() ?: return plain // JVM/Robolectric unit test env lacks AndroidKeyStore
            return runCatching {
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.ENCRYPT_MODE, key)
                val iv = Base64.encodeToString(cipher.iv, Base64.NO_WRAP)
                val ct = Base64.encodeToString(cipher.doFinal(plain.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
                "$PREFIX$iv:$ct"
            }.getOrDefault(plain)
        }

        fun decrypt(stored: String?): String {
            if (stored.isNullOrEmpty()) return ""
            if (!stored.startsWith(PREFIX)) return stored // Legacy plaintext value
            val parts = stored.removePrefix(PREFIX).split(":", limit = 2)
            if (parts.size != 2) return ""
            val key = getOrCreateKey() ?: return ""
            return runCatching {
                val iv = Base64.decode(parts[0], Base64.NO_WRAP)
                val ct = Base64.decode(parts[1], Base64.NO_WRAP)
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv))
                String(cipher.doFinal(ct), Charsets.UTF_8)
            }.getOrDefault("")
        }
    }

    private fun getSecretString(key: String, default: String = ""): String {
        val raw = prefs.getString(key, null) ?: return default
        return SecretCipher.decrypt(raw).ifEmpty { default }
    }

    private fun putSecretString(editor: SharedPreferences.Editor, key: String, value: String) {
        if (value.isBlank()) editor.remove(key) else editor.putString(key, SecretCipher.encrypt(value))
    }

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

        val decodedPassword = getSecretString("password", "")
        val decodedTmdb = getSecretString("tmdb_api_key", XtreamCredentials.DEFAULT_TMDB_KEY)
            .takeIf { it.isNotBlank() } ?: XtreamCredentials.DEFAULT_TMDB_KEY

        return XtreamCredentials(
            playlistName = prefs.getString("playlist_name", "My IPTV") ?: "My IPTV",
            serverUrl = prefs.getString("server_url", "") ?: "",
            username = prefs.getString("username", "") ?: "",
            password = decodedPassword,
            tmdbApiKey = decodedTmdb,
            preferredLanguages = prefLangs,
            hiddenLanguages = hiddenLangs,
            preferredSubtitleLanguages = subLangsStr.split(",").map { it.trim() }.filter { it.isNotBlank() }
        )
    }

    fun saveCredentials(creds: XtreamCredentials) {
        val editor = prefs.edit()
            .putString("playlist_name", creds.playlistName.trim())
            .putString("server_url", creds.serverUrl.trim())
            .putString("username", creds.username.trim())
            .putStringSet("preferred_langs", creds.preferredLanguages)
            .putStringSet("hidden_langs", creds.hiddenLanguages)
            .putString("sub_langs", creds.preferredSubtitleLanguages.joinToString(","))
        putSecretString(editor, "password", creds.password.trim())
        putSecretString(editor, "tmdb_api_key", creds.tmdbApiKey.trim().ifBlank { XtreamCredentials.DEFAULT_TMDB_KEY })
        editor.commit()
        _credentialsFlow.value = creds
    }

    // --- Cloud Session & Authentication ---
    fun getCloudSyncBaseUrl(): String {
        val stored = prefs.getString("cloud_sync_base_url", "https://streamvault-sync.streamvault-app.workers.dev")
            ?: "https://streamvault-sync.streamvault-app.workers.dev"
        return if (stored.startsWith("https://", ignoreCase = true)) stored else "https://streamvault-sync.streamvault-app.workers.dev"
    }

    fun setCloudSyncBaseUrl(url: String) {
        val clean = url.trim().trimEnd('/')
        if (!clean.startsWith("https://", ignoreCase = true)) return
        prefs.edit().putString("cloud_sync_base_url", clean).apply()
    }

    fun getAuthToken(): String? {
        return getSecretString("auth_token", "").takeIf { it.isNotBlank() }
    }

    fun setAuthToken(token: String?) {
        val editor = prefs.edit()
        if (token.isNullOrBlank()) {
            editor.remove("auth_token")
        } else {
            putSecretString(editor, "auth_token", token.trim())
        }
        editor.apply()
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
            .remove("server_url")
            .remove("username")
            .remove("password")
            .remove("playlist_name")
            .remove("tmdb_api_key")
            .commit()
        pinLockoutElapsedUntil = 0L
        adultVaultUnlockedSession.set(false)
        extrasUnlockedSession.set(false)
        _credentialsFlow.value = XtreamCredentials()
    }

    var lastFullSyncTimestamp: Long
        get() = prefs.getLong("last_full_sync_ts", 0L)
        set(value) = prefs.edit().putLong("last_full_sync_ts", value).apply()

    /** Short description of the last time the app closed by itself (set by the crash recorder, shown in Settings). */
    var lastCrash: String?
        get() = prefs.getString("last_crash", null)
        set(value) { if (value == null) prefs.edit().remove("last_crash").apply() else prefs.edit().putString("last_crash", value).apply() }

    /** When the last provider refresh STARTED (finished or not): an interrupted refresh must not restart on every launch. */
    fun getString(key: String): String = prefs.getString(key, "") ?: ""
    fun putString(key: String, value: String) { prefs.edit().putString(key, value).apply() }

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

    companion object {
        private val PIN_REGEX = Regex("^\\d{4}$")
        private val PIN_HASH_REGEX = Regex("^(?:[0-9a-f]{64}|pbkdf2_sha256\\x24(?:10000|[1-9]\\d{4,5})\\x24[0-9a-f]{64})$")
        private val PIN_SALT_REGEX = Regex("^[A-Za-z0-9-]{8,64}$")
        private const val PIN_PBKDF2_ITERATIONS = 100_000
    }

    private fun hashPinPbkdf2(pin: String, salt: String, iterations: Int = PIN_PBKDF2_ITERATIONS): String {
        val factory = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
        val spec = PBEKeySpec(pin.toCharArray(), salt.toByteArray(Charsets.UTF_8), iterations, 256)
        val bytes = factory.generateSecret(spec).encoded
        spec.clearPassword()
        val hex = bytes.joinToString("") { "%02x".format(it) }
        return "pbkdf2_sha256" + '$' + iterations + '$' + hex
    }

    private fun hashPinLegacySha256(pin: String, salt: String): String {
        val md = MessageDigest.getInstance("SHA-256")
        val bytes = md.digest("$pin:$salt".toByteArray(Charsets.UTF_8))
        return bytes.joinToString("") { "%02x".format(it) }
    }

    private fun hashPin(pin: String): String = hashPinPbkdf2(pin, getPinSalt())

    fun hasCustomParentalPin(): Boolean {
        val hash = prefs.getString("parental_pin_hash", null)
        return !hash.isNullOrBlank()
    }

    fun isPinConfigured(): Boolean = hasCustomParentalPin()

    fun getPinHash(): String? = prefs.getString("parental_pin_hash", null)

    fun getPinLockoutUntil(): Long = prefs.getLong("pin_lockout_until", 0L)

    fun isPinLockedOut(): Boolean {
        val elapsedNow = SystemClock.elapsedRealtime()
        if (pinLockoutElapsedUntil > 0L && elapsedNow < pinLockoutElapsedUntil) return true
        return System.currentTimeMillis() < getPinLockoutUntil()
    }

    @Synchronized
    fun verifyParentalPin(inputPin: String): Boolean {
        val cleanPin = inputPin.trim()
        if (isPinLockedOut()) return false

        val storedHash = prefs.getString("parental_pin_hash", null)
        if (storedHash.isNullOrBlank()) return false

        val now = System.currentTimeMillis()
        val failedAttempts = prefs.getInt("pin_failed_attempts", 0)
        val matched = if (PIN_REGEX.matches(cleanPin)) {
            val salt = getPinSalt()
            if (storedHash.startsWith("pbkdf2_sha256\$")) {
                val parts = storedHash.split("\$")
                val iters = parts.getOrNull(1)?.toIntOrNull() ?: 0
                if (parts.size == 3 && iters in 10_000..500_000) {
                    val computed = hashPinPbkdf2(cleanPin, salt, iters)
                    MessageDigest.isEqual(computed.toByteArray(Charsets.UTF_8), storedHash.toByteArray(Charsets.UTF_8))
                } else false
            } else {
                val legacy = hashPinLegacySha256(cleanPin, salt)
                MessageDigest.isEqual(legacy.toByteArray(Charsets.UTF_8), storedHash.toByteArray(Charsets.UTF_8))
            }
        } else {
            false
        }

        if (matched) {
            pinLockoutElapsedUntil = 0L
            val editor = prefs.edit().putInt("pin_failed_attempts", 0).putLong("pin_lockout_until", 0L)
            if (!storedHash.startsWith("pbkdf2_sha256\$")) {
                editor.putString("parental_pin_hash", hashPin(cleanPin))
            }
            editor.commit()
            return true
        } else {
            val newAttempts = failedAttempts + 1
            val editor = prefs.edit().putInt("pin_failed_attempts", newAttempts)
            if (newAttempts >= 5) {
                pinLockoutElapsedUntil = SystemClock.elapsedRealtime() + 60_000L
                editor.putLong("pin_lockout_until", now + 60_000L)
            }
            editor.commit()
            return false
        }
    }

    @Synchronized
    fun setParentalPin(currentPin: String?, newPin: String): Boolean {
        val cleanNew = newPin.trim()
        if (!PIN_REGEX.matches(cleanNew)) return false
        if (hasCustomParentalPin()) {
            if (currentPin == null || !verifyParentalPin(currentPin)) return false
        }
        pinLockoutElapsedUntil = 0L
        val newHash = hashPin(cleanNew)
        return prefs.edit()
            .putString("parental_pin_hash", newHash)
            .putInt("pin_failed_attempts", 0)
            .putLong("pin_lockout_until", 0L)
            .commit()
    }

    @Synchronized
    fun restorePinHash(hash: String?, salt: String? = null) {
        val cleanHash = hash?.trim()?.lowercase(java.util.Locale.ROOT) ?: ""
        val cleanSalt = salt?.trim() ?: ""
        if (!PIN_HASH_REGEX.matches(cleanHash)) return
        val editor = prefs.edit().putString("parental_pin_hash", cleanHash)
        if (PIN_SALT_REGEX.matches(cleanSalt)) {
            editor.putString("parental_pin_salt", cleanSalt)
        }
        pinLockoutElapsedUntil = 0L
        editor.putInt("pin_failed_attempts", 0)
            .putLong("pin_lockout_until", 0L)
            .commit()
    }

    @Synchronized
    fun resetParentalPinWithAuth(newPin: String): Boolean {
        val cleanNew = newPin.trim()
        if (!PIN_REGEX.matches(cleanNew)) return false
        pinLockoutElapsedUntil = 0L
        val newHash = hashPin(cleanNew)
        prefs.edit()
            .putString("parental_pin_hash", newHash)
            .putInt("pin_failed_attempts", 0)
            .putLong("pin_lockout_until", 0L)
            .commit()
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
