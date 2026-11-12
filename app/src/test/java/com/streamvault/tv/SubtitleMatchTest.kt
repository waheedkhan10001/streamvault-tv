package com.streamvault.tv

import com.streamvault.tv.data.SubtitleService
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The subtitle fallback for titles with no TMDB/IMDb id may only accept a certain match. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class SubtitleMatchTest {
    private val movies = """{"results":[
        {"id":11,"title":"The Matrix Reloaded","release_date":"2003-05-15"},
        {"id":22,"title":"The Matrix","release_date":"1999-03-30"},
        {"id":33,"title":"The Matrix","release_date":"2021-12-01"}]}"""

    @Test fun exact_title_and_year_is_accepted() =
        assertEquals(22, SubtitleService.pickExactMatch(movies, "The Matrix", 1999, false))

    @Test fun punctuation_and_case_do_not_matter() =
        assertEquals(22, SubtitleService.pickExactMatch(movies, "the matrix!", 1999, false))

    @Test fun wrong_year_is_refused() =
        assertEquals(0, SubtitleService.pickExactMatch(movies, "The Matrix", 2010, false))

    @Test fun unknown_year_is_refused_for_movies() =
        assertEquals(0, SubtitleService.pickExactMatch(movies, "The Matrix", 0, false))

    @Test fun a_longer_title_is_not_the_same_title() =
        assertEquals(0, SubtitleService.pickExactMatch(movies, "Matrix", 1999, false))

    @Test fun series_match_by_exact_name() {
        val tv = """{"results":[{"id":5,"name":"Breaking Bad","original_name":"Breaking Bad"},{"id":6,"name":"Breaking Bad Extras"}]}"""
        assertEquals(5, SubtitleService.pickExactMatch(tv, "Breaking Bad", 0, true))
        assertEquals(0, SubtitleService.pickExactMatch(tv, "Breaking", 0, true))
    }

    @Test fun garbage_answer_gives_nothing() =
        assertEquals(0, SubtitleService.pickExactMatch("not json", "The Matrix", 1999, false))
}
