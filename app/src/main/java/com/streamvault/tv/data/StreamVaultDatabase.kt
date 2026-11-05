package com.streamvault.tv.data

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

class StreamVaultDatabase(context: Context) :
    SQLiteOpenHelper(context, DB_NAME, null, DB_VERSION) {

    companion object {
        private const val DB_NAME = "streamvault_tv.db"
        private const val DB_VERSION = 2

        @Volatile
        private var INSTANCE: StreamVaultDatabase? = null

        fun getInstance(context: Context): StreamVaultDatabase {
            return INSTANCE ?: synchronized(this) {
                INSTANCE ?: StreamVaultDatabase(context.applicationContext).also { INSTANCE = it }
            }
        }
    }

    override fun onConfigure(db: SQLiteDatabase) {
        super.onConfigure(db)
        db.enableWriteAheadLogging()
    }

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS media_items (
                dedup_key TEXT PRIMARY KEY,
                primary_stream_id TEXT NOT NULL,
                tmdb_id INTEGER DEFAULT 0,
                imdb_id TEXT DEFAULT '',
                media_type TEXT NOT NULL,
                clean_title TEXT NOT NULL,
                raw_title TEXT NOT NULL,
                year INTEGER DEFAULT 0,
                rating REAL DEFAULT 0.0,
                vote_count INTEGER DEFAULT 0,
                genres_text TEXT DEFAULT '',
                plot TEXT DEFAULT '',
                cast_text TEXT DEFAULT '',
                director TEXT DEFAULT '',
                runtime_mins INTEGER DEFAULT 0,
                poster_url TEXT DEFAULT '',
                backdrop_url TEXT DEFAULT '',
                language TEXT DEFAULT 'English',
                quality_badges TEXT DEFAULT '',
                has_embedded_subtitles INTEGER DEFAULT 0,
                embedded_sub_langs TEXT DEFAULT '',
                has_online_subtitles INTEGER DEFAULT 1,
                embedded_audio_langs TEXT DEFAULT '',
                category_id TEXT DEFAULT '',
                category_name TEXT DEFAULT '',
                added_timestamp INTEGER DEFAULT 0,
                is_enriched INTEGER DEFAULT 0,
                is_newly_added INTEGER DEFAULT 0,
                in_watchlist INTEGER DEFAULT 0,
                is_watched INTEGER DEFAULT 0,
                resume_position_ms INTEGER DEFAULT 0,
                duration_ms INTEGER DEFAULT 0,
                versions_json TEXT DEFAULT '[]',
                search_blob TEXT DEFAULT ''
            )
            """.trimIndent()
        )

        db.execSQL("CREATE INDEX IF NOT EXISTS idx_media_type ON media_items(media_type)")
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_media_year ON media_items(year DESC)")
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_media_rating ON media_items(rating DESC)")
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_media_added ON media_items(added_timestamp DESC)")
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_media_enriched ON media_items(is_enriched, rating DESC)")
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_media_lang ON media_items(language)")

        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS series_episodes (
                episode_id TEXT PRIMARY KEY,
                series_id TEXT NOT NULL,
                season_num INTEGER DEFAULT 1,
                episode_num INTEGER DEFAULT 1,
                title TEXT NOT NULL,
                plot TEXT DEFAULT '',
                duration_secs INTEGER DEFAULT 0,
                container_ext TEXT DEFAULT 'mp4',
                thumbnail_url TEXT DEFAULT '',
                added_timestamp INTEGER DEFAULT 0,
                resume_position_ms INTEGER DEFAULT 0,
                is_watched INTEGER DEFAULT 0
            )
            """.trimIndent()
        )
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_ep_series ON series_episodes(series_id, season_num, episode_num)")

        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS live_channels (
                stream_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                logo_url TEXT DEFAULT '',
                category_id TEXT DEFAULT '',
                category_name TEXT DEFAULT 'General',
                epg_channel_id TEXT DEFAULT '',
                current_program TEXT DEFAULT '',
                current_program_time TEXT DEFAULT '',
                next_program TEXT DEFAULT '',
                is_favorite INTEGER DEFAULT 0
            )
            """.trimIndent()
        )
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_live_cat ON live_channels(category_name)")

        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS pinned_smart_rows (
                row_id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                filter_json TEXT NOT NULL,
                created_at INTEGER DEFAULT 0
            )
            """.trimIndent()
        )

        seedDefaultSmartRows(db)
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        onCreate(db)
    }

    private fun seedDefaultSmartRows(db: SQLiteDatabase) {
        val defaults = listOf(
            PinnedSmartRow(
                id = "smart_scifi_thriller_no_horror",
                title = "Top Sci-Fi & Thrillers (No Horror, 7.0+)",
                filterState = SuperFilterState(
                    includedGenres = setOf("Sci-Fi", "Thriller"),
                    excludedGenres = setOf("Horror"),
                    matchAllIncludedGenres = false,
                    minRating = 7.0,
                    sortBy = SortOption.RATING_DESC
                )
            ),
            PinnedSmartRow(
                id = "smart_recent_action_2020",
                title = "2020s Action & Adventure Hits",
                filterState = SuperFilterState(
                    includedGenres = setOf("Action", "Adventure"),
                    matchAllIncludedGenres = false,
                    minYear = 2020,
                    minRating = 6.5,
                    sortBy = SortOption.RELEASE_YEAR_DESC
                )
            ),
            PinnedSmartRow(
                id = "smart_90s_2000s_classics",
                title = "90s & 2000s Critically Acclaimed (7.5+)",
                filterState = SuperFilterState(
                    minYear = 1990,
                    maxYear = 2009,
                    minRating = 7.5,
                    sortBy = SortOption.RATING_DESC
                )
            )
        )
        for ((idx, row) in defaults.withIndex()) {
            val cv = ContentValues().apply {
                put("row_id", row.id)
                put("title", row.title)
                put("filter_json", row.filterState.toJson().toString())
                put("created_at", System.currentTimeMillis() + idx)
            }
            db.insertWithOnConflict("pinned_smart_rows", null, cv, SQLiteDatabase.CONFLICT_IGNORE)
        }
    }

    fun upsertMediaBatch(items: List<MediaItem>, markNewIfInserted: Boolean): Int {
        if (items.isEmpty()) return 0
        val db = writableDatabase
        var newlyAdded = 0
        db.beginTransactionNonExclusive()
        try {
            for (item in items) {
                val existingCursor = db.rawQuery(
                    """
                    SELECT is_enriched, genres_text, plot, cast_text, director, runtime_mins,
                           backdrop_url, imdb_id, in_watchlist, is_watched, resume_position_ms,
                           duration_ms, has_embedded_subtitles, embedded_sub_langs, embedded_audio_langs
                    FROM media_items WHERE dedup_key = ?
                    """.trimIndent(),
                    arrayOf(item.dedupKey)
                )

                val exists = existingCursor.moveToFirst()
                val keepEnriched = if (exists) existingCursor.getInt(0) == 1 else false
                val existingGenres = if (exists) existingCursor.getString(1) ?: "" else ""
                val existingPlot = if (exists) existingCursor.getString(2) ?: "" else ""
                val existingCast = if (exists) existingCursor.getString(3) ?: "" else ""
                val existingDirector = if (exists) existingCursor.getString(4) ?: "" else ""
                val existingRuntime = if (exists) existingCursor.getInt(5) else 0
                val existingBackdrop = if (exists) existingCursor.getString(6) ?: "" else ""
                val existingImdb = if (exists) existingCursor.getString(7) ?: "" else ""
                val inWatchlist = if (exists) existingCursor.getInt(8) == 1 else item.inWatchlist
                val isWatched = if (exists) existingCursor.getInt(9) == 1 else item.isWatched
                val resumePos = if (exists) existingCursor.getLong(10) else item.resumePositionMs
                val durationMs = if (exists) existingCursor.getLong(11) else item.durationMs
                val hasEmbSub = if (exists && existingCursor.getInt(12) == 1) true else item.hasEmbeddedSubtitles
                val embSubLangs = if (exists && !existingCursor.getString(13).isNullOrBlank()) {
                    existingCursor.getString(13)
                } else item.embeddedSubtitleLanguages.joinToString("|")
                val embAudioLangs = if (exists && !existingCursor.getString(14).isNullOrBlank()) {
                    existingCursor.getString(14)
                } else item.embeddedAudioLanguages.joinToString("|")
                existingCursor.close()

                if (!exists && markNewIfInserted) {
                    newlyAdded++
                }

                val finalGenres = if (keepEnriched && existingGenres.isNotBlank()) {
                    existingGenres
                } else {
                    item.genres.distinct().joinToString("|")
                }
                val finalPlot = if (keepEnriched && existingPlot.isNotBlank()) existingPlot else item.plot
                val finalCast = if (keepEnriched && existingCast.isNotBlank()) existingCast else item.cast.joinToString("|")
                val finalDirector = if (keepEnriched && existingDirector.isNotBlank()) existingDirector else item.director
                val finalRuntime = if (keepEnriched && existingRuntime > 0) existingRuntime else item.runtimeMins
                val finalBackdrop = if (keepEnriched && existingBackdrop.isNotBlank()) existingBackdrop else item.backdropUrl
                val finalImdb = if (keepEnriched && existingImdb.isNotBlank()) existingImdb else item.imdbId

                val versionsJson = JSONArray().apply {
                    item.versions.forEach { put(it.toJson()) }
                }.toString()

                val searchBlob = buildString {
                    append(item.cleanTitle.lowercase(Locale.ROOT)).append(' ')
                    append(item.rawTitle.lowercase(Locale.ROOT)).append(' ')
                    append(finalPlot.lowercase(Locale.ROOT)).append(' ')
                    append(finalCast.lowercase(Locale.ROOT)).append(' ')
                    append(finalDirector.lowercase(Locale.ROOT)).append(' ')
                    append(finalGenres.lowercase(Locale.ROOT)).append(' ')
                    append(item.categoryName.lowercase(Locale.ROOT))
                }

                val cv = ContentValues().apply {
                    put("dedup_key", item.dedupKey)
                    put("primary_stream_id", item.primaryStreamId)
                    put("tmdb_id", item.tmdbId)
                    put("imdb_id", finalImdb)
                    put("media_type", item.mediaType.name)
                    put("clean_title", item.cleanTitle)
                    put("raw_title", item.rawTitle)
                    put("year", item.year)
                    put("rating", item.rating)
                    put("vote_count", item.voteCount)
                    put("genres_text", finalGenres)
                    put("plot", finalPlot)
                    put("cast_text", finalCast)
                    put("director", finalDirector)
                    put("runtime_mins", finalRuntime)
                    put("poster_url", item.posterUrl)
                    put("backdrop_url", finalBackdrop)
                    put("language", item.language)
                    put("quality_badges", item.qualityBadges.distinct().joinToString("|"))
                    put("has_embedded_subtitles", if (hasEmbSub) 1 else 0)
                    put("embedded_sub_langs", embSubLangs)
                    put("has_online_subtitles", if (item.hasOnlineSubtitles) 1 else 0)
                    put("embedded_audio_langs", embAudioLangs)
                    put("category_id", item.categoryId)
                    put("category_name", item.categoryName)
                    put("added_timestamp", item.addedTimestamp)
                    put("is_enriched", if (keepEnriched || item.isEnriched) 1 else 0)
                    put("is_newly_added", if (!exists && markNewIfInserted) 1 else 0)
                    put("in_watchlist", if (inWatchlist) 1 else 0)
                    put("is_watched", if (isWatched) 1 else 0)
                    put("resume_position_ms", resumePos)
                    put("duration_ms", durationMs)
                    put("versions_json", versionsJson)
                    put("search_blob", searchBlob)
                }

                db.insertWithOnConflict("media_items", null, cv, SQLiteDatabase.CONFLICT_REPLACE)
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        return newlyAdded
    }

    fun updateEnrichedMetadata(
        dedupKey: String, tmdbId: Int, imdbId: String, year: Int, rating: Double, voteCount: Int,
        genres: List<String>, plot: String, cast: List<String>, director: String, runtimeMins: Int,
        posterUrl: String, backdropUrl: String, language: String, hasEmbeddedSubs: Boolean,
        embeddedSubLangs: List<String>, embeddedAudioLangs: List<String>
    ) {
        val db = writableDatabase
        val cursor = db.rawQuery(
            "SELECT clean_title, raw_title, category_name, genres_text, poster_url, year, rating, language FROM media_items WHERE dedup_key = ?",
            arrayOf(dedupKey)
        )
        if (!cursor.moveToFirst()) {
            cursor.close()
            return
        }
        val cleanTitle = cursor.getString(0) ?: ""
        val rawTitle = cursor.getString(1) ?: ""
        val catName = cursor.getString(2) ?: ""
        val oldGenres = (cursor.getString(3) ?: "").split("|").filter { it.isNotBlank() }
        val oldPoster = cursor.getString(4) ?: ""
        val oldYear = cursor.getInt(5)
        val oldRating = cursor.getDouble(6)
        val oldLang = cursor.getString(7) ?: "English"
        cursor.close()

        val mergedGenres = (genres + oldGenres).map { it.trim() }.filter { it.isNotBlank() }.distinct()
        val finalYear = if (year > 1900) year else oldYear
        val finalRating = if (rating > 0.0) rating else oldRating
        val finalPoster = if (posterUrl.isNotBlank()) posterUrl else oldPoster
        val finalLang = if (language.isNotBlank() && oldLang == "English") language else oldLang

        val searchBlob = buildString {
            append(cleanTitle.lowercase(Locale.ROOT)).append(' ')
            append(rawTitle.lowercase(Locale.ROOT)).append(' ')
            append(plot.lowercase(Locale.ROOT)).append(' ')
            append(cast.joinToString(" ").lowercase(Locale.ROOT)).append(' ')
            append(director.lowercase(Locale.ROOT)).append(' ')
            append(mergedGenres.joinToString(" ").lowercase(Locale.ROOT)).append(' ')
            append(catName.lowercase(Locale.ROOT))
        }

        val cv = ContentValues().apply {
            if (tmdbId > 0) put("tmdb_id", tmdbId)
            if (imdbId.isNotBlank()) put("imdb_id", imdbId)
            put("year", finalYear)
            put("rating", finalRating)
            put("vote_count", voteCount)
            put("genres_text", mergedGenres.joinToString("|"))
            put("plot", plot)
            put("cast_text", cast.joinToString("|"))
            put("director", director)
            put("runtime_mins", runtimeMins)
            put("poster_url", finalPoster)
            if (backdropUrl.isNotBlank()) put("backdrop_url", backdropUrl)
            put("language", finalLang)
            if (hasEmbeddedSubs) put("has_embedded_subtitles", 1)
            if (embeddedSubLangs.isNotEmpty()) put("embedded_sub_langs", embeddedSubLangs.distinct().joinToString("|"))
            if (embeddedAudioLangs.isNotEmpty()) put("embedded_audio_langs", embeddedAudioLangs.distinct().joinToString("|"))
            put("is_enriched", 1)
            put("search_blob", searchBlob)
        }
        db.update("media_items", cv, "dedup_key = ?", arrayOf(dedupKey))
    }

    fun getUnenrichedMediaQueue(preferredLanguages: Set<String>, limit: Int = 500): List<MediaItem> {
        val db = readableDatabase
        val cursor = db.rawQuery(
            "SELECT * FROM media_items WHERE is_enriched = 0 ORDER BY year DESC, rating DESC, added_timestamp DESC LIMIT ?",
            arrayOf(limit.toString())
        )
        val all = readMediaList(cursor)
        return all.sortedByDescending { item ->
            val langScore = if (preferredLanguages.contains(item.language)) 10000 else 0
            langScore + item.year
        }
    }

    fun getEnrichmentCounts(): Pair<Int, Int> {
        val db = readableDatabase
        var total = 0
        var enriched = 0
        db.rawQuery("SELECT COUNT(*), SUM(CASE WHEN is_enriched = 1 THEN 1 ELSE 0 END) FROM media_items", null).use { c ->
            if (c.moveToFirst()) {
                total = c.getInt(0)
                enriched = c.getInt(1)
            }
        }
        return Pair(enriched, total)
    }

    fun queryMedia(filter: SuperFilterState, hiddenLanguages: Set<String> = emptySet(), limit: Int = 180): List<MediaItem> {
        val db = readableDatabase
        val whereClauses = mutableListOf<String>()
        val args = mutableListOf<String>()

        if (filter.mediaTypeFilter != null) {
            whereClauses.add("media_type = ?")
            args.add(filter.mediaTypeFilter.name)
        }
        for (hiddenLang in hiddenLanguages) {
            whereClauses.add("language != ?")
            args.add(hiddenLang)
        }
        if (filter.selectedLanguages.isNotEmpty()) {
            val placeholders = filter.selectedLanguages.joinToString(",") { "?" }
            whereClauses.add("language IN ($placeholders)")
            args.addAll(filter.selectedLanguages)
        }
        if (filter.searchQuery.isNotBlank()) {
            val tokens = filter.searchQuery.trim().lowercase(Locale.ROOT).split(Regex("""\s+"""))
            for (token in tokens) {
                whereClauses.add("search_blob LIKE ?")
                args.add("%$token%")
            }
        }
        if (filter.includedGenres.isNotEmpty()) {
            if (filter.matchAllIncludedGenres) {
                for (genre in filter.includedGenres) {
                    whereClauses.add("('|' || genres_text || '|' LIKE ?)")
                    args.add("%|$genre|%")
                }
            } else {
                val orParts = filter.includedGenres.map { "('|' || genres_text || '|' LIKE ?)" }
                whereClauses.add("(" + orParts.joinToString(" OR ") + ")")
                filter.includedGenres.forEach { args.add("%|$it|%") }
            }
        }
        for (excluded in filter.excludedGenres) {
            whereClauses.add("('|' || genres_text || '|' NOT LIKE ?)")
            args.add("%|$excluded|%")
        }
        when (filter.subtitleFilterMode) {
            SubtitleFilterMode.ANY -> {}
            SubtitleFilterMode.ANY_SUBTITLES -> whereClauses.add("(has_embedded_subtitles = 1 OR has_online_subtitles = 1 OR tmdb_id > 0)")
            SubtitleFilterMode.EMBEDDED_ONLY -> whereClauses.add("has_embedded_subtitles = 1")
            SubtitleFilterMode.ONLINE_AVAILABLE -> whereClauses.add("(has_online_subtitles = 1 OR tmdb_id > 0)")
            SubtitleFilterMode.SPECIFIC_LANGUAGE -> {
                whereClauses.add("(embedded_sub_langs LIKE ? OR has_online_subtitles = 1)")
                args.add("%${filter.specificSubtitleLanguage}%")
            }
        }
        if (filter.decade != null) {
            whereClauses.add("year BETWEEN ? AND ?")
            args.add(filter.decade.toString())
            args.add((filter.decade + 9).toString())
        } else {
            if (filter.minYear != null) { whereClauses.add("year >= ?"); args.add(filter.minYear.toString()) }
            if (filter.maxYear != null) { whereClauses.add("year <= ?"); args.add(filter.maxYear.toString()) }
        }
        if (filter.minRating > 0.0) { whereClauses.add("rating >= ?"); args.add(filter.minRating.toString()) }
        if (!filter.qualityFilter.isNullOrBlank()) {
            whereClauses.add("(quality_badges LIKE ? OR versions_json LIKE ?)")
            args.add("%${filter.qualityFilter}%"); args.add("%${filter.qualityFilter}%")
        }
        if (filter.hideWatched) whereClauses.add("is_watched = 0")
        if (!filter.serverCategoryId.isNullOrBlank()) { whereClauses.add("category_id = ?"); args.add(filter.serverCategoryId) }
        if (!filter.actorFilter.isNullOrBlank()) { whereClauses.add("cast_text LIKE ?"); args.add("%${filter.actorFilter}%") }
        if (!filter.directorFilter.isNullOrBlank()) { whereClauses.add("director LIKE ?"); args.add("%${filter.directorFilter}%") }

        val whereSql = if (whereClauses.isEmpty()) "" else "WHERE " + whereClauses.joinToString(" AND ")
        val orderSql = when (filter.sortBy) {
            SortOption.NEWLY_ADDED -> "ORDER BY added_timestamp DESC, year DESC"
            SortOption.RELEASE_YEAR_DESC -> "ORDER BY year DESC, rating DESC"
            SortOption.RATING_DESC -> "ORDER BY rating DESC, vote_count DESC"
            SortOption.TITLE_ASC -> "ORDER BY clean_title COLLATE NOCASE ASC"
            SortOption.RANDOM -> "ORDER BY RANDOM()"
        }
        val cursor = db.rawQuery("SELECT * FROM media_items $whereSql $orderSql LIMIT $limit", args.toTypedArray())
        return readMediaList(cursor)
    }

    fun getAutocompleteSuggestions(prefix: String, limit: Int = 10): List<String> {
        val clean = prefix.trim()
        if (clean.length < 2) return emptyList()
        val db = readableDatabase
        val suggestions = LinkedHashSet<String>()
        db.rawQuery(
            "SELECT clean_title FROM media_items WHERE clean_title LIKE ? OR clean_title LIKE ? ORDER BY CASE WHEN clean_title LIKE ? THEN 0 ELSE 1 END, rating DESC LIMIT ?",
            arrayOf("$clean%", "% $clean%", "$clean%", limit.toString())
        ).use { c -> while (c.moveToNext()) suggestions.add(c.getString(0)) }
        if (suggestions.size < limit) {
            db.rawQuery(
                "SELECT cast_text, director FROM media_items WHERE cast_text LIKE ? OR director LIKE ? LIMIT 25",
                arrayOf("%$clean%", "%$clean%")
            ).use { c ->
                val lower = clean.lowercase(Locale.ROOT)
                while (c.moveToNext() && suggestions.size < limit) {
                    val cast = (c.getString(0) ?: "").split("|")
                    val dir = c.getString(1) ?: ""
                    for (person in cast + listOf(dir)) {
                        if (person.lowercase(Locale.ROOT).contains(lower) && person.isNotBlank()) {
                            suggestions.add(person.trim())
                            if (suggestions.size >= limit) break
                        }
                    }
                }
            }
        }
        return suggestions.toList()
    }

    fun getMoreLikeThis(item: MediaItem, limit: Int = 12): List<MediaItem> {
        if (item.genres.isEmpty() && item.director.isBlank()) return emptyList()
        val db = readableDatabase
        val primaryGenre = item.genres.firstOrNull() ?: ""
        val cursor = db.rawQuery(
            "SELECT * FROM media_items WHERE dedup_key != ? AND (genres_text LIKE ? OR (director != '' AND director = ?)) ORDER BY rating DESC, year DESC LIMIT ?",
            arrayOf(item.dedupKey, "%$primaryGenre%", item.director, (limit * 2).toString())
        )
        return readMediaList(cursor).sortedByDescending { cand ->
            val sharedGenres = cand.genres.intersect(item.genres.toSet()).size * 3
            val sameDir = if (item.director.isNotBlank() && cand.director == item.director) 5 else 0
            val sharedCast = cand.cast.intersect(item.cast.toSet()).size * 2
            (sharedGenres + sameDir + sharedCast) * 10 + cand.rating.toInt()
        }.take(limit)
    }

    fun getAllDistinctGenres(): List<String> {
        val db = readableDatabase
        val genres = mutableSetOf("Action", "Adventure", "Animation", "Comedy", "Crime", "Documentary", "Drama", "Family", "Fantasy", "History", "Horror", "Mystery", "Romance", "Sci-Fi", "Thriller", "War", "Western")
        db.rawQuery("SELECT DISTINCT genres_text FROM media_items WHERE genres_text != '' LIMIT 1000", null).use { c ->
            while (c.moveToNext()) c.getString(0)?.split("|")?.forEach { g -> if (g.isNotBlank()) genres.add(g.trim()) }
        }
        return genres.sorted()
    }

    fun getAllDistinctLanguages(): List<String> {
        val db = readableDatabase
        val langs = linkedSetOf("English", "Hindi", "Urdu", "Multi-Audio", "Arabic", "Korean", "Turkish", "Spanish", "French", "Japanese")
        db.rawQuery("SELECT DISTINCT language FROM media_items WHERE language != ''", null).use { c ->
            while (c.moveToNext()) c.getString(0)?.takeIf { it.isNotBlank() }?.let { langs.add(it) }
        }
        return langs.toList()
    }

    fun getContinueWatchingList(limit: Int = 20): List<MediaItem> =
        readMediaList(readableDatabase.rawQuery("SELECT * FROM media_items WHERE resume_position_ms > 15000 AND is_watched = 0 ORDER BY added_timestamp DESC LIMIT ?", arrayOf(limit.toString())))

    fun getWatchlist(): List<MediaItem> =
        readMediaList(readableDatabase.rawQuery("SELECT * FROM media_items WHERE in_watchlist = 1 ORDER BY clean_title ASC", null))

    fun toggleWatchlist(dedupKey: String): Boolean {
        val db = writableDatabase
        var newState = false
        db.rawQuery("SELECT in_watchlist FROM media_items WHERE dedup_key = ?", arrayOf(dedupKey)).use { c -> if (c.moveToFirst()) newState = c.getInt(0) == 0 }
        db.update("media_items", ContentValues().apply { put("in_watchlist", if (newState) 1 else 0) }, "dedup_key = ?", arrayOf(dedupKey))
        return newState
    }

    fun toggleWatched(dedupKey: String): Boolean {
        val db = writableDatabase
        var newState = false
        db.rawQuery("SELECT is_watched FROM media_items WHERE dedup_key = ?", arrayOf(dedupKey)).use { c -> if (c.moveToFirst()) newState = c.getInt(0) == 0 }
        db.update("media_items", ContentValues().apply { put("is_watched", if (newState) 1 else 0); if (newState) put("resume_position_ms", 0L) }, "dedup_key = ?", arrayOf(dedupKey))
        return newState
    }

    fun savePlaybackProgress(dedupKey: String, positionMs: Long, durationMs: Long) {
        val finished = durationMs > 60_000L && positionMs.toDouble() / durationMs.toDouble() >= 0.92
        writableDatabase.update("media_items", ContentValues().apply {
            put("resume_position_ms", if (finished) 0L else positionMs)
            put("duration_ms", durationMs)
            if (finished) put("is_watched", 1)
        }, "dedup_key = ?", arrayOf(dedupKey))
    }

    fun recordDiscoveredStreamTracks(dedupKey: String, subtitleLangs: List<String>, audioLangs: List<String>) {
        val cv = ContentValues().apply {
            if (subtitleLangs.isNotEmpty()) { put("has_embedded_subtitles", 1); put("embedded_sub_langs", subtitleLangs.distinct().joinToString("|")) }
            if (audioLangs.isNotEmpty()) put("embedded_audio_langs", audioLangs.distinct().joinToString("|"))
        }
        if (cv.size() > 0) writableDatabase.update("media_items", cv, "dedup_key = ?", arrayOf(dedupKey))
    }

    fun saveSeriesEpisodes(seriesId: String, episodes: List<SeriesEpisode>) {
        val db = writableDatabase
        db.beginTransactionNonExclusive()
        try {
            for (ep in episodes) {
                var resumePos = ep.resumePositionMs; var watched = ep.isWatched
                db.rawQuery("SELECT resume_position_ms, is_watched FROM series_episodes WHERE episode_id = ?", arrayOf(ep.episodeId)).use { c ->
                    if (c.moveToFirst()) { resumePos = c.getLong(0); watched = c.getInt(1) == 1 }
                }
                db.insertWithOnConflict("series_episodes", null, ContentValues().apply {
                    put("episode_id", ep.episodeId); put("series_id", seriesId); put("season_num", ep.seasonNumber)
                    put("episode_num", ep.episodeNumber); put("title", ep.title); put("plot", ep.plot)
                    put("duration_secs", ep.durationSecs); put("container_ext", ep.containerExtension)
                    put("thumbnail_url", ep.thumbnailUrl); put("added_timestamp", ep.addedTimestamp)
                    put("resume_position_ms", resumePos); put("is_watched", if (watched) 1 else 0)
                }, SQLiteDatabase.CONFLICT_REPLACE)
            }
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }

    fun getSeriesEpisodes(seriesId: String): List<SeriesEpisode> {
        val list = mutableListOf<SeriesEpisode>()
        readableDatabase.rawQuery("SELECT * FROM series_episodes WHERE series_id = ? ORDER BY season_num ASC, episode_num ASC", arrayOf(seriesId)).use { c ->
            while (c.moveToNext()) {
                list.add(SeriesEpisode(
                    episodeId = c.getString(c.getColumnIndexOrThrow("episode_id")), seriesId = c.getString(c.getColumnIndexOrThrow("series_id")),
                    seasonNumber = c.getInt(c.getColumnIndexOrThrow("season_num")), episodeNumber = c.getInt(c.getColumnIndexOrThrow("episode_num")),
                    title = c.getString(c.getColumnIndexOrThrow("title")), plot = c.getString(c.getColumnIndexOrThrow("plot")) ?: "",
                    durationSecs = c.getInt(c.getColumnIndexOrThrow("duration_secs")), containerExtension = c.getString(c.getColumnIndexOrThrow("container_ext")) ?: "mp4",
                    thumbnailUrl = c.getString(c.getColumnIndexOrThrow("thumbnail_url")) ?: "", addedTimestamp = c.getLong(c.getColumnIndexOrThrow("added_timestamp")),
                    resumePositionMs = c.getLong(c.getColumnIndexOrThrow("resume_position_ms")), isWatched = c.getInt(c.getColumnIndexOrThrow("is_watched")) == 1
                ))
            }
        }
        return list
    }

    fun saveEpisodeProgress(episodeId: String, positionMs: Long, durationMs: Long) {
        val finished = durationMs > 60_000L && positionMs.toDouble() / durationMs.toDouble() >= 0.90
        writableDatabase.update("series_episodes", ContentValues().apply {
            put("resume_position_ms", if (finished) 0L else positionMs); if (finished) put("is_watched", 1)
        }, "episode_id = ?", arrayOf(episodeId))
    }

    fun upsertLiveChannels(channels: List<LiveChannel>) {
        if (channels.isEmpty()) return
        val db = writableDatabase
        db.beginTransactionNonExclusive()
        try {
            for (ch in channels) {
                var fav = ch.isFavorite
                db.rawQuery("SELECT is_favorite FROM live_channels WHERE stream_id = ?", arrayOf(ch.streamId)).use { c -> if (c.moveToFirst()) fav = c.getInt(0) == 1 }
                db.insertWithOnConflict("live_channels", null, ContentValues().apply {
                    put("stream_id", ch.streamId); put("name", ch.name); put("logo_url", ch.logoUrl)
                    put("category_id", ch.categoryId); put("category_name", ch.categoryName); put("epg_channel_id", ch.epgChannelId)
                    put("current_program", ch.currentProgramTitle); put("current_program_time", ch.currentProgramTime)
                    put("next_program", ch.nextProgramTitle); put("is_favorite", if (fav) 1 else 0)
                }, SQLiteDatabase.CONFLICT_REPLACE)
            }
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }

    fun getLiveChannels(categoryName: String? = null, searchQuery: String = ""): List<LiveChannel> {
        val clauses = mutableListOf<String>(); val args = mutableListOf<String>()
        if (categoryName == "★ Favorites") clauses.add("is_favorite = 1")
        else if (!categoryName.isNullOrBlank() && categoryName != "All Channels") { clauses.add("category_name = ?"); args.add(categoryName) }
        if (searchQuery.isNotBlank()) { clauses.add("name LIKE ?"); args.add("%$searchQuery%") }
        val where = if (clauses.isEmpty()) "" else "WHERE " + clauses.joinToString(" AND ")
        val list = mutableListOf<LiveChannel>()
        readableDatabase.rawQuery("SELECT * FROM live_channels $where ORDER BY is_favorite DESC, name ASC LIMIT 500", args.toTypedArray()).use { c ->
            while (c.moveToNext()) {
                list.add(LiveChannel(
                    streamId = c.getString(c.getColumnIndexOrThrow("stream_id")), name = c.getString(c.getColumnIndexOrThrow("name")),
                    logoUrl = c.getString(c.getColumnIndexOrThrow("logo_url")) ?: "", categoryId = c.getString(c.getColumnIndexOrThrow("category_id")) ?: "",
                    categoryName = c.getString(c.getColumnIndexOrThrow("category_name")) ?: "General", epgChannelId = c.getString(c.getColumnIndexOrThrow("epg_channel_id")) ?: "",
                    currentProgramTitle = c.getString(c.getColumnIndexOrThrow("current_program")) ?: "", currentProgramTime = c.getString(c.getColumnIndexOrThrow("current_program_time")) ?: "",
                    nextProgramTitle = c.getString(c.getColumnIndexOrThrow("next_program")) ?: "", isFavorite = c.getInt(c.getColumnIndexOrThrow("is_favorite")) == 1
                ))
            }
        }
        return list
    }

    fun getLiveCategories(): List<String> {
        val cats = mutableListOf("All Channels", "★ Favorites")
        readableDatabase.rawQuery("SELECT DISTINCT category_name FROM live_channels WHERE category_name != '' ORDER BY category_name ASC", null).use { c ->
            while (c.moveToNext()) c.getString(0)?.takeIf { it.isNotBlank() }?.let { cats.add(it) }
        }
        return cats
    }

    fun toggleFavoriteChannel(streamId: String): Boolean {
        val db = writableDatabase; var fav = false
        db.rawQuery("SELECT is_favorite FROM live_channels WHERE stream_id = ?", arrayOf(streamId)).use { c -> if (c.moveToFirst()) fav = c.getInt(0) == 0 }
        db.update("live_channels", ContentValues().apply { put("is_favorite", if (fav) 1 else 0) }, "stream_id = ?", arrayOf(streamId))
        return fav
    }

    fun getPinnedSmartRows(): List<PinnedSmartRow> {
        val rows = mutableListOf<PinnedSmartRow>()
        readableDatabase.rawQuery("SELECT * FROM pinned_smart_rows ORDER BY created_at ASC", null).use { c ->
            while (c.moveToNext()) {
                val id = c.getString(c.getColumnIndexOrThrow("row_id"))
                val title = c.getString(c.getColumnIndexOrThrow("title"))
                val jsonStr = c.getString(c.getColumnIndexOrThrow("filter_json"))
                val filter = runCatching { SuperFilterState.fromJson(JSONObject(jsonStr)) }.getOrDefault(SuperFilterState())
                rows.add(PinnedSmartRow(id, title, filter))
            }
        }
        return rows
    }

    fun savePinnedSmartRow(title: String, filterState: SuperFilterState): PinnedSmartRow {
        val id = "smart_${System.currentTimeMillis()}"
        writableDatabase.insertWithOnConflict("pinned_smart_rows", null, ContentValues().apply {
            put("row_id", id); put("title", title); put("filter_json", filterState.toJson().toString()); put("created_at", System.currentTimeMillis())
        }, SQLiteDatabase.CONFLICT_REPLACE)
        return PinnedSmartRow(id, title, filterState)
    }

    fun deletePinnedSmartRow(rowId: String) {
        writableDatabase.delete("pinned_smart_rows", "row_id = ?", arrayOf(rowId))
    }

    fun exportUserDataJson(): String {
        val root = JSONObject(); val watchlistArr = JSONArray(); val watchedArr = JSONArray(); val progressArr = JSONArray()
        readableDatabase.rawQuery("SELECT dedup_key, in_watchlist, is_watched, resume_position_ms, duration_ms FROM media_items WHERE in_watchlist = 1 OR is_watched = 1 OR resume_position_ms > 0", null).use { c ->
            while (c.moveToNext()) {
                val key = c.getString(0)
                if (c.getInt(1) == 1) watchlistArr.put(key)
                if (c.getInt(2) == 1) watchedArr.put(key)
                val pos = c.getLong(3); val dur = c.getLong(4)
                if (pos > 0) progressArr.put(JSONObject().apply { put("key", key); put("pos", pos); put("dur", dur) })
            }
        }
        val smartRowsArr = JSONArray()
        for (row in getPinnedSmartRows()) smartRowsArr.put(JSONObject().apply { put("id", row.id); put("title", row.title); put("filter", row.filterState.toJson()) })
        root.put("watchlist", watchlistArr); root.put("watched", watchedArr); root.put("progress", progressArr); root.put("smartRows", smartRowsArr)
        return root.toString(2)
    }

    fun importUserDataJson(jsonString: String) {
        val root = JSONObject(jsonString); val db = writableDatabase
        db.beginTransactionNonExclusive()
        try {
            root.optJSONArray("watchlist")?.let { arr -> for (i in 0 until arr.length()) db.update("media_items", ContentValues().apply { put("in_watchlist", 1) }, "dedup_key = ?", arrayOf(arr.getString(i))) }
            root.optJSONArray("watched")?.let { arr -> for (i in 0 until arr.length()) db.update("media_items", ContentValues().apply { put("is_watched", 1) }, "dedup_key = ?", arrayOf(arr.getString(i))) }
            root.optJSONArray("progress")?.let { arr ->
                for (i in 0 until arr.length()) {
                    val obj = arr.getJSONObject(i)
                    db.update("media_items", ContentValues().apply { put("resume_position_ms", obj.optLong("pos")); put("duration_ms", obj.optLong("dur")) }, "dedup_key = ?", arrayOf(obj.optString("key")))
                }
            }
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }

    private fun readMediaList(cursor: Cursor): List<MediaItem> {
        val list = mutableListOf<MediaItem>()
        cursor.use { c ->
            while (c.moveToNext()) {
                val genresStr = c.getString(c.getColumnIndexOrThrow("genres_text")) ?: ""
                val castStr = c.getString(c.getColumnIndexOrThrow("cast_text")) ?: ""
                val badgesStr = c.getString(c.getColumnIndexOrThrow("quality_badges")) ?: ""
                val embSubStr = c.getString(c.getColumnIndexOrThrow("embedded_sub_langs")) ?: ""
                val embAudStr = c.getString(c.getColumnIndexOrThrow("embedded_audio_langs")) ?: ""
                val versionsJson = c.getString(c.getColumnIndexOrThrow("versions_json")) ?: "[]"
                val versions = mutableListOf<StreamVersion>()
                runCatching {
                    val arr = JSONArray(versionsJson)
                    for (i in 0 until arr.length()) versions.add(StreamVersion.fromJson(arr.getJSONObject(i)))
                }
                list.add(MediaItem(
                    dedupKey = c.getString(c.getColumnIndexOrThrow("dedup_key")),
                    primaryStreamId = c.getString(c.getColumnIndexOrThrow("primary_stream_id")),
                    tmdbId = c.getInt(c.getColumnIndexOrThrow("tmdb_id")),
                    imdbId = c.getString(c.getColumnIndexOrThrow("imdb_id")) ?: "",
                    mediaType = runCatching { MediaType.valueOf(c.getString(c.getColumnIndexOrThrow("media_type"))) }.getOrDefault(MediaType.MOVIE),
                    cleanTitle = c.getString(c.getColumnIndexOrThrow("clean_title")),
                    rawTitle = c.getString(c.getColumnIndexOrThrow("raw_title")),
                    year = c.getInt(c.getColumnIndexOrThrow("year")),
                    rating = c.getDouble(c.getColumnIndexOrThrow("rating")),
                    voteCount = c.getInt(c.getColumnIndexOrThrow("vote_count")),
                    genres = genresStr.split("|").filter { it.isNotBlank() },
                    plot = c.getString(c.getColumnIndexOrThrow("plot")) ?: "",
                    cast = castStr.split("|").filter { it.isNotBlank() },
                    director = c.getString(c.getColumnIndexOrThrow("director")) ?: "",
                    runtimeMins = c.getInt(c.getColumnIndexOrThrow("runtime_mins")),
                    posterUrl = c.getString(c.getColumnIndexOrThrow("poster_url")) ?: "",
                    backdropUrl = c.getString(c.getColumnIndexOrThrow("backdrop_url")) ?: "",
                    language = c.getString(c.getColumnIndexOrThrow("language")) ?: "English",
                    qualityBadges = badgesStr.split("|").filter { it.isNotBlank() },
                    hasEmbeddedSubtitles = c.getInt(c.getColumnIndexOrThrow("has_embedded_subtitles")) == 1,
                    embeddedSubtitleLanguages = embSubStr.split("|").filter { it.isNotBlank() },
                    hasOnlineSubtitles = c.getInt(c.getColumnIndexOrThrow("has_online_subtitles")) == 1,
                    embeddedAudioLanguages = embAudStr.split("|").filter { it.isNotBlank() },
                    categoryId = c.getString(c.getColumnIndexOrThrow("category_id")) ?: "",
                    categoryName = c.getString(c.getColumnIndexOrThrow("category_name")) ?: "",
                    addedTimestamp = c.getLong(c.getColumnIndexOrThrow("added_timestamp")),
                    isEnriched = c.getInt(c.getColumnIndexOrThrow("is_enriched")) == 1,
                    isNewlyAdded = c.getInt(c.getColumnIndexOrThrow("is_newly_added")) == 1,
                    inWatchlist = c.getInt(c.getColumnIndexOrThrow("in_watchlist")) == 1,
                    isWatched = c.getInt(c.getColumnIndexOrThrow("is_watched")) == 1,
                    resumePositionMs = c.getLong(c.getColumnIndexOrThrow("resume_position_ms")),
                    durationMs = c.getLong(c.getColumnIndexOrThrow("duration_ms")),
                    versions = versions
                ))
            }
        }
        return list
    }
}
