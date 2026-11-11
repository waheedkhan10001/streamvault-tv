package com.streamvault.tv

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.streamvault.tv.data.ContentCertifications
import com.streamvault.tv.data.MediaItem
import com.streamvault.tv.data.MediaType
import com.streamvault.tv.data.PreferencesManager
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
        val expected = setOf("G", "PG", "TV-Y", "TV-Y7", "TV-G", "TV-PG", "U")
        assertEquals(expected, ContentCertifications.KIDS_CERTIFICATIONS)

        val clause = ContentCertifications.kidsClause("certification")
        assertTrue("Kids clause must check certification IN list", clause.contains("certification IN ("))
        for (cert in expected) {
            assertTrue("Kids clause must contain cert '$cert'", clause.contains("'$cert'"))
        }
        assertTrue("Kids clause must exclude empty certification", clause.contains("certification != ''"))
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

        // Must ONLY contain the 7 approved kids certifications (G, PG, TV-Y, TV-G, TV-Y7, TV-PG, U)
        assertEquals("Kids catalog must contain only the 7 approved kids titles", 7, kidsResults.size)
        assertTrue(kidsKeys.contains("nemo"))
        assertTrue(kidsKeys.contains("shrek"))
        assertTrue(kidsKeys.contains("bluey"))
        assertTrue(kidsKeys.contains("peppa"))
        assertTrue(kidsKeys.contains("sponge"))
        assertTrue(kidsKeys.contains("incredibles"))
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
        assertTrue("Setting initial 4-digit PIN must succeed", prefs.setParentalPin(null, "8492"))
        assertTrue("PIN is now configured", prefs.hasCustomParentalPin())
        assertTrue("isPinConfigured is true", prefs.isPinConfigured())
        assertNotNull("PIN hash is non-null", prefs.getPinHash())

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
