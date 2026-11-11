package com.streamvault.tv

import com.streamvault.tv.data.MediaItem
import com.streamvault.tv.data.MediaType
import com.streamvault.tv.data.RelatedScoring
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** "More Like This" scoring on its own (no database). */
class RelatedScoringTest {
    private fun m(
        key: String, title: String = key, type: MediaType = MediaType.MOVIE, genres: List<String> = emptyList(),
        director: String = "", cast: List<String> = emptyList(), year: Int = 2000, rating: Double = 7.0,
        lang: String = "English", plot: String = ""
    ) = MediaItem(
        dedupKey = key, primaryStreamId = key, cleanTitle = title, rawTitle = title, mediaType = type, genres = genres,
        director = director, cast = cast, year = year, rating = rating, language = lang, plot = plot
    )

    private val base = m("a", "Heat", genres = listOf("Crime", "Drama", "Thriller"), director = "Mann", cast = listOf("Pacino", "De Niro"))

    @Test fun sameItemIsNeverItsOwnSuggestion() = assertNull(RelatedScoring.score(base, base, "everything"))

    @Test fun moviesAreNotMatchedWithSeries() {
        val series = m("s", "Crime Show", type = MediaType.SERIES, genres = listOf("Crime", "Drama", "Thriller"))
        assertNull(RelatedScoring.score(base, series, "everything"))
    }

    @Test fun oneSharedGenreAloneIsNotEnough() {
        val weak = m("w", "Romcom", genres = listOf("Drama", "Romance"))
        assertNull(RelatedScoring.score(base, weak, "everything"))
    }

    @Test fun closerMatchScoresHigherThanLooserMatch() {
        val close = m("c", "Ronin", genres = listOf("Crime", "Drama", "Thriller"), cast = listOf("De Niro"))
        val loose = m("l", "Other", genres = listOf("Crime", "Drama"))
        val sc = RelatedScoring.score(base, close, "everything")
        val sl = RelatedScoring.score(base, loose, "everything")
        assertNotNull(sc); assertNotNull(sl)
        assertTrue(sc!! > sl!!)
    }

    @Test fun sameDirectorOrFranchiseCountsStrongly() {
        val sameDir = m("d", "Collateral", genres = listOf("Crime"), director = "Mann")
        assertNotNull(RelatedScoring.score(base, sameDir, "everything"))
        val sequel = m("f", "Fast Furious 7", genres = listOf("Action"))
        val orig = m("g", "Fast Furious", genres = listOf("Action"))
        assertNotNull(RelatedScoring.score(orig, sequel, "everything"))
    }

    @Test fun poorlyRatedTitleScoresLowerThanTheSameTitleWellRated() {
        // 2 shared genres = 6 points: a well rated one just reaches the cut-off, a poorly rated one falls under it
        val good = m("g1", "X", genres = listOf("Crime", "Drama"), rating = 8.0)
        val bad = m("b1", "Y", genres = listOf("Crime", "Drama"), rating = 3.0)
        assertNotNull(RelatedScoring.score(base, good, "everything"))
        assertNull(RelatedScoring.score(base, bad, "everything"))
    }

    @Test fun castDirectorModeNeedsAPersonInCommon() {
        val noPerson = m("n", "Z", genres = listOf("Crime", "Drama", "Thriller"))
        assertNull(RelatedScoring.score(base, noPerson, "cast_director"))
        val actor = m("p", "Casino", cast = listOf("De Niro"))
        assertNotNull(RelatedScoring.score(base, actor, "cast_director"))
    }

    @Test fun settingModeNeedsSameLanguage() {
        val urdu = m("u", "Drama", genres = listOf("Drama"), lang = "Urdu")
        assertNull(RelatedScoring.score(base, urdu, "setting"))
        val en = m("e", "Drama2", genres = listOf("Drama"), lang = "English", year = 1998)
        assertNotNull(RelatedScoring.score(base, en, "setting"))
    }
}
