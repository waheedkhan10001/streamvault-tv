package com.streamvault.tv.data

import java.util.Locale

/**
 * "More Like This" scoring, kept free of any database so it can be unit-tested on its own.
 * score() returns null when the candidate is not a match at all, otherwise a number: higher = closer.
 * A candidate only counts when it reaches [minScore] for the chosen match mode.
 */
object RelatedScoring {

    fun minScore(mode: String): Int = when (mode) {
        "story" -> 6
        "setting" -> 6
        "cast_director" -> 3
        else -> 6
    }

    private fun words(t: String): Set<String> =
        t.lowercase(Locale.ROOT).split(Regex("[^a-z]+")).filter { it.length > 4 }.toSet()

    /** The first word(s) of a title, to spot sequels / same franchise ("Fast Furious 7" ~ "Fast Furious"). */
    private fun franchiseKey(title: String): String {
        val ws = title.lowercase(Locale.ROOT).split(Regex("[^a-z0-9]+")).filter { it.isNotEmpty() && it !in setOf("the", "a", "an") }
        return ws.take(2).joinToString(" ")
    }

    fun score(item: MediaItem, cand: MediaItem, mode: String): Int? {
        if (cand.dedupKey == item.dedupKey) return null
        if (cand.mediaType != item.mediaType) return null     // movies are matched with movies, series with series
        val itemGenres = item.genres.toSet()
        val sharedGenres = cand.genres.intersect(itemGenres).size
        val sameDir = item.director.isNotBlank() && cand.director == item.director
        val sharedCast = cand.cast.intersect(item.cast.toSet()).size
        val sameLang = cand.language == item.language
        val eraClose = item.year > 0 && cand.year > 0 && Math.abs(cand.year - item.year) <= 10
        val sameCert = item.certification.isNotBlank() && cand.certification == item.certification
        val fk = franchiseKey(item.cleanTitle)
        val sameFranchise = fk.contains(' ') && fk == franchiseKey(cand.cleanTitle)
        // all of the title's genres shared counts for more than one of many
        val genreScore = if (itemGenres.isEmpty()) 0 else sharedGenres * 3 + (if (sharedGenres == itemGenres.size && sharedGenres >= 2) 2 else 0)
        val raw: Int? = when (mode) {
            "story" -> {
                val overlap = words(cand.plot).intersect(words(item.plot)).size
                if (sharedGenres == 0 && overlap < 2) null
                else genreScore + minOf(overlap, 6) * 2 + (if (sameCert) 2 else 0) + (if (sameFranchise) 6 else 0)
            }
            "setting" -> if (!sameLang) null else 4 + (if (eraClose) 4 else 0) + sharedGenres + (if (sameFranchise) 6 else 0)
            "cast_director" -> if (!sameDir && sharedCast == 0) null else (if (sameDir) 5 else 0) + sharedCast * 3
            else -> genreScore + (if (sameDir) 5 else 0) + sharedCast * 2 + (if (eraClose) 1 else 0) + (if (sameFranchise) 6 else 0)
        }
        // a poorly rated title is a weaker suggestion: it loses a point or two
        val adj = raw?.let { if (cand.rating in 0.1..4.9) it - 2 else it }
        return adj?.takeIf { it >= minScore(mode) }
    }

    /** Sort key: score first, then rating, so equal scores show the better-rated title first. */
    fun sortKey(score: Int, rating: Double): Double = score * 100.0 + rating
}
