package com.streamvault.tv

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.streamvault.tv.data.ContentCertifications
import com.streamvault.tv.data.MediaItem
import com.streamvault.tv.data.MediaType
import com.streamvault.tv.data.AppApiRouter
import com.streamvault.tv.data.CatalogSyncEngine
import com.streamvault.tv.data.PackManager
import com.streamvault.tv.data.PreferencesManager
import com.streamvault.tv.data.XtreamCredentials
import java.io.File
import java.io.RandomAccessFile
import com.streamvault.tv.data.StreamVaultDatabase
import com.streamvault.tv.data.SuperFilterState
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Robolectric unit test suite covering:
 * 1. Kids mode certification filtering & strict isolation (young-child certification only, uncertified hidden).
 * 2. Adult progress rejection & absolute privacy (zero database tracking for 18+ content).
 * 3. Parental PIN lifecycle: no 0000 default, required initial setup, 5-attempt lockout, and sign-out purging.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class RobolectricSecurityAndContentTest {

    private lateinit var context: Context
    private lateinit var db: StreamVaultDatabase
    private lateinit var prefs: PreferencesManager

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        context.deleteDatabase("streamvault_tv.db")
        context.getSharedPreferences("streamvault_prefs", Context.MODE_PRIVATE).edit().clear().commit()

        db = StreamVaultDatabase(context)
        prefs = PreferencesManager(context)
    }

    @After
    fun tearDown() {
        db.close()
        context.deleteDatabase("streamvault_tv.db")
        context.getSharedPreferences("streamvault_prefs", Context.MODE_PRIVATE).edit().clear().commit()
    }

    // =========================================================================
    // 1. KIDS FILTERING TESTS
    // =========================================================================

    @Test
    fun testKidsCertificationConstant_ContainsExactYoungChildCertifications() {
        val expected = setOf("G", "TV-Y", "TV-G", "U", "UK U", "FSK 0", "AU G", "CA G", "IN U", "NL AL")
        assertEquals(expected, ContentCertifications.KIDS_CERTIFICATIONS)

        // Kids decisions now come from the content pack (kids_ok); titles the pack has not seen use their own US rating
        // Kids shows all-ages ratings only (not PG, not TV-Y7)
        val inList = ContentCertifications.KIDS_CERTIFICATIONS_SQL_IN
        assertEquals("(kids_ok = 1 AND certification IN ($inList))", ContentCertifications.kidsClause("certification"))
        assertEquals("(m.kids_ok = 1 AND m.certification IN ($inList))", ContentCertifications.kidsClause("m.certification"))
        for (cert in expected) assertEquals(1, ContentCertifications.kidsOkFromCertification(cert))
        for (cert in listOf("PG", "TV-PG", "TV-Y7", "R", "TV-MA", "NC-17", "")) assertEquals(0, ContentCertifications.kidsOkFromCertification(cert))
    }

    @Test
    fun testKidsCatalogFiltering_StrictlyAllowsYoungChildCertsAndExcludesAdultOrUncertified() {
        val testItems = listOf(
            createTestMediaItem("nemo", "Finding Nemo", certification = "G", isAdult = false),
            createTestMediaItem("shrek", "Shrek", certification = "PG", isAdult = false),
            createTestMediaItem("bluey", "Bluey", certification = "TV-Y", isAdult = false),
            createTestMediaItem("peppa", "Peppa Pig", certification = "TV-G", isAdult = false),
            createTestMediaItem("sponge", "SpongeBob", certification = "TV-Y7", isAdult = false),
            createTestMediaItem("incredibles", "The Incredibles", certification = "TV-PG", isAdult = false),
            createTestMediaItem("paddington", "Paddington", certification = "U", isAdult = false),
            // Non-kids / restricted
            createTestMediaItem("deadpool", "Deadpool", certification = "R", isAdult = false),
            createTestMediaItem("got", "Game of Thrones", certification = "TV-MA", isAdult = false),
            createTestMediaItem("nc17_flick", "NC17 Art Film", certification = "NC-17", isAdult = false),
            // Uncertified title
            createTestMediaItem("uncertified", "Mystery Indie Movie", certification = "", isAdult = false),
            // Adult title
            createTestMediaItem("adult_xxx", "Adult Feature 18+", certification = "R", isAdult = true)
        )

        db.upsertMediaBatch(testItems, markNewIfInserted = false)

        // Query catalog as regular adult user (kids = false)
        val regularResults = db.queryMedia(
            filter = SuperFilterState(),
            isKids = false,
            isAdultVaultUnlocked = false,
            isVaultTab = false
        )
        val regularKeys = regularResults.map { it.dedupKey }.toSet()
        assertEquals("Regular catalog must contain all 11 non-adult titles", 11, regularResults.size)
        assertTrue(regularKeys.contains("nemo"))
        assertTrue(regularKeys.contains("deadpool"))
        assertTrue(regularKeys.contains("uncertified"))
        assertFalse("Regular catalog must exclude adult title", regularKeys.contains("adult_xxx"))

        // Query catalog as Kids profile (kids = true)
        val kidsResults = db.queryMedia(
            filter = SuperFilterState(),
            isKids = true,
            isAdultVaultUnlocked = false,
            isVaultTab = false
        )
        val kidsKeys = kidsResults.map { it.dedupKey }.toSet()

        // Must ONLY contain all-ages ratings (G, TV-Y, TV-G, U): not PG, TV-PG or TV-Y7
        assertEquals("Kids catalog must contain only the 4 all-ages titles", 4, kidsResults.size)
        assertTrue(kidsKeys.contains("nemo"))
        assertFalse("Kids mode must reject shrek (not all-ages)", kidsKeys.contains("shrek"))
        assertTrue(kidsKeys.contains("bluey"))
        assertTrue(kidsKeys.contains("peppa"))
        assertFalse("Kids mode must reject sponge (not all-ages)", kidsKeys.contains("sponge"))
        assertFalse("Kids mode must reject incredibles (not all-ages)", kidsKeys.contains("incredibles"))
        assertTrue(kidsKeys.contains("paddington"))

        // Must strictly exclude R, TV-MA, NC-17, uncertified, and adult
        assertFalse("Kids mode must reject R-rated title", kidsKeys.contains("deadpool"))
        assertFalse("Kids mode must reject TV-MA title", kidsKeys.contains("got"))
        assertFalse("Kids mode must reject NC-17 title", kidsKeys.contains("nc17_flick"))
        assertFalse("Kids mode must reject uncertified title", kidsKeys.contains("uncertified"))
        assertFalse("Kids mode must reject adult title", kidsKeys.contains("adult_xxx"))
    }

    @Test
    fun testKidsWatchlistAndContinueWatchingIsolation() {
        val kidItem = createTestMediaItem("kid_watch", "Kids Story", certification = "G", isAdult = false)
        val matureItem = createTestMediaItem("mature_watch", "Action Thriller", certification = "R", isAdult = false)
        db.upsertMediaBatch(listOf(kidItem, matureItem), markNewIfInserted = false)

        val profileId = "profile_kids_42"
        db.toggleWatchlist("kid_watch", profileId)
        db.toggleWatchlist("mature_watch", profileId)

        // Query watchlist for regular profile (isKids = false)
        val normalList = db.getWatchlist(profileId = profileId, isKids = false)
        assertEquals(2, normalList.size)

        // Query watchlist for kids profile (isKids = true)
        val kidsList = db.getWatchlist(profileId = profileId, isKids = true)
        assertEquals("Kids watchlist must strictly filter out non-kids certification", 1, kidsList.size)
        assertEquals("kid_watch", kidsList[0].dedupKey)
        assertEquals("G", kidsList[0].certification)
    }

    // =========================================================================
    // 2. ADULT PROGRESS REJECTION & PRIVACY TESTS
    // =========================================================================

    @Test
    fun testAdultPlaybackProgressRejection_ZeroDatabaseTracking() {
        val adultItem = createTestMediaItem("adult_title_1", "Private Adult Feature", certification = "R", isAdult = true)
        val familyItem = createTestMediaItem("family_title_1", "Family Adventure", certification = "PG", isAdult = false)
        db.upsertMediaBatch(listOf(adultItem, familyItem), markNewIfInserted = false)

        val profileId = "prof_privacy_test"

        // 1. Attempt to save progress on adult title
        val adultResult = db.savePlaybackProgress(
            dedupKey = "adult_title_1",
            positionMs = 120_000L,
            durationMs = 600_000L,
            profileId = profileId
        )
        assertFalse("savePlaybackProgress must return false for adult title", adultResult)

        // Verify zero rows in profile_media_state
        val countAdult = getRowCount(
            "SELECT COUNT(*) FROM profile_media_state WHERE profile_id = ? AND dedup_key = ?",
            arrayOf(profileId, "adult_title_1")
        )
        assertEquals("No state row must EVER be inserted for adult title", 0, countAdult)

        // 2. Normal non-adult title progress save succeeds
        val familyResult = db.savePlaybackProgress(
            dedupKey = "family_title_1",
            positionMs = 150_000L,
            durationMs = 600_000L,
            profileId = profileId
        )
        assertTrue("savePlaybackProgress must return true for regular title", familyResult)

        val countFamily = getRowCount(
            "SELECT COUNT(*) FROM profile_media_state WHERE profile_id = ? AND dedup_key = ?",
            arrayOf(profileId, "family_title_1")
        )
        assertEquals("Exactly 1 state row must be inserted for regular title", 1, countFamily)

        // 3. Continue watching must never return adult titles
        val cw = db.getContinueWatchingList(profileId = profileId, isKids = false)
        val cwKeys = cw.map { it.dedupKey }
        assertTrue("Continue watching includes regular title", cwKeys.contains("family_title_1"))
        assertFalse("Continue watching MUST NEVER include adult title", cwKeys.contains("adult_title_1"))
    }

    @Test
    fun testAdultKeywordDetection_IdentifiesAdultMarkers() {
        assertTrue(StreamVaultDatabase.checkIsAdult("Brazzers Live", "raw", "Movies", ""))
        assertTrue(StreamVaultDatabase.checkIsAdult("Title", "raw", "XXX Movies", ""))
        assertTrue(StreamVaultDatabase.checkIsAdult("Title", "raw", "Category", "Erotic|Drama"))
        assertTrue(StreamVaultDatabase.checkIsAdult("Late Night 18+", "raw", "VOD", ""))
        assertTrue(StreamVaultDatabase.checkIsAdult("Playboy Special", "raw", "General", ""))

        assertFalse(StreamVaultDatabase.checkIsAdult("Toy Story 4", "Toy.Story.4.2019", "Animation", "Family|Adventure"))
        assertFalse(StreamVaultDatabase.checkIsAdult("The Dark Knight", "Dark.Knight", "Action", "Action|Crime"))
    }

    // =========================================================================
    // 3. PIN LOCKOUT & LIFECYCLE TESTS
    // =========================================================================

    @Test
    fun testPinInitialState_RequiresSetupAndRejectsDefaults() {
        // No 0000 default!
        assertFalse("No custom PIN should exist initially", prefs.hasCustomParentalPin())
        assertFalse("PIN should not be configured initially", prefs.isPinConfigured())
        assertNull("PIN hash should be null initially", prefs.getPinHash())

        // Default '0000' and arbitrary inputs must fail verification
        assertFalse("Default '0000' must not verify when unset", prefs.verifyParentalPin("0000"))
        assertFalse("Arbitrary '1234' must not verify when unset", prefs.verifyParentalPin("1234"))
    }

    @Test
    fun testSetPinAndVerification_AllowsFirstTimeCreationAndVerifies() {
        // Setting invalid length should fail
        assertFalse("Non-4-digit PIN '12' should be rejected", prefs.setParentalPin(null, "12"))
        assertFalse("Non-4-digit PIN '12345' should be rejected", prefs.setParentalPin(null, "12345"))

        // First-time creation without currentPin succeeds
        assertFalse("Non-digit PIN '12a4' must be rejected", prefs.setParentalPin(null, "12a4"))
        assertTrue("Setting initial 4-digit PIN must succeed", prefs.setParentalPin(null, "8492"))
        assertTrue("PIN is now configured", prefs.hasCustomParentalPin())
        assertTrue("isPinConfigured is true", prefs.isPinConfigured())
        assertNotNull("PIN hash is non-null", prefs.getPinHash())
        assertTrue("New PINs use PBKDF2-HMAC-SHA256", prefs.getPinHash()!!.startsWith("pbkdf2_sha256" + '$' + "100000" + '$'))

        // Verification checks
        assertTrue("Correct PIN '8492' must verify", prefs.verifyParentalPin("8492"))
        assertFalse("Incorrect PIN '0000' must fail", prefs.verifyParentalPin("0000"))
        assertFalse("Incorrect PIN '1234' must fail", prefs.verifyParentalPin("1234"))

        // Updating PIN requires current valid PIN
        assertFalse("Updating PIN with wrong current PIN must fail", prefs.setParentalPin("9999", "1111"))
        assertTrue("Updating PIN with correct current PIN must succeed", prefs.setParentalPin("8492", "1111"))
        assertTrue("New PIN '1111' now verifies", prefs.verifyParentalPin("1111"))
        assertFalse("Old PIN '8492' no longer verifies", prefs.verifyParentalPin("8492"))
    }

    @Test
    fun testFiveFailedAttempts_TriggerSixtySecondLockout() {
        assertTrue(prefs.setParentalPin(null, "7777"))

        val now = System.currentTimeMillis()

        // 4 failed attempts should not lock out
        for (i in 1..4) {
            assertFalse("Wrong attempt $i must fail", prefs.verifyParentalPin("0000"))
            assertTrue("Must not be locked out after $i attempts", prefs.getPinLockoutUntil() <= System.currentTimeMillis())
        }

        // 5th failed attempt triggers 60s lockout
        assertFalse("5th wrong attempt must fail", prefs.verifyParentalPin("0000"))
        val lockoutUntil = prefs.getPinLockoutUntil()
        assertTrue("Lockout must be set into the future (> now)", lockoutUntil > now + 50_000L)

        // Even the CORRECT PIN must be rejected during lockout!
        assertFalse("Correct PIN must be rejected while locked out", prefs.verifyParentalPin("7777"))
    }

    @Test
    fun testSignOut_ClearsPinHashLockoutAndActiveProfile() {
        assertTrue(prefs.setParentalPin(null, "3333"))
        prefs.setActiveProfileId("prof_user_99")

        // Trigger lockout
        for (i in 1..5) {
            prefs.verifyParentalPin("9999")
        }
        assertTrue("Lockout is active", prefs.getPinLockoutUntil() > System.currentTimeMillis())
        assertEquals("prof_user_99", prefs.getActiveProfileId())

        // Clear auth session (Sign out)
        prefs.clearAuthSession()

        // Verify everything is wiped clean
        assertFalse("PIN hash must be purged on sign-out", prefs.hasCustomParentalPin())
        assertNull("PIN hash must be null", prefs.getPinHash())
        assertEquals("PIN lockout must be cleared", 0L, prefs.getPinLockoutUntil())
        assertEquals("Active profile must be cleared", "", prefs.getActiveProfileId())
        assertFalse("Auth session must be false", prefs.hasActiveSession())
    }

    @Test
    fun testWave1Security_ApiRouterAuthRestoreTicketsAndPackBounds() {
        val syncEngine = CatalogSyncEngine(db, prefs, kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.IO))
        val router = AppApiRouter(context, db, prefs, syncEngine)

        // SEC-04: Reject arbitrary Bearer tokens & protect destructive routes when logged out
        val unauthReset = router.handle("POST", "/api/factory-reset", "{}", "Bearer fake_token_value")
        assertTrue("Fake Bearer token must be rejected on /api/factory-reset", unauthReset.contains("\"status\":401"))

        val validToken = "a".repeat(64)
        prefs.setAuthToken(validToken)
        prefs.saveCredentials(XtreamCredentials(serverUrl = "http://iptv.example.com:8080", username = "u1", password = "mySecretPassword99"))

        val spoofedDetail = router.handle("GET", "/api/detail?dedupKey=x", "", "Bearer wrong_token_value")
        assertTrue("Mismatched Bearer token must be rejected", spoofedDetail.contains("\"status\":401"))

        // SEC-04: action=restore blocked once PIN is configured
        assertTrue(prefs.setParentalPin(null, "2468"))
        val restoreBlocked = router.handle(
            "POST",
            "/api/parental-pin",
            """{"action":"restore","pinHash":"${"b".repeat(64)}","pinSalt":"salt-1234-5678"}""",
            "Bearer $validToken"
        )
        assertTrue("restore must fail once PIN is already configured", restoreBlocked.contains("\"success\":false"))

        // SEC-04: Adult item blocked when vault locked; stream-url returns opaque ticket without password
        val familyItem = createTestMediaItem("fam_sec", "Family Film", certification = "G", isAdult = false)
        val adultItem = createTestMediaItem("adult_sec", "Adult Feature", certification = "R", isAdult = true)
        db.upsertMediaBatch(listOf(familyItem, adultItem), markNewIfInserted = false)

        val lockedAdult = router.handle("GET", "/api/detail?dedupKey=adult_sec", "", "Bearer $validToken")
        assertTrue("Locked adult detail must be refused", lockedAdult.contains("\"status\":403"))

        val streamResp = router.handle("POST", "/api/stream-url", """{"kind":"movie","id":"stream_fam_sec","ext":"mp4"}""", "Bearer $validToken")
        val ticketUrl = org.json.JSONObject(streamResp).getString("url")
        assertTrue("Stream response uses opaque sv-stream ticket: $streamResp", ticketUrl.startsWith("sv-stream://"))
        assertFalse("Stream response must NEVER expose IPTV password to WebView", streamResp.contains("mySecretPassword99"))
        val resolved = router.resolveStreamTicket(ticketUrl)
        assertNotNull("Valid ticket resolves natively", resolved)
        assertTrue(resolved!!.first.contains("mySecretPassword99"))
        assertNull("Ticket is single-use", router.resolveStreamTicket(ticketUrl))

        // SEC-12: Legacy SHA-256 PIN backward compat still verifies + clearAuthSession clears password
        prefs.clearAuthSession()
        assertEquals("clearAuthSession must wipe IPTV password", "", prefs.loadCredentials().password)

        // SEC-10: PackManager rejects corrupt header length (>4084)
        val pm = PackManager(context, prefs)
        val badPack = File(context.cacheDir, "bad_header.svpack")
        RandomAccessFile(badPack, "rw").use { raf ->
            val hdr = ByteArray(4096)
            "SVPACK01".toByteArray(Charsets.US_ASCII).copyInto(hdr, 0)
            hdr[8] = 0x10; hdr[9] = 0x27 // length = 10000 > 4084
            raf.write(hdr)
        }
        var headerRejected = false
        try { pm.readHeader(badPack) } catch (_: java.io.IOException) { headerRejected = true }
        assertTrue("PackManager must reject out-of-range header length", headerRejected)
        badPack.delete()
    }

    // =========================================================================
    // Helper Methods
    // =========================================================================

    private fun createTestMediaItem(
        dedupKey: String,
        title: String,
        certification: String,
        isAdult: Boolean
    ): MediaItem {
        return MediaItem(
            dedupKey = dedupKey,
            primaryStreamId = "stream_$dedupKey",
            cleanTitle = title,
            rawTitle = title,
            certification = certification,
            isAdult = isAdult,
            mediaType = MediaType.MOVIE,
            year = 2024,
            rating = 8.0,
            categoryName = if (isAdult) "Adult 18+" else "Movies"
        )
    }

    private fun getRowCount(sql: String, args: Array<String>): Int {
        db.readableDatabase.rawQuery(sql, args).use { cursor ->
            if (cursor.moveToFirst()) {
                return cursor.getInt(0)
            }
        }
        return 0
    }
}
