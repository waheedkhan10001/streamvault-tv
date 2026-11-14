package com.streamvault.tv.data

import android.content.ContentValues
import android.database.sqlite.SQLiteDatabase
import java.io.File
import java.util.Locale

/**
 * Copies details from the installed enrichments pack into the app's catalog (media_items).
 * This is the ONLY place details, ratings and age ratings come from now: the TV no longer asks TMDB itself.
 *
 * Matching (same rules the pack was built with):
 *   1. the title's TMDB id (+ movie/series) -> pack row
 *   2. else the name index: normalised clean title + year, then the same name with year 0
 * Titles the pack does not know are marked done (is_enriched = 1) with no details, so they are not tried again;
 * the daily update (unknown-title batch) is where they get looked up later.
 */
class PackApplier(private val db: StreamVaultDatabase, private val packDbFile: File) {

    data class Result(val applied: Int, val unmatched: Int)

    companion object {
        /** Same as the pack builder's appNorm(): NFC, lower case, keep only letters and digits. */
        fun appNorm(s: String): String {
            val n = java.text.Normalizer.normalize(s, java.text.Normalizer.Form.NFC).lowercase(Locale.ROOT)
            val sb = StringBuilder(n.length)
            var i = 0
            while (i < n.length) {
                val cp = n.codePointAt(i)
                if (Character.isLetterOrDigit(cp)) sb.appendCodePoint(cp)
                i += Character.charCount(cp)
            }
            return sb.toString()
        }

        /** The pack stores lists as "a, b, c"; the app stores them as "a|b|c". */
        fun listToApp(s: String?): String =
            (s ?: "").split(",").map { it.trim() }.filter { it.isNotEmpty() }.joinToString("|")

        fun posterUrl(off: Long, len: Int): String = "file:///api/pack/poster/${off}_$len"
        fun backdropUrl(path: String?): String =
            if (!path.isNullOrBlank() && path.startsWith("/")) "https://image.tmdb.org/t/p/w1280$path" else ""
    }

    /** Applies the pack to every catalog title that has not been looked up yet. Blocking: run on a background thread. */
    fun applyAll(isActive: () -> Boolean = { true }, shouldPause: () -> Boolean = { false }, onProgress: (Int) -> Unit = {}): Result {
        var applied = 0
        var unmatched = 0
        val pack = SQLiteDatabase.openDatabase(packDbFile.path, null, SQLiteDatabase.OPEN_READWRITE)
        try {
            // Lookups by TMDB id used to scan the whole pack table for every title: an index makes each one instant
            val t0 = System.currentTimeMillis()
            runCatching { pack.execSQL("CREATE INDEX IF NOT EXISTS idx_titles_tmdb ON titles(type, tmdb_id)") }
            DiagLog.add("Pack index ready in ${System.currentTimeMillis() - t0} ms")
            var batchNo = 0
            while (isActive()) {
                // stay out of the way while someone is browsing or watching
                while (isActive() && shouldPause()) Thread.sleep(400)
                val tq = System.currentTimeMillis()
                val batch = db.getUnenrichedMediaQueue(emptySet(), limit = 200, ordered = false)
                if (batch.isEmpty()) break
                val tb = System.currentTimeMillis()
                val wdb = db.writableDatabase
                wdb.beginTransactionNonExclusive()
                try {
                    for (item in batch) {
                        val pid = findPid(pack, item)
                        if (pid != null && applyOne(pack, wdb, item, pid)) applied++
                        else { markDone(wdb, item.dedupKey); unmatched++ }
                    }
                    wdb.setTransactionSuccessful()
                } finally {
                    wdb.endTransaction()
                }
                batchNo++
                if (batchNo % 10 == 1) DiagLog.add("Pack fill batch $batchNo: read ${tb - tq} ms, apply ${System.currentTimeMillis() - tb} ms (${batch.size} titles)")
                onProgress(batch.size)
                Thread.sleep(60)   // a short rest so browsing stays smooth
            }
        } finally {
            pack.close()
        }
        return Result(applied, unmatched)
    }

    private fun typeOf(item: MediaItem) = if (item.mediaType == MediaType.SERIES) "tv" else "movie"

    private fun findPid(pack: SQLiteDatabase, item: MediaItem): Long? {
        val type = typeOf(item)
        if (item.tmdbId > 0) {
            pack.rawQuery("SELECT pid FROM titles WHERE type = ? AND tmdb_id = ? LIMIT 1", arrayOf(type, item.tmdbId.toString())).use {
                if (it.moveToFirst()) return it.getLong(0)
            }
        }
        val norm = appNorm(item.cleanTitle)
        if (norm.length < 2) return null
        for (year in listOf(item.year, 0).distinct()) {
            // prefer the same kind (movie / series); the name index itself does not know the kind
            pack.rawQuery(
                "SELECT a.pid FROM aliases a JOIN titles t ON t.pid = a.pid WHERE a.norm = ? AND a.year = ? ORDER BY (t.type = ?) DESC LIMIT 1",
                arrayOf(norm, year.toString(), type)
            ).use {
                if (it.moveToFirst()) return it.getLong(0)
            }
            if (item.year <= 0) break
        }
        return null
    }

    private fun markDone(wdb: SQLiteDatabase, dedupKey: String) {
        wdb.execSQL("UPDATE media_items SET is_enriched = 1 WHERE dedup_key = ?", arrayOf(dedupKey))
    }

    private fun applyOne(pack: SQLiteDatabase, wdb: SQLiteDatabase, item: MediaItem, pid: Long): Boolean {
        pack.rawQuery(
            """SELECT tmdb_id, imdb_id, year, plot, genres, runtime, cast_text, director, rating, rating_votes, rating_source,
                      sort_score, certification, kids_ok, poster_path, backdrop_path, poster_off, poster_len
               FROM titles WHERE pid = ?""",
            arrayOf(pid.toString())
        ).use { c ->
            if (!c.moveToFirst()) return false
            val genres = listToApp(c.getString(4))
            val cast = listToApp(c.getString(6))
            val plot = c.getString(3) ?: ""
            val director = c.getString(7) ?: ""
            val year = c.getInt(2)
            val cv = ContentValues().apply {
                if (c.getInt(0) > 0) put("tmdb_id", c.getInt(0))
                val imdb = c.getString(1) ?: ""
                if (imdb.isNotBlank()) put("imdb_id", imdb)
                if (year > 1900) put("year", year)
                if (plot.isNotBlank()) put("plot", plot)
                if (genres.isNotBlank()) put("genres_text", genres)
                if (c.getInt(5) > 0) put("runtime_mins", c.getInt(5))
                if (cast.isNotBlank()) put("cast_text", cast)
                if (director.isNotBlank()) put("director", director)
                put("rating", c.getDouble(8))                 // raw rating shown on screen
                put("vote_count", c.getInt(9))
                put("rating_source", c.getString(10) ?: "")   // "I" (IMDb) or "T" (TMDB) or ""
                put("sort_score", c.getDouble(11))            // weighted score used for "Highest Rated"
                put("certification", (c.getString(12) ?: "").trim().uppercase(Locale.ROOT))
                put("kids_ok", c.getInt(13))
                if (!c.isNull(16) && !c.isNull(17) && c.getInt(17) > 0) put("poster_url", posterUrl(c.getLong(16), c.getInt(17)))
                val bd = backdropUrl(c.getString(15))
                if (bd.isNotBlank()) put("backdrop_url", bd)
                put("is_enriched", 1)
                put("pack_applied", 1)
                // search text: title, cast, director, genres (word-start matching; plot is not searched)
                put("search_blob", buildSearchBlob(item.cleanTitle, item.rawTitle, cast.replace('|', ' '), director, genres.replace('|', ' ')))
            }
            wdb.update("media_items", cv, "dedup_key = ?", arrayOf(item.dedupKey))
            return true
        }
    }
}
