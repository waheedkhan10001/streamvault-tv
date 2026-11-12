package com.streamvault.tv.data

import java.util.Locale

/**
 * "More Like This" scoring, kept free of any database so it can be unit-tested on its own.
 * score() returns null when the candidate is not a match at all, otherwise a number: higher = closer.
 * A candidate only counts when it reaches [minScore] for the chosen match mode.
 */
/** What this profile's own star ratings say: liked genres/people (4-5 stars) and genres to avoid (1-2 stars). */
class Taste(val likedGenres: Set<String>, val dislikedGenres: Set<String>, val likedPeople: Set<String>) {
    val isEmpty get() = likedGenres.isEmpty() && dislikedGenres.isEmpty() && likedPeople.isEmpty()
}

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

    fun score(item: MediaItem, cand: MediaItem, mode: String, taste: Taste? = null): Int? {
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
        val sameCategory = item.categoryName.isNotBlank() && cand.categoryName == item.categoryName
        // all of the title's genres shared counts for more than one of many (a title with a single genre needs that bonus to qualify at all)
        val genreScore = when {
            itemGenres.isEmpty() -> if (sameCategory) 5 else 0   // not enriched yet: the provider category stands in for genres
            else -> sharedGenres * 3 + (if (sharedGenres == itemGenres.size && sharedGenres >= 1) (if (itemGenres.size == 1) 3 else 2) else 0)
        }
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
        // the profile's own star ratings nudge related titles up or down (never create a match out of nothing)
        val tasted = raw?.let { r ->
            if (taste == null || taste.isEmpty || r < 3) r else {
                var t = r
                val liked = cand.genres.count { it in taste.likedGenres }
                t += minOf(2, liked)
                if (cand.director.isNotBlank() && cand.director in taste.likedPeople || cand.cast.any { it in taste.likedPeople }) t += 1
                if (cand.genres.isNotEmpty() && cand.genres.count { it in taste.dislikedGenres } >= minOf(2, cand.genres.size)) t -= 2
                t
            }
        }
        // a poorly rated title is a weaker suggestion: it loses a point or two
        val adj = tasted?.let { if (cand.rating in 0.1..4.9) it - 2 else it }
        return adj?.takeIf { it >= minScore(mode) }
    }

    /** Sort key: score first, then rating, so equal scores show the better-rated title first. */
    fun sortKey(score: Int, rating: Double): Double = score * 100.0 + rating
}
