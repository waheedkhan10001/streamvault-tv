package com.streamvault.tv

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import androidx.test.core.app.ApplicationProvider
import com.streamvault.tv.data.MediaItem
import com.streamvault.tv.data.MediaType
import com.streamvault.tv.data.PackApplier
import com.streamvault.tv.data.StreamVaultDatabase
import com.streamvault.tv.data.SuperFilterState
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/** The app copies details from a (small, made-up) pack: matching by TMDB id and by name, ratings, Kids decision, sorting, re-sync. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class PackApplierTest {
    private lateinit var context: Context
    private lateinit var db: StreamVaultDatabase
    private lateinit var packFile: File

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        context.deleteDatabase("streamvault_tv.db")
        db = StreamVaultDatabase(context)
        packFile = File(context.cacheDir, "test-enrich.db").also { it.delete() }
        val p = SQLiteDatabase.openOrCreateDatabase(packFile, null)
        p.execSQL(
            """CREATE TABLE titles (pid INTEGER PRIMARY KEY, type TEXT, tmdb_id INTEGER, imdb_id TEXT, year INTEGER, plot TEXT, genres TEXT,
               runtime INTEGER, cast_text TEXT, director TEXT, rating REAL, rating_votes INTEGER, rating_source TEXT, sort_score REAL,
               certification TEXT, kids_ok INTEGER, poster_path TEXT, backdrop_path TEXT, poster_off INTEGER, poster_len INTEGER)"""
        )
        p.execSQL("CREATE TABLE aliases (norm TEXT, year INTEGER, pid INTEGER)")
        // 1: Finding Nemo (kids ok, UK rating used), 2: a series, 3: a violent film with a high rating
        p.execSQL("INSERT INTO titles VALUES (1,'movie',12,'tt0266543',2003,'A clownfish searches.','Animation, Family',100,'Albert Brooks, Ellen DeGeneres','Andrew Stanton',8.2,1000000,'I',8.1,'U',1,'/p1.jpg','/b1.jpg',0,500)")
        p.execSQL("INSERT INTO titles VALUES (2,'tv',34,'tt1',2010,'A show.','Drama',45,'A, B','',7.0,50,'T',6.5,'',0,'/p2.jpg','',500,300)")
        p.execSQL("INSERT INTO titles VALUES (3,'movie',56,'tt2',2016,'Merc.','Action',108,'Ryan','Tim Miller',8.0,900000,'I',7.9,'R',0,NULL,'/b3.jpg',NULL,NULL)")
        p.execSQL("INSERT INTO aliases VALUES ('findingnemo',2003,1)")
        p.execSQL("INSERT INTO aliases VALUES ('findingnemo',0,1)")
        p.execSQL("INSERT INTO aliases VALUES ('nemotsoek',2003,1)")
        p.execSQL("INSERT INTO aliases VALUES ('theshow',2010,2)")
        p.close()
    }

    @After
    fun tearDown() { db.close(); context.deleteDatabase("streamvault_tv.db"); packFile.delete() }

    private fun item(key: String, title: String, year: Int, tmdb: Int = 0, type: MediaType = MediaType.MOVIE) = MediaItem(
        dedupKey = key, primaryStreamId = "s_$key", cleanTitle = title, rawTitle = title, year = year, tmdbId = tmdb, mediaType = type, categoryName = "Movies"
    )

    @Test
    fun appNormMatchesPackBuilder() {
        assertEquals("findingnemo", PackApplier.appNorm("Finding  Nemo!"))
        assertEquals("amélie", PackApplier.appNorm("Amélie"))
        assertEquals("a|b|c", PackApplier.listToApp("a, b ,c"))
    }

    @Test
    fun matchesByIdAndByNameAndSetsKidsRatingAndSort() {
        db.upsertMediaBatch(
            listOf(
                item("nemo", "Finding Nemo", 2003),                       // by name + year
                item("show", "The Show", 0, tmdb = 34, type = MediaType.SERIES),   // by TMDB id
                item("deadpool", "Whatever Provider Calls It", 2016, tmdb = 56),
                item("unknown", "Totally Unknown Film", 1999)
            ),
            markNewIfInserted = false
        )
        val r = PackApplier(db, packFile).applyAll()
        assertEquals(3, r.applied)
        assertEquals(1, r.unmatched)

        val all = db.queryMedia(SuperFilterState(), isKids = false, isAdultVaultUnlocked = false, isVaultTab = false).associateBy { it.dedupKey }
        val nemo = all.getValue("nemo")
        assertEquals("I", nemo.ratingSource)
        assertEquals(8.2, nemo.rating, 0.001)
        assertEquals(1000000, nemo.voteCount)
        assertEquals("A clownfish searches.", nemo.plot)
        assertEquals(listOf("Animation", "Family"), nemo.genres)
        assertEquals("file:///api/pack/poster/0_500", nemo.posterUrl)
        assertEquals("https://image.tmdb.org/t/p/w1280/b1.jpg", nemo.backdropUrl)
        assertEquals("T", all.getValue("show").ratingSource)
        assertTrue(all.getValue("unknown").isEnriched)

        // Kids sees only what the pack says is fine for kids
        val kids = db.queryMedia(SuperFilterState(), isKids = true, isAdultVaultUnlocked = false, isVaultTab = false).map { it.dedupKey }
        assertEquals(listOf("nemo"), kids)

        // Highest Rated uses the weighted score
        val sorted = db.queryMedia(SuperFilterState(sortBy = com.streamvault.tv.data.SortOption.RATING_DESC), isKids = false, isAdultVaultUnlocked = false, isVaultTab = false).map { it.dedupKey }
        assertEquals(listOf("nemo", "deadpool", "show"), sorted.take(3))
    }

    @Test
    fun resyncKeepsPackData() {
        db.upsertMediaBatch(listOf(item("nemo", "Finding Nemo", 2003)), markNewIfInserted = false)
        PackApplier(db, packFile).applyAll()
        // the provider list is loaded again (daily sync): pack details, Kids decision and sort score must stay
        db.upsertMediaBatch(listOf(item("nemo", "Finding Nemo", 2003)), markNewIfInserted = false)
        val nemo = db.queryMedia(SuperFilterState(), isKids = true, isAdultVaultUnlocked = false, isVaultTab = false).single()
        assertEquals("I", nemo.ratingSource)
        assertEquals(8.2, nemo.rating, 0.001)
        assertEquals("A clownfish searches.", nemo.plot)
    }
}
