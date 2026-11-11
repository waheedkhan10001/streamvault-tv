package com.streamvault.tv

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.streamvault.tv.data.LiveChannel
import com.streamvault.tv.data.MediaItem
import com.streamvault.tv.data.MediaType
import com.streamvault.tv.data.StreamVaultDatabase
import com.streamvault.tv.data.StreamVersion
import com.streamvault.tv.data.TitleParser
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The chunked catalog import: the same title arriving in several chunks is merged, an unchanged title is not
 * written again, copies the provider no longer lists are removed (and a title with no copy left is deleted),
 * and a title listed once with and once without a TMDB id is folded into one card.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class CatalogImportMergeTest {

    private lateinit var context: Context
    private lateinit var db: StreamVaultDatabase

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        context.deleteDatabase("streamvault_tv.db")
        db = StreamVaultDatabase(context)
    }

    @After
    fun tearDown() {
        db.close()
        context.deleteDatabase("streamvault_tv.db")
    }

    private fun version(id: String, raw: String = "Heat (1995)") = StreamVersion(
        streamId = id, rawTitle = raw, languageTag = "English", qualityTag = "1080p", subtitleTag = "",
        containerExtension = "mkv", categoryId = "1", categoryName = "Movies", addedTimestamp = 100L
    )

    private fun item(key: String, v: StreamVersion, type: MediaType = MediaType.MOVIE, category: String = "Movies") = MediaItem(
        dedupKey = key, primaryStreamId = v.streamId, mediaType = type, cleanTitle = "Heat", rawTitle = v.rawTitle,
        year = 1995, categoryId = "1", categoryName = category, versions = listOf(v)
    )

    @Test
    fun sameTitleInTwoChunks_isMergedIntoOneCardWithBothCopies() {
        db.upsertMediaBatch(listOf(item("heat:1995", version("11"))), markNewIfInserted = false, mergeVersions = true)
        db.upsertMediaBatch(listOf(item("heat:1995", version("12"))), markNewIfInserted = false, mergeVersions = true)
        val saved = db.getItemByDedupKey("heat:1995")
        assertNotNull(saved)
        assertEquals(setOf("11", "12"), saved!!.versions.map { it.streamId }.toSet())
        assertEquals(1, db.countMediaOfType(MediaType.MOVIE))
    }

    @Test
    fun anUnchangedTitleIsNotCountedAsNewAndKeepsItsCopies() {
        val first = db.upsertMediaBatch(listOf(item("heat:1995", version("11"))), markNewIfInserted = true, mergeVersions = true)
        val again = db.upsertMediaBatch(listOf(item("heat:1995", version("11"))), markNewIfInserted = true, mergeVersions = true)
        assertEquals(1, first)
        assertEquals(0, again)
        assertEquals(1, db.getItemByDedupKey("heat:1995")!!.versions.size)
    }

    @Test
    fun removeUnseen_dropsOneLostCopy_andDeletesATitleWithNoCopyLeft() {
        db.upsertMediaBatch(
            listOf(
                item("heat:1995", version("11")),
                item("heat:1995", version("12")),
                item("alien:1979", version("21", "Alien (1979)")).copy(cleanTitle = "Alien")
            ).groupBy { it.dedupKey }.map { (_, list) -> list.first().copy(versions = list.flatMap { it.versions }) },
            markNewIfInserted = false, mergeVersions = true
        )
        val (titles, copies) = db.removeUnseenMedia(MediaType.MOVIE, setOf("11"))
        assertEquals(1, titles)          // Alien is gone completely
        assertEquals(2, copies)          // copy 12 of Heat and copy 21 of Alien
        assertNull(db.getItemByDedupKey("alien:1979"))
        val heat = db.getItemByDedupKey("heat:1995")
        assertNotNull(heat)
        assertEquals(listOf("11"), heat!!.versions.map { it.streamId })
        assertEquals("11", heat.primaryStreamId)
    }

    @Test
    fun removeUnseen_changesNothingWhenEverythingIsStillListed() {
        db.upsertMediaBatch(listOf(item("heat:1995", version("11"))), markNewIfInserted = false, mergeVersions = true)
        val (titles, copies) = db.removeUnseenMedia(MediaType.MOVIE, setOf("11", "99"))
        assertEquals(0, titles)
        assertEquals(0, copies)
        assertEquals(1, db.countMediaOfType(MediaType.MOVIE))
    }

    @Test
    fun removeUnseenLive_removesOnlyChannelsTheProviderDroppedAndKeepsFavourites() {
        db.upsertLiveChannels(listOf(LiveChannel("1", "One"), LiveChannel("2", "Two"), LiveChannel("3", "Three")))
        assertEquals(3, db.countLiveChannels())
        val removed = db.removeUnseenLive(setOf("1", "3"))
        assertEquals(1, removed)
        assertEquals(2, db.countLiveChannels())
    }

    @Test
    fun foldLooseDuplicates_mergesTheCopyWithoutATmdbIdIntoTheTmdbCard() {
        val looseKey = TitleParser.parse("Heat (1995)", "Movies").dedupKey
        db.upsertMediaBatch(listOf(item("tmdb:949", version("11")).copy(tmdbId = 949)), markNewIfInserted = false, mergeVersions = true)
        db.upsertMediaBatch(listOf(item(looseKey, version("12"))), markNewIfInserted = false, mergeVersions = true)
        assertEquals(2, db.countMediaOfType(MediaType.MOVIE))
        val folded = db.foldLooseDuplicates(MediaType.MOVIE)
        assertEquals(1, folded)
        assertEquals(1, db.countMediaOfType(MediaType.MOVIE))
        assertEquals(setOf("11", "12"), db.getItemByDedupKey("tmdb:949")!!.versions.map { it.streamId }.toSet())
    }
}
