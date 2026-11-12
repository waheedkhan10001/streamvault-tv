package com.streamvault.tv

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.streamvault.tv.data.MediaItem
import com.streamvault.tv.data.MediaType
import com.streamvault.tv.data.StreamVaultDatabase
import com.streamvault.tv.data.StreamVersion
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** A new TV takes only the TMDB ids from the cloud copy, and never overwrites an id it already has. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class CloudIdsTest {
    private lateinit var context: Context
    private lateinit var db: StreamVaultDatabase

    @Before fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        context.deleteDatabase("streamvault_tv.db")
        db = StreamVaultDatabase(context)
    }

    @After fun tearDown() { db.close(); context.deleteDatabase("streamvault_tv.db") }

    private fun item(key: String, tmdb: Int = 0): MediaItem {
        val v = StreamVersion("s$key", "Raw $key", "English", "1080p", "", "mkv", "1", "Movies", 100L)
        return MediaItem(dedupKey = key, primaryStreamId = v.streamId, mediaType = MediaType.MOVIE, cleanTitle = key, rawTitle = v.rawTitle,
            year = 2001, categoryId = "1", categoryName = "Movies", tmdbId = tmdb, versions = listOf(v))
    }

    @Test fun missingIdsAreFilled_existingIdsAndUnknownTitlesAreLeftAlone() {
        db.upsertMediaBatch(listOf(item("a:2001"), item("b:2001", tmdb = 555)), markNewIfInserted = false, mergeVersions = true)
        val filled = db.fillMissingTmdbIds(listOf("a:2001" to 10, "b:2001" to 99, "zzz:2001" to 7, "a:2001" to 0))
        assertEquals(1, filled)                                   // only "a" changed
        assertEquals(10, db.getItemByDedupKey("a:2001")!!.tmdbId)
        assertEquals(555, db.getItemByDedupKey("b:2001")!!.tmdbId) // kept its own id
    }

    @Test fun titlesKnownNotToBeOnTmdbAreMarkedDone_othersAreLeftAlone() {
        db.upsertMediaBatch(listOf(item("x:2001"), item("y:2001", tmdb = 77)), markNewIfInserted = false, mergeVersions = true)
        assertEquals(false, db.getItemByDedupKey("x:2001")!!.isEnriched)
        val marked = db.markNotOnTmdb(listOf("x:2001", "y:2001", "missing:2001"))
        assertEquals(1, marked)                                               // only "x"
        assertEquals(true, db.getItemByDedupKey("x:2001")!!.isEnriched)       // will not be searched again
        assertEquals(false, db.getItemByDedupKey("y:2001")!!.isEnriched)      // has an id: normal lookup still pending
        assertEquals(0, db.markNotOnTmdb(listOf("x:2001")))                   // already done: nothing to do
    }

    @Test fun anEmptyListChangesNothing() = assertEquals(0, db.fillMissingTmdbIds(emptyList()))
}
