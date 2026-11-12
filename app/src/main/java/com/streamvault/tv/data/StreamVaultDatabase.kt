package com.streamvault.tv.data

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

/**
 * High-speed WAL-enabled SQLite database tailored for TCL 55P635 (Android TV 11).
 * Stores deduplicated Movies & Series, multi-genre tags, cast, director, plot descriptions,
 * subtitle/audio language availability, watch progress, watchlist, and pinned Smart Rows.
 */
class StreamVaultDatabase(context: Context) :
    SQLiteOpenHelper(context, DB_NAME, null, DB_VERSION) {

    companion object {
        private const val DB_NAME = "streamvault_tv.db"
        private const val DB_VERSION = 3

        @Volatile
        private var INSTANCE: StreamVaultDatabase? = null

        fun getInstance(context: Context): StreamVaultDatabase {
            return INSTANCE ?: synchronized(this) {
                INSTANCE ?: StreamVaultDatabase(context.applicationContext).also { INSTANCE = it }
            }
        }

        fun checkIsAdult(cleanTitle: String, rawTitle: String, categoryName: String, genresText: String): Boolean {
            val text = "$cleanTitle $rawTitle $categoryName $genresText".lowercase(Locale.ROOT)
            val tokens = listOf(
                "xxx", "18+", "adult", "porn", "erotic", "nsfw", "redhat", "team skeet",
                "brazzers", "playboy", "hustler", "penthouse", "bangbros", "naughty"
            )
            return tokens.any { text.contains(it) }
        }

        // "Extras": content that is not mainstream movies or shows (naats, dance, stage drama clips,
        // cartoon packs, WWE, song/explainer compilations). Matched on the provider's CATEGORY name only.
        private val EXTRA_CATEGORY_TOKENS = listOf(
            "naat", "islamic", "dance |", "dance mix", "stage drama", "dasi muj", "songs |",
            "explained movies", "motu patlu", "chacha bhatija", "vir: the robot boy", "chhota bheem",
            "tom & jerry", "scooby-doo", "wwe", "24/7 dance", "vibe stage drama", "cartoon kids"
        )

        fun checkIsExtra(categoryName: String): Boolean {
            val c = categoryName.lowercase(Locale.ROOT)
            if (c.isBlank()) return false
            return EXTRA_CATEGORY_TOKENS.any { c.contains(it) }
        }

        /** SQL condition on live_channels.category_name for the three live groups. */
        fun liveGroupClause(group: String): String {
            val adult = "(lower(lc.category_name) LIKE '%xxx%' OR lower(lc.category_name) LIKE '%18+%' OR lower(lc.category_name) LIKE '%adult%' OR lower(lc.category_name) LIKE '%porn%')"
            val extra = "(" + listOf("wwe", "24/7 dance", "vibe stage drama", "stage drama", "islamic").joinToString(" OR ") { "lower(lc.category_name) LIKE '%$it%'" } + ")"
            return when (group) {
                "adult" -> adult
                "extras" -> "($extra AND NOT $adult)"
                else -> "(NOT $adult AND NOT $extra)"
            }
        }
    }

    override fun onConfigure(db: SQLiteDatabase) {
        super.onConfigure(db)
        db.enableWriteAheadLogging()
    }

    override fun onOpen(db: SQLiteDatabase) {
        super.onOpen(db)
        ensureSchemaUpdated(db)
    }

    fun ensureSchemaUpdated(db: SQLiteDatabase) {
        try { db.execSQL("ALTER TABLE media_items ADD COLUMN is_adult INTEGER DEFAULT 0") } catch (_: Exception) {}
        try { db.execSQL("ALTER TABLE media_items ADD COLUMN is_extra INTEGER DEFAULT 0") } catch (_: Exception) {}
        try { db.execSQL("ALTER TABLE live_channels ADD COLUMN added_timestamp INTEGER DEFAULT 0") } catch (_: Exception) {}
        try { db.execSQL("UPDATE media_items SET is_extra = 1 WHERE is_extra = 0 AND is_adult = 0 AND (" + EXTRA_CATEGORY_TOKENS.joinToString(" OR ") { "lower(category_name) LIKE '%${it.replace("'", "''")}%'" } + ")") } catch (_: Exception) {}
        try { db.execSQL("ALTER TABLE media_items ADD COLUMN certification TEXT DEFAULT ''") } catch (_: Exception) {}

        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS profiles (
                profile_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                avatar_color TEXT NOT NULL,
                is_kids INTEGER DEFAULT 0,
                theme TEXT DEFAULT 'purple',
                is_primary INTEGER DEFAULT 0,
                updated_at INTEGER NOT NULL
            )
            """.trimIndent()
        )

        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS profile_media_state (
                profile_id TEXT NOT NULL,
                dedup_key TEXT NOT NULL,
                in_watchlist INTEGER DEFAULT 0,
                is_watched INTEGER DEFAULT 0,
                resume_position_ms INTEGER DEFAULT 0,
                duration_ms INTEGER DEFAULT 0,
                user_rating REAL DEFAULT 0.0,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (profile_id, dedup_key)
            )
            """.trimIndent()
        )
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_pms_prof ON profile_media_state(profile_id)")

        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS profile_episode_state (
                profile_id TEXT NOT NULL,
                episode_id TEXT NOT NULL,
                resume_position_ms INTEGER DEFAULT 0,
                is_watched INTEGER DEFAULT 0,
                duration_secs INTEGER DEFAULT 0,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (profile_id, episode_id)
            )
            """.trimIndent()
        )
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_pes_prof ON profile_episode_state(profile_id)")

        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS profile_live_favorites (
                profile_id TEXT NOT NULL,
                stream_id TEXT NOT NULL,
                PRIMARY KEY (profile_id, stream_id)
            )
            """.trimIndent()
        )
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_plf_prof ON profile_live_favorites(profile_id)")
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
                search_blob TEXT DEFAULT '',
                is_adult INTEGER DEFAULT 0,
                is_extra INTEGER DEFAULT 0,
                certification TEXT DEFAULT ''
            )
            """.trimIndent()
        )

        db.execSQL("CREATE INDEX IF NOT EXISTS idx_media_type ON media_items(media_type)")
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_media_year ON media_items(year DESC)")
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_media_rating ON media_items(rating DESC)")
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_media_added ON media_items(added_timestamp DESC)")
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_media_enriched ON media_items(is_enriched, rating DESC)")
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_media_lang ON media_items(language)")
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_media_adult ON media_items(is_adult)")
        try { db.execSQL("CREATE INDEX IF NOT EXISTS idx_media_extra ON media_items(is_extra)") } catch (_: Exception) {}
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_media_cert ON media_items(certification)")

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
                is_favorite INTEGER DEFAULT 0,
                added_timestamp INTEGER DEFAULT 0
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

        ensureSchemaUpdated(db)

        // Seed default helpful Pinned Smart Rows so the user immediately sees their power
        seedDefaultSmartRows(db)
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        ensureSchemaUpdated(db)
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

    /**
     * Batch upserts deduplicated media items while preserving existing user state
     * (in_watchlist, is_watched, resume_position_ms) and existing TMDB enrichment!
     * Returns the count of brand-new items added in this sync.
     */
    fun upsertMediaBatch(items: List<MediaItem>, markNewIfInserted: Boolean, mergeVersions: Boolean = false): Int {
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
                           duration_ms, has_embedded_subtitles, embedded_sub_langs, embedded_audio_langs,
                           certification, tmdb_id, vote_count, rating, year, poster_url,
                           versions_json, category_name, quality_badges, added_timestamp
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
                val existingCert = if (exists) existingCursor.getString(15) ?: "" else ""
                val existingTmdb = if (exists) existingCursor.getInt(16) else 0
                val existingVotes = if (exists) existingCursor.getInt(17) else 0
                val existingRating = if (exists) existingCursor.getDouble(18) else 0.0
                val existingYear = if (exists) existingCursor.getInt(19) else 0
                val existingPoster = if (exists) existingCursor.getString(20) ?: "" else ""
                val existingVersionsJson = if (exists) existingCursor.getString(21) ?: "[]" else "[]"
                val existingCategory = if (exists) existingCursor.getString(22) ?: "" else ""
                val existingBadges = if (exists) existingCursor.getString(23) ?: "" else ""
                val existingAdded = if (exists) existingCursor.getLong(24) else 0L
                existingCursor.close()

                // Chunked import: the same title can arrive in several chunks, so copies are merged with what is saved.
                // A title that has not changed at all is not written again (a refresh then only saves what is new or changed).
                val mergedVersionsJson = if (exists && mergeVersions) mergeVersionsJson(existingVersionsJson, item.versions) else null
                if (exists && mergeVersions && mergedVersionsJson == existingVersionsJson && item.categoryName == existingCategory) {
                    continue
                }

                if (!exists && markNewIfInserted) {
                    newlyAdded++
                }

                val finalGenres = if (keepEnriched && existingGenres.isNotBlank()) {
                    existingGenres
                } else if (exists && mergeVersions && existingGenres.isNotBlank()) {
                    (existingGenres.split("|").filter { it.isNotBlank() } + item.genres).distinct().joinToString("|")
                } else {
                    item.genres.distinct().joinToString("|")
                }
                val finalPlot = if ((keepEnriched || mergeVersions) && existingPlot.isNotBlank()) existingPlot else item.plot
                val finalCast = if ((keepEnriched || mergeVersions) && existingCast.isNotBlank()) existingCast else item.cast.joinToString("|")
                val finalDirector = if ((keepEnriched || mergeVersions) && existingDirector.isNotBlank()) existingDirector else item.director
                val finalRuntime = if (keepEnriched && existingRuntime > 0) existingRuntime else item.runtimeMins
                val finalBackdrop = if ((keepEnriched || mergeVersions) && existingBackdrop.isNotBlank()) existingBackdrop else item.backdropUrl
                val finalImdb = if (keepEnriched && existingImdb.isNotBlank()) existingImdb else item.imdbId
                // A re-sync must never wipe what TMDB already filled in (age rating, id, votes, rating, year, poster):
                // without the age rating, Kids profiles would suddenly hide those titles.
                val finalCert = if (existingCert.isNotBlank()) existingCert else item.certification
                val finalTmdb = if (item.tmdbId == 0 && existingTmdb > 0) existingTmdb else item.tmdbId
                val finalVotes = if (keepEnriched && existingVotes > 0) existingVotes else item.voteCount
                val finalRating = if (keepEnriched && existingRating > 0.0) existingRating else item.rating
                val finalYear = if (keepEnriched && existingYear > 0) existingYear else item.year
                val finalPoster = if ((keepEnriched || mergeVersions) && existingPoster.isNotBlank()) existingPoster else item.posterUrl

                val versionsJson = mergedVersionsJson ?: JSONArray().apply {
                    item.versions.forEach { put(it.toJson()) }
                }.toString()
                val finalBadges = if (exists && mergeVersions) {
                    (existingBadges.split("|").filter { it.isNotBlank() } + item.qualityBadges).distinct().joinToString("|")
                } else item.qualityBadges.distinct().joinToString("|")
                val finalAdded = if (exists && mergeVersions) maxOf(existingAdded, item.addedTimestamp) else item.addedTimestamp

                val isAdult = item.isAdult || checkIsAdult(item.cleanTitle, item.rawTitle, item.categoryName, finalGenres)

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
                    put("tmdb_id", finalTmdb)
                    put("imdb_id", finalImdb)
                    put("media_type", item.mediaType.name)
                    put("clean_title", item.cleanTitle)
                    put("raw_title", item.rawTitle)
                    put("year", finalYear)
                    put("rating", finalRating)
                    put("vote_count", finalVotes)
                    put("genres_text", finalGenres)
                    put("plot", finalPlot)
                    put("cast_text", finalCast)
                    put("director", finalDirector)
                    put("runtime_mins", finalRuntime)
                    put("poster_url", finalPoster)
                    put("backdrop_url", finalBackdrop)
                    put("language", item.language)
                    put("quality_badges", finalBadges)
                    put("has_embedded_subtitles", if (hasEmbSub) 1 else 0)
                    put("embedded_sub_langs", embSubLangs)
                    put("has_online_subtitles", if (item.hasOnlineSubtitles) 1 else 0)
                    put("embedded_audio_langs", embAudioLangs)
                    put("category_id", item.categoryId)
                    put("category_name", item.categoryName)
                    put("added_timestamp", finalAdded)
                    put("is_enriched", if (keepEnriched || item.isEnriched) 1 else 0)
                    put("is_newly_added", if (!exists && markNewIfInserted) 1 else 0)
                    put("in_watchlist", if (inWatchlist) 1 else 0)
                    put("is_watched", if (isWatched) 1 else 0)
                    put("resume_position_ms", resumePos)
                    put("duration_ms", durationMs)
                    put("versions_json", versionsJson)
                    put("search_blob", searchBlob)
                    put("is_adult", if (isAdult) 1 else 0)
                    put("is_extra", if (!isAdult && checkIsExtra(item.categoryName)) 1 else 0)
                    put("certification", finalCert)
                }

                db.insertWithOnConflict("media_items", null, cv, SQLiteDatabase.CONFLICT_REPLACE)
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        return newlyAdded
    }

    /** Merges a saved version list (JSON text) with new copies: the same streamId is replaced, other saved copies stay. */
    private fun mergeVersionsJson(existingJson: String, incoming: List<StreamVersion>): String {
        val byId = LinkedHashMap<String, JSONObject>()
        runCatching {
            val arr = JSONArray(existingJson)
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                val id = o.optString("streamId")
                if (id.isNotBlank()) byId[id] = o
            }
        }
        for (v in incoming) byId[v.streamId] = v.toJson()
        val out = JSONArray()
        byId.values.forEach { out.put(it) }
        return out.toString()
    }

    fun countMediaOfType(type: MediaType): Int {
        readableDatabase.rawQuery("SELECT COUNT(*) FROM media_items WHERE media_type = ?", arrayOf(type.name)).use { c ->
            return if (c.moveToFirst()) c.getInt(0) else 0
        }
    }

    /**
     * After a COMPLETE download: forgets copies the provider no longer lists. A title with no copy left is deleted
     * (with its episodes); watchlist / resume entries stay in the profile tables and come back if the title returns.
     * Returns (titles removed, single copies removed).
     */
    fun removeUnseenMedia(type: MediaType, seenStreamIds: Set<String>): Pair<Int, Int> {
        val db = writableDatabase
        val deleteKeys = ArrayList<String>()
        val deleteSeriesIds = ArrayList<String>()
        val updates = ArrayList<Triple<String, String, String>>() // key, new versions json, new primary stream id
        var versionsRemoved = 0
        db.rawQuery("SELECT dedup_key, versions_json, primary_stream_id FROM media_items WHERE media_type = ?", arrayOf(type.name)).use { c ->
            while (c.moveToNext()) {
                val key = c.getString(0) ?: continue
                val json = c.getString(1) ?: "[]"
                val primary = c.getString(2) ?: ""
                val arr = runCatching { JSONArray(json) }.getOrNull() ?: continue
                if (arr.length() == 0) continue
                val kept = JSONArray()
                val gone = ArrayList<String>()
                var firstKept = ""
                for (i in 0 until arr.length()) {
                    val o = arr.getJSONObject(i)
                    val id = o.optString("streamId")
                    if (id in seenStreamIds) {
                        if (firstKept.isEmpty()) firstKept = id
                        kept.put(o)
                    } else gone.add(id)
                }
                if (gone.isEmpty()) continue
                versionsRemoved += gone.size
                if (kept.length() == 0) {
                    deleteKeys.add(key)
                    if (type == MediaType.SERIES) deleteSeriesIds.addAll(gone)
                } else {
                    updates.add(Triple(key, kept.toString(), if (primary in seenStreamIds) primary else firstKept))
                }
            }
        }
        if (deleteKeys.isEmpty() && updates.isEmpty()) return Pair(0, 0)
        db.beginTransactionNonExclusive()
        try {
            for ((key, json, primary) in updates) {
                val cv = ContentValues().apply { put("versions_json", json); put("primary_stream_id", primary) }
                db.update("media_items", cv, "dedup_key = ?", arrayOf(key))
            }
            for (key in deleteKeys) db.delete("media_items", "dedup_key = ?", arrayOf(key))
            for (id in deleteSeriesIds) db.delete("series_episodes", "series_id = ?", arrayOf(id))
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        return Pair(deleteKeys.size, versionsRemoved)
    }

    /** Removes live channels the provider no longer lists. Returns how many were removed. */
    fun removeUnseenLive(seenStreamIds: Set<String>): Int {
        val db = writableDatabase
        val gone = ArrayList<String>()
        db.rawQuery("SELECT stream_id FROM live_channels", null).use { c ->
            while (c.moveToNext()) {
                val id = c.getString(0) ?: continue
                if (id !in seenStreamIds) gone.add(id)
            }
        }
        if (gone.isEmpty()) return 0
        db.beginTransactionNonExclusive()
        try {
            for (id in gone) db.delete("live_channels", "stream_id = ?", arrayOf(id))
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        return gone.size
    }

    fun countLiveChannels(): Int {
        readableDatabase.rawQuery("SELECT COUNT(*) FROM live_channels", null).use { c ->
            return if (c.moveToFirst()) c.getInt(0) else 0
        }
    }

    /**
     * The same title listed once WITH a TMDB id and once WITHOUT one gets two different keys:
     * fold the loose copy into the TMDB one (their versions are merged). Done after the chunked import.
     */
    fun foldLooseDuplicates(type: MediaType): Int {
        val db = writableDatabase
        val titleKeyToTmdbKey = HashMap<String, String>()
        db.rawQuery("SELECT dedup_key, raw_title, category_name FROM media_items WHERE media_type = ? AND dedup_key LIKE 'tmdb:%'", arrayOf(type.name)).use { c ->
            while (c.moveToNext()) {
                val key = c.getString(0) ?: continue
                val raw = c.getString(1) ?: ""
                val cat = c.getString(2) ?: ""
                if (raw.isBlank()) continue
                titleKeyToTmdbKey[TitleParser.parse(raw, cat).dedupKey] = key
            }
        }
        if (titleKeyToTmdbKey.isEmpty()) return 0
        val pairs = ArrayList<Pair<String, String>>() // loose key -> tmdb key
        db.rawQuery("SELECT dedup_key FROM media_items WHERE media_type = ? AND dedup_key NOT LIKE 'tmdb:%'", arrayOf(type.name)).use { c ->
            while (c.moveToNext()) {
                val key = c.getString(0) ?: continue
                val target = titleKeyToTmdbKey[key] ?: continue
                pairs.add(Pair(key, target))
            }
        }
        if (pairs.isEmpty()) return 0
        var folded = 0
        db.beginTransactionNonExclusive()
        try {
            for ((loose, target) in pairs) {
                var looseVersions = "[]"
                db.rawQuery("SELECT versions_json FROM media_items WHERE dedup_key = ?", arrayOf(loose)).use { c ->
                    if (c.moveToFirst()) looseVersions = c.getString(0) ?: "[]"
                }
                var targetVersions = "[]"
                var targetFound = false
                db.rawQuery("SELECT versions_json FROM media_items WHERE dedup_key = ?", arrayOf(target)).use { c ->
                    if (c.moveToFirst()) { targetVersions = c.getString(0) ?: "[]"; targetFound = true }
                }
                if (!targetFound) continue
                val incoming = ArrayList<StreamVersion>()
                runCatching {
                    val arr = JSONArray(looseVersions)
                    for (i in 0 until arr.length()) incoming.add(StreamVersion.fromJson(arr.getJSONObject(i)))
                }
                val cv = ContentValues().apply { put("versions_json", mergeVersionsJson(targetVersions, incoming)) }
                db.update("media_items", cv, "dedup_key = ?", arrayOf(target))
                db.delete("media_items", "dedup_key = ?", arrayOf(loose))
                folded++
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        return folded
    }

    /**
     * Updates a single MediaItem after background TMDB / Xtream VOD Info enrichment.
     */
    fun updateEnrichedMetadata(
        dedupKey: String,
        tmdbId: Int,
        imdbId: String,
        year: Int,
        rating: Double,
        voteCount: Int,
        genres: List<String>,
        plot: String,
        cast: List<String>,
        director: String,
        runtimeMins: Int,
        posterUrl: String,
        backdropUrl: String,
        language: String,
        hasEmbeddedSubs: Boolean,
        embeddedSubLangs: List<String>,
        embeddedAudioLangs: List<String>,
        isAdult: Boolean = false,
        certification: String = ""
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
        val finalIsAdult = isAdult || checkIsAdult(cleanTitle, rawTitle, catName, mergedGenres.joinToString("|"))

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
            put("is_adult", if (finalIsAdult) 1 else 0)
            put("is_extra", if (!finalIsAdult && checkIsExtra(catName)) 1 else 0)
            if (certification.isNotBlank()) put("certification", certification.trim().uppercase(Locale.ROOT))
        }
        db.update("media_items", cv, "dedup_key = ?", arrayOf(dedupKey))
    }

    /**
     * Fetches un-enriched items ordered by Smart Priority:
     * 1. Preferred languages first
     * 2. Newest release year & highest server rating first
     */
    fun getUnenrichedMediaQueue(preferredLanguages: Set<String>, limit: Int = 500): List<MediaItem> {
        val db = readableDatabase
        val cursor = db.rawQuery(
            """
            SELECT * FROM media_items
            WHERE is_enriched = 0 AND is_adult = 0 AND is_extra = 0
            ORDER BY year DESC, rating DESC, added_timestamp DESC
            LIMIT ?
            """.trimIndent(),
            arrayOf(limit.toString())
        )
        val all = readMediaList(cursor)
        // Sort preferred languages to the front of the batch
        return all.sortedByDescending { item ->
            val langScore = if (preferredLanguages.contains(item.language)) 10000 else 0
            langScore + item.year
        }
    }

    /**
     * A new TV only learns the TMDB id of each title from the cloud copy (nothing else: the cloud copy may still hold old
     * provider ratings). Titles that already have an id are left alone. Returns how many titles got an id.
     */
    fun fillMissingTmdbIds(pairs: List<Pair<String, Int>>): Int {
        if (pairs.isEmpty()) return 0
        val db = writableDatabase
        var filled = 0
        db.beginTransaction()
        try {
            val st = db.compileStatement("UPDATE media_items SET tmdb_id = ? WHERE dedup_key = ? AND (tmdb_id IS NULL OR tmdb_id = 0)")
            for ((key, id) in pairs) {
                if (id <= 0 || key.isBlank()) continue
                st.clearBindings()
                st.bindLong(1, id.toLong())
                st.bindString(2, key)
                filled += st.executeUpdateDelete()
            }
            st.close()
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        return filled
    }

    /** Titles with no TMDB votes and no rating were only "described" by the provider: send them to TMDB too. */
    fun requeueProviderOnlyTitles(): Int {
        val db = writableDatabase
        // a rating with no votes can only have come from the provider (the "10" some new titles showed): clear it
        db.execSQL("UPDATE media_items SET rating = 0.0 WHERE vote_count = 0 AND rating > 0.0")
        db.execSQL("UPDATE media_items SET is_enriched = 0 WHERE is_enriched = 1 AND vote_count = 0 AND rating = 0.0 AND is_adult = 0 AND is_extra = 0")
        db.rawQuery("SELECT changes()", null).use { c -> return if (c.moveToFirst()) c.getInt(0) else 0 }
    }

    @Volatile private var enrichCountCache: Triple<Int, Int, Long>? = null
    /** Same numbers, but counted at most once every few seconds: the screen asks for them all the time and counting 70k rows is not free. */
    fun getEnrichmentCountsCached(maxAgeMs: Long = 6000L): Pair<Int, Int> {
        val c = enrichCountCache
        if (c != null && System.currentTimeMillis() - c.third < maxAgeMs) return Pair(c.first, c.second)
        val fresh = getEnrichmentCounts()
        enrichCountCache = Triple(fresh.first, fresh.second, System.currentTimeMillis())
        return fresh
    }

    fun getEnrichmentCounts(): Pair<Int, Int> {
        val db = readableDatabase
        var total = 0
        var enriched = 0
        db.rawQuery("SELECT COUNT(*), SUM(CASE WHEN is_enriched = 1 THEN 1 ELSE 0 END) FROM media_items WHERE is_adult = 0 AND is_extra = 0", null).use { c ->
            if (c.moveToFirst()) {
                total = c.getInt(0)
                enriched = c.getInt(1)
            }
        }
        return Pair(enriched, total)
    }

    /**
     * Core Multi-Attribute Super-Filter query engine.
     * Supports simultaneous filtering across:
     * - Full-text search (Title, Plot, Cast, Director)
     * - Included Genres (AND / OR logic)
     * - Excluded Genres (NOT logic)
     * - Selected Languages + Global Hidden Languages
     * - Subtitle availability & specific language
     * - Year range / Decade
     * - Minimum Rating
     * - Stream Quality (4K, 1080p, HEVC)
     * - Hide Watched toggle
     * - Clickable Actor / Director / Category filter
     * - Profile-scoped watchlist/watched/resume
     * - Kids Mode certification filtering (uncertified strictly excluded)
     * - 18+ Vault filtering
     */
    fun queryMedia(
        filter: SuperFilterState,
        hiddenLanguages: Set<String> = emptySet(),
        limit: Int = 180,
        profileId: String = "",
        isKids: Boolean = false,
        isAdultVaultUnlocked: Boolean = false,
        isVaultTab: Boolean = false,
        isExtrasUnlocked: Boolean = false,
        isExtrasTab: Boolean = false,
        offset: Int = 0,
        totalOut: IntArray? = null
    ): List<MediaItem> {
        val db = readableDatabase
        val whereClauses = mutableListOf<String>()
        val args = mutableListOf<String>()

        if (profileId.isNotBlank()) {
            args.add(profileId)
        }

        // Adult filter rule:
        // Excluded from EVERY query unless session is unlocked, not in kids mode, and request comes from Vault tab
        // Extras follow the same rule with their own unlock. Kids profiles never see either.
        if (isVaultTab && isAdultVaultUnlocked && !isKids) {
            whereClauses.add("m.is_adult = 1")
        } else if (isExtrasTab && isExtrasUnlocked && !isKids) {
            whereClauses.add("m.is_extra = 1")
            whereClauses.add("m.is_adult = 0")
        } else {
            whereClauses.add("m.is_adult = 0")
            whereClauses.add("m.is_extra = 0")
        }

        // Kids mode rule:
        // When on: show only titles with age cert <= young child level. Titles with NO certification are hidden!
        if (isKids) {
            whereClauses.add(ContentCertifications.kidsClause("m.certification"))
        }

        if (filter.mediaTypeFilter != null) {
            whereClauses.add("m.media_type = ?")
            args.add(filter.mediaTypeFilter.name)
        }

        // Global hidden languages
        for (hiddenLang in hiddenLanguages) {
            whereClauses.add("m.language != ?")
            args.add(hiddenLang)
        }

        // Explicit language filter
        if (filter.selectedLanguages.isNotEmpty()) {
            val placeholders = filter.selectedLanguages.joinToString(",") { "?" }
            whereClauses.add("m.language IN ($placeholders)")
            args.addAll(filter.selectedLanguages)
        }

        // Search query across Title, Plot, Cast, Director
        if (filter.searchQuery.isNotBlank()) {
            val tokens = filter.searchQuery.trim().lowercase(Locale.ROOT).split(Regex("""\s+"""))
            for (token in tokens) {
                whereClauses.add("m.search_blob LIKE ?")
                args.add("%$token%")
            }
        }

        // Included Genres (AND vs OR)
        if (filter.includedGenres.isNotEmpty()) {
            if (filter.matchAllIncludedGenres) {
                for (genre in filter.includedGenres) {
                    whereClauses.add("('|' || m.genres_text || '|' LIKE ?)")
                    args.add("%|$genre|%")
                }
            } else {
                val orParts = filter.includedGenres.map { "('|' || m.genres_text || '|' LIKE ?)" }
                whereClauses.add("(" + orParts.joinToString(" OR ") + ")")
                filter.includedGenres.forEach { args.add("%|$it|%") }
            }
        }

        // Excluded Genres (NOT)
        for (excluded in filter.excludedGenres) {
            whereClauses.add("('|' || m.genres_text || '|' NOT LIKE ?)")
            args.add("%|$excluded|%")
        }

        // Subtitle filter mode
        when (filter.subtitleFilterMode) {
            SubtitleFilterMode.ANY -> {}
            SubtitleFilterMode.ANY_SUBTITLES -> {
                whereClauses.add("(m.has_embedded_subtitles = 1 OR m.has_online_subtitles = 1 OR m.tmdb_id > 0)")
            }
            SubtitleFilterMode.EMBEDDED_ONLY -> {
                whereClauses.add("m.has_embedded_subtitles = 1")
            }
            SubtitleFilterMode.ONLINE_AVAILABLE -> {
                whereClauses.add("(m.has_online_subtitles = 1 OR m.tmdb_id > 0)")
            }
            SubtitleFilterMode.SPECIFIC_LANGUAGE -> {
                whereClauses.add("(m.embedded_sub_langs LIKE ? OR m.has_online_subtitles = 1)")
                args.add("%${filter.specificSubtitleLanguage}%")
            }
        }

        // Decade or Year Range
        if (filter.decade != null) {
            whereClauses.add("m.year BETWEEN ? AND ?")
            args.add(filter.decade.toString())
            args.add((filter.decade + 9).toString())
        } else {
            if (filter.minYear != null) {
                whereClauses.add("m.year >= ?")
                args.add(filter.minYear.toString())
            }
            if (filter.maxYear != null) {
                whereClauses.add("m.year <= ?")
                args.add(filter.maxYear.toString())
            }
        }

        // Minimum Rating
        if (filter.minRating > 0.0) {
            whereClauses.add("m.rating >= ?")
            args.add(filter.minRating.toString())
        }

        // Stream Quality badge
        if (!filter.qualityFilter.isNullOrBlank()) {
            whereClauses.add("(m.quality_badges LIKE ? OR m.versions_json LIKE ?)")
            args.add("%${filter.qualityFilter}%")
            args.add("%${filter.qualityFilter}%")
        }

        // Hide Watched
        if (filter.hideWatched) {
            if (profileId.isNotBlank()) {
                whereClauses.add("COALESCE(pms.is_watched, m.is_watched) = 0")
            } else {
                whereClauses.add("m.is_watched = 0")
            }
        }

        // Server Category
        if (!filter.serverCategoryId.isNullOrBlank()) {
            whereClauses.add("m.category_id = ?")
            args.add(filter.serverCategoryId)
        }

        // Actor Chip Filter
        if (!filter.actorFilter.isNullOrBlank()) {
            whereClauses.add("m.cast_text LIKE ?")
            args.add("%${filter.actorFilter}%")
        }

        // Director Chip Filter
        if (!filter.directorFilter.isNullOrBlank()) {
            whereClauses.add("m.director LIKE ?")
            args.add("%${filter.directorFilter}%")
        }

        val whereSql = if (whereClauses.isEmpty()) "" else "WHERE " + whereClauses.joinToString(" AND ")
        val orderSql = when (filter.sortBy) {
            SortOption.NEWLY_ADDED -> "ORDER BY m.added_timestamp DESC, m.year DESC"
            SortOption.RELEASE_YEAR_DESC -> "ORDER BY m.year DESC, m.rating DESC"
            SortOption.RATING_DESC -> "ORDER BY m.rating DESC, m.vote_count DESC"
            SortOption.TITLE_ASC -> "ORDER BY m.clean_title COLLATE NOCASE ASC"
            SortOption.RANDOM -> "ORDER BY RANDOM()"
        }

        val selectSql = if (profileId.isNotBlank()) {
            """
            m.*,
            COALESCE(pms.in_watchlist, 0) AS p_in_watchlist,
            COALESCE(pms.is_watched, 0) AS p_is_watched,
            COALESCE(pms.resume_position_ms, 0) AS p_resume_position_ms,
            COALESCE(pms.duration_ms, 0) AS p_duration_ms,
            COALESCE(pms.user_rating, 0.0) AS p_user_rating
            """.trimIndent()
        } else {
            "m.*"
        }

        val fromSql = if (profileId.isNotBlank()) {
            "media_items m LEFT JOIN profile_media_state pms ON pms.dedup_key = m.dedup_key AND pms.profile_id = ?"
        } else {
            "media_items m"
        }

        // Optional: how many titles match in total (for "Showing 1-120 of N" and for loading more pages)
        if (totalOut != null && totalOut.isNotEmpty()) {
            db.rawQuery("SELECT COUNT(*) FROM $fromSql $whereSql", args.toTypedArray()).use { c ->
                totalOut[0] = if (c.moveToFirst()) c.getInt(0) else 0
            }
        }

        val sql = "SELECT $selectSql FROM $fromSql $whereSql $orderSql LIMIT $limit OFFSET ${offset.coerceAtLeast(0)}"
        val cursor = db.rawQuery(sql, args.toTypedArray())
        return readMediaList(cursor)
    }

    /**
     * Instant 2-letter Autocomplete chips for the TV Search screen.
     * Never returns adult titles; in Kids mode restricts to kid certifications.
     */
    fun getAutocompleteSuggestions(prefix: String, isKids: Boolean = false, limit: Int = 10): List<String> {
        val clean = prefix.trim()
        if (clean.length < 2) return emptyList()
        val db = readableDatabase
        val suggestions = LinkedHashSet<String>()

        val kidsClause = if (isKids) "AND " + ContentCertifications.kidsClause("certification") else ""

        // 1. Matching Titles starting with or containing the prefix
        db.rawQuery(
            """
            SELECT clean_title FROM media_items
            WHERE is_adult = 0 AND is_extra = 0 $kidsClause AND (clean_title LIKE ? OR clean_title LIKE ?)
            ORDER BY CASE WHEN clean_title LIKE ? THEN 0 ELSE 1 END, rating DESC
            LIMIT ?
            """.trimIndent(),
            arrayOf("$clean%", "% $clean%", "$clean%", limit.toString())
        ).use { c ->
            while (c.moveToNext()) {
                suggestions.add(c.getString(0))
            }
        }

        // 2. Matching Cast & Directors
        if (suggestions.size < limit) {
            db.rawQuery(
                """
                SELECT cast_text, director FROM media_items
                WHERE is_adult = 0 AND is_extra = 0 $kidsClause AND (cast_text LIKE ? OR director LIKE ?)
                LIMIT 25
                """.trimIndent(),
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

    /**
     * "More Like This" for the Detail screen. matchMode picks what "like" means:
     *  - everything:    shared genres + same director + shared cast (default)
     *  - story:         shared genres + similar plot words + same age rating
     *  - setting:       same language + similar era (within 10 years)
     *  - cast_director: same director or shared actors only
     * hideWatched drops titles this profile already watched. Adult titles NEVER appear here.
     */
    fun getMoreLikeThis(
        item: MediaItem,
        isKids: Boolean = false,
        limit: Int = 12,
        matchMode: String = "everything",
        hideWatched: Boolean = false,
        profileId: String = "",
        offset: Int = 0
    ): List<MediaItem> {
        val db = readableDatabase
        val kidsClause = if (isKids) "AND " + ContentCertifications.kidsClause("m.certification") else ""

        // Each condition is 1 when it matches; the sum is computed ONCE per row (not twice) and lets the BEST matches fill
        // the candidate pool. A title that has no genres yet (details not loaded) is matched by its provider category instead.
        val conds = mutableListOf<String>()
        val condArgs = mutableListOf<String>()
        item.genres.take(3).forEach { conds.add("('|' || m.genres_text || '|' LIKE ?)"); condArgs.add("%|$it|%") }
        if (item.director.isNotBlank()) { conds.add("(m.director != '' AND m.director = ?)"); condArgs.add(item.director) }
        item.cast.take(2).forEach { conds.add("(m.cast_text LIKE ?)"); condArgs.add("%$it%") }
        if (matchMode == "setting" && item.language.isNotBlank()) { conds.add("(m.language = ?)"); condArgs.add(item.language) }
        if (item.genres.isEmpty() && item.categoryName.isNotBlank()) { conds.add("(m.category_name = ?)"); condArgs.add(item.categoryName) }
        if (conds.isEmpty()) return emptyList()

        val hasProfile = profileId.isNotBlank()
        val selectSql = if (hasProfile) {
            "m.*, COALESCE(pms.in_watchlist, 0) AS p_in_watchlist, COALESCE(pms.is_watched, 0) AS p_is_watched, " +
                "COALESCE(pms.resume_position_ms, 0) AS p_resume_position_ms, COALESCE(pms.duration_ms, 0) AS p_duration_ms, " +
                "COALESCE(pms.user_rating, 0.0) AS p_user_rating"
        } else "m.*"
        val fromSql = if (hasProfile) {
            "media_items m LEFT JOIN profile_media_state pms ON pms.dedup_key = m.dedup_key AND pms.profile_id = ?"
        } else "media_items m"
        val args = mutableListOf<String>()
        args.addAll(condArgs)         // the match-count column comes first in the statement
        if (hasProfile) args.add(profileId)
        args.add(item.mediaType.name)
        args.add(item.dedupKey)

        val matchCount = conds.joinToString(" + ")
        val cursor = db.rawQuery(
            "SELECT * FROM (SELECT $selectSql, ($matchCount) AS match_count FROM $fromSql " +
                "WHERE m.media_type = ? AND m.dedup_key != ? AND m.is_adult = 0 AND m.is_extra = 0 $kidsClause) " +
                "WHERE match_count > 0 ORDER BY match_count DESC, rating DESC, year DESC LIMIT 600",
            args.toTypedArray()
        )
        val candidates = readMediaList(cursor)
        val taste = if (hasProfile) loadTaste(profileId) else null
        data class Scored(val m: MediaItem, val score: Int)
        val scored = candidates.mapNotNull { cand ->
            if (hideWatched && cand.isWatched) return@mapNotNull null
            RelatedScoring.score(item, cand, matchMode, taste)?.let { Scored(cand, it) }
        }
        return scored.sortedByDescending { RelatedScoring.sortKey(it.score, it.m.rating) }
            .drop(offset).take(limit).map { it.m }
    }

    /** What this profile's own star ratings say (4-5 stars liked, 1-2 stars disliked). Null when the profile has rated nothing. */
    fun loadTaste(profileId: String): Taste? {
        val liked = HashSet<String>(); val disliked = HashSet<String>(); val people = HashSet<String>()
        readableDatabase.rawQuery(
            "SELECT m.genres_text, m.director, m.cast_text, pms.user_rating FROM profile_media_state pms " +
                "JOIN media_items m ON m.dedup_key = pms.dedup_key WHERE pms.profile_id = ? AND pms.user_rating > 0 LIMIT 300",
            arrayOf(profileId)
        ).use { c ->
            while (c.moveToNext()) {
                val genres = (c.getString(0) ?: "").split("|").filter { it.isNotBlank() }
                val stars = c.getDouble(3)
                if (stars >= 4.0) {
                    liked.addAll(genres)
                    (c.getString(1) ?: "").takeIf { it.isNotBlank() }?.let { people.add(it) }
                    (c.getString(2) ?: "").split("|").take(3).filter { it.isNotBlank() }.forEach { people.add(it) }
                } else if (stars <= 2.0) disliked.addAll(genres)
            }
        }
        // a genre both liked and disliked cancels out
        val both = liked.intersect(disliked)
        val t = Taste(liked - both, disliked - both, people)
        return if (t.isEmpty) null else t
    }

    fun getAllDistinctGenres(): List<String> {
        val db = readableDatabase
        val genres = mutableSetOf(
            "Action", "Adventure", "Animation", "Comedy", "Crime",
            "Documentary", "Drama", "Family", "Fantasy", "History",
            "Horror", "Mystery", "Romance", "Sci-Fi", "Thriller", "War", "Western"
        )
        db.rawQuery("SELECT DISTINCT genres_text FROM media_items WHERE genres_text != '' AND is_adult = 0 AND is_extra = 0 LIMIT 1000", null).use { c ->
            while (c.moveToNext()) {
                c.getString(0)?.split("|")?.forEach { g ->
                    if (g.isNotBlank()) genres.add(g.trim())
                }
            }
        }
        return genres.sorted()
    }

    fun getAllDistinctLanguages(): List<String> {
        val db = readableDatabase
        val langs = linkedSetOf("English", "Hindi", "Urdu", "Multi-Audio", "Arabic", "Korean", "Turkish", "Spanish", "French", "Japanese")
        db.rawQuery("SELECT DISTINCT language FROM media_items WHERE language != '' AND is_adult = 0 AND is_extra = 0", null).use { c ->
            while (c.moveToNext()) {
                c.getString(0)?.takeIf { it.isNotBlank() }?.let { langs.add(it) }
            }
        }
        return langs.toList()
    }

    /** Kids profiles may only open titles with a young-child rating that are not 18+ / Extras. */
    fun isKidsAllowed(dedupKey: String): Boolean {
        readableDatabase.rawQuery(
            "SELECT 1 FROM media_items m WHERE m.dedup_key = ? AND m.is_adult = 0 AND m.is_extra = 0 AND ${ContentCertifications.kidsClause("m.certification")}",
            arrayOf(dedupKey)
        ).use { return it.moveToFirst() }
    }

    fun isAdultItem(dedupKey: String): Boolean {
        val db = readableDatabase
        db.rawQuery("SELECT (is_adult OR is_extra) FROM media_items WHERE dedup_key = ?", arrayOf(dedupKey)).use { c ->
            if (c.moveToFirst()) return c.getInt(0) == 1
        }
        return false
    }

    fun getContinueWatchingList(profileId: String = "", isKids: Boolean = false, limit: Int = 20): List<MediaItem> {
        val db = readableDatabase
        // Phase B Rule: Adult content NEVER appears in Continue Watching!
        val (sql, args) = if (profileId.isNotBlank()) {
            val kidsClause = if (isKids) "AND " + ContentCertifications.kidsClause("m.certification") else ""
            Pair(
                """
                SELECT m.*,
                       pms.in_watchlist AS p_in_watchlist,
                       pms.is_watched AS p_is_watched,
                       pms.resume_position_ms AS p_resume_position_ms,
                       pms.duration_ms AS p_duration_ms,
                       pms.user_rating AS p_user_rating
                FROM profile_media_state pms
                JOIN media_items m ON m.dedup_key = pms.dedup_key
                WHERE pms.profile_id = ?
                  AND pms.resume_position_ms > 15000
                  AND pms.is_watched = 0
                  AND m.is_adult = 0 AND m.is_extra = 0
                  $kidsClause
                ORDER BY pms.updated_at DESC
                LIMIT ?
                """.trimIndent(),
                arrayOf(profileId, limit.toString())
            )
        } else {
            val kidsClause = if (isKids) "AND " + ContentCertifications.kidsClause("certification") else ""
            Pair(
                "SELECT * FROM media_items WHERE resume_position_ms > 15000 AND is_watched = 0 AND is_adult = 0 AND is_extra = 0 $kidsClause ORDER BY added_timestamp DESC LIMIT ?",
                arrayOf(limit.toString())
            )
        }
        val cursor = db.rawQuery(sql, args)
        return readMediaList(cursor)
    }

    fun getWatchlist(profileId: String = "", isKids: Boolean = false): List<MediaItem> {
        val db = readableDatabase
        // Phase B Rule: Adult content NEVER appears in Watchlist
        val (sql, args) = if (profileId.isNotBlank()) {
            val kidsClause = if (isKids) "AND " + ContentCertifications.kidsClause("m.certification") else ""
            Pair(
                """
                SELECT m.*,
                       pms.in_watchlist AS p_in_watchlist,
                       pms.is_watched AS p_is_watched,
                       pms.resume_position_ms AS p_resume_position_ms,
                       pms.duration_ms AS p_duration_ms,
                       pms.user_rating AS p_user_rating
                FROM profile_media_state pms
                JOIN media_items m ON m.dedup_key = pms.dedup_key
                WHERE pms.profile_id = ?
                  AND pms.in_watchlist = 1
                  AND m.is_adult = 0 AND m.is_extra = 0
                  $kidsClause
                ORDER BY m.clean_title ASC
                """.trimIndent(),
                arrayOf(profileId)
            )
        } else {
            val kidsClause = if (isKids) "AND " + ContentCertifications.kidsClause("certification") else ""
            Pair(
                "SELECT * FROM media_items WHERE in_watchlist = 1 AND is_adult = 0 AND is_extra = 0 $kidsClause ORDER BY clean_title ASC",
                emptyArray<String>()
            )
        }
        val cursor = db.rawQuery(sql, args)
        return readMediaList(cursor)
    }

    fun toggleWatchlist(dedupKey: String, profileId: String = ""): Boolean {
        // Phase B Rule: Adult content can never be added to Watchlist
        if (isAdultItem(dedupKey)) return false
        val db = writableDatabase
        val now = System.currentTimeMillis()
        var newState = false

        if (profileId.isNotBlank()) {
            var exists = false
            db.rawQuery("SELECT in_watchlist FROM profile_media_state WHERE profile_id = ? AND dedup_key = ?", arrayOf(profileId, dedupKey)).use { c ->
                if (c.moveToFirst()) {
                    exists = true
                    newState = c.getInt(0) == 0
                } else {
                    newState = true
                }
            }
            val cv = ContentValues().apply {
                put("in_watchlist", if (newState) 1 else 0)
                put("updated_at", now)
            }
            if (exists) {
                db.update("profile_media_state", cv, "profile_id = ? AND dedup_key = ?", arrayOf(profileId, dedupKey))
            } else {
                cv.put("profile_id", profileId)
                cv.put("dedup_key", dedupKey)
                db.insert("profile_media_state", null, cv)
            }
        } else {
            db.rawQuery("SELECT in_watchlist FROM media_items WHERE dedup_key = ?", arrayOf(dedupKey)).use { c ->
                if (c.moveToFirst()) newState = c.getInt(0) == 0
            }
            val cv = ContentValues().apply { put("in_watchlist", if (newState) 1 else 0) }
            db.update("media_items", cv, "dedup_key = ?", arrayOf(dedupKey))
        }
        return newState
    }

    fun toggleWatched(dedupKey: String, profileId: String = ""): Boolean {
        // Phase B Rule: Adult content can never be marked watched
        if (isAdultItem(dedupKey)) return false
        val db = writableDatabase
        val now = System.currentTimeMillis()
        var newState = false

        if (profileId.isNotBlank()) {
            var exists = false
            db.rawQuery("SELECT is_watched FROM profile_media_state WHERE profile_id = ? AND dedup_key = ?", arrayOf(profileId, dedupKey)).use { c ->
                if (c.moveToFirst()) {
                    exists = true
                    newState = c.getInt(0) == 0
                } else {
                    newState = true
                }
            }
            val cv = ContentValues().apply {
                put("is_watched", if (newState) 1 else 0)
                if (newState) put("resume_position_ms", 0L)
                put("updated_at", now)
            }
            if (exists) {
                db.update("profile_media_state", cv, "profile_id = ? AND dedup_key = ?", arrayOf(profileId, dedupKey))
            } else {
                cv.put("profile_id", profileId)
                cv.put("dedup_key", dedupKey)
                db.insert("profile_media_state", null, cv)
            }
        } else {
            db.rawQuery("SELECT is_watched FROM media_items WHERE dedup_key = ?", arrayOf(dedupKey)).use { c ->
                if (c.moveToFirst()) newState = c.getInt(0) == 0
            }
            val cv = ContentValues().apply {
                put("is_watched", if (newState) 1 else 0)
                if (newState) put("resume_position_ms", 0L)
            }
            db.update("media_items", cv, "dedup_key = ?", arrayOf(dedupKey))
        }
        return newState
    }

    fun getItemByDedupKey(dedupKey: String, profileId: String = ""): MediaItem? {
        val db = readableDatabase
        val sql = if (profileId.isNotBlank()) {
            """
            SELECT m.*,
                   COALESCE(pms.in_watchlist, 0) AS p_in_watchlist,
                   COALESCE(pms.is_watched, 0) AS p_is_watched,
                   COALESCE(pms.resume_position_ms, 0) AS p_resume_position_ms,
                   COALESCE(pms.duration_ms, 0) AS p_duration_ms,
                   COALESCE(pms.user_rating, 0.0) AS p_user_rating
            FROM media_items m
            LEFT JOIN profile_media_state pms ON pms.dedup_key = m.dedup_key AND pms.profile_id = ?
            WHERE m.dedup_key = ? LIMIT 1
            """.trimIndent()
        } else {
            "SELECT * FROM media_items WHERE dedup_key = ? LIMIT 1"
        }
        val args = if (profileId.isNotBlank()) arrayOf(profileId, dedupKey) else arrayOf(dedupKey)
        db.rawQuery(sql, args).use { c ->
            val list = readMediaList(c)
            return list.firstOrNull()
        }
    }

    fun setUserStarRating(dedupKey: String, starRating: Double, profileId: String = "") {
        if (isAdultItem(dedupKey)) return
        val db = writableDatabase
        val now = System.currentTimeMillis()
        if (profileId.isNotBlank()) {
            val cv = ContentValues().apply {
                put("user_rating", starRating)
                put("updated_at", now)
            }
            val rows = db.update("profile_media_state", cv, "profile_id = ? AND dedup_key = ?", arrayOf(profileId, dedupKey))
            if (rows == 0) {
                cv.put("profile_id", profileId)
                cv.put("dedup_key", dedupKey)
                db.insert("profile_media_state", null, cv)
            }
        }
        val cv = ContentValues().apply { put("rating", starRating) }
        db.update("media_items", cv, "dedup_key = ?", arrayOf(dedupKey))
    }

    fun savePlaybackProgress(dedupKey: String, positionMs: Long, durationMs: Long, profileId: String = ""): Boolean {
        // Phase B Rule: Never record progress, resume position, or watched flag for adult titles
        if (isAdultItem(dedupKey)) {
            return false
        }
        val db = writableDatabase
        val finished = durationMs > 60_000L && positionMs.toDouble() / durationMs.toDouble() >= 0.90
        val now = System.currentTimeMillis()

        if (profileId.isNotBlank()) {
            val cv = ContentValues().apply {
                put("resume_position_ms", if (finished) 0L else positionMs)
                put("duration_ms", durationMs)
                if (finished) put("is_watched", 1)
                put("updated_at", now)
            }
            val rows = db.update("profile_media_state", cv, "profile_id = ? AND dedup_key = ?", arrayOf(profileId, dedupKey))
            if (rows == 0) {
                cv.put("profile_id", profileId)
                cv.put("dedup_key", dedupKey)
                cv.put("is_watched", if (finished) 1 else 0)
                db.insert("profile_media_state", null, cv)
            }
        }

        val cv = ContentValues().apply {
            put("resume_position_ms", if (finished) 0L else positionMs)
            put("duration_ms", durationMs)
            if (finished) put("is_watched", 1)
        }
        db.update("media_items", cv, "dedup_key = ?", arrayOf(dedupKey))
        return true
    }

    fun recordDiscoveredStreamTracks(
        dedupKey: String,
        subtitleLangs: List<String>,
        audioLangs: List<String>
    ) {
        val db = writableDatabase
        val cv = ContentValues().apply {
            if (subtitleLangs.isNotEmpty()) {
                put("has_embedded_subtitles", 1)
                put("embedded_sub_langs", subtitleLangs.distinct().joinToString("|"))
            }
            if (audioLangs.isNotEmpty()) {
                put("embedded_audio_langs", audioLangs.distinct().joinToString("|"))
            }
        }
        if (cv.size() > 0) {
            db.update("media_items", cv, "dedup_key = ?", arrayOf(dedupKey))
        }
    }

    // Series Episodes
    fun saveSeriesEpisodes(seriesId: String, episodes: List<SeriesEpisode>) {
        val db = writableDatabase
        db.beginTransactionNonExclusive()
        try {
            for (ep in episodes) {
                var resumePos = ep.resumePositionMs
                var watched = ep.isWatched
                db.rawQuery(
                    "SELECT resume_position_ms, is_watched FROM series_episodes WHERE episode_id = ?",
                    arrayOf(ep.episodeId)
                ).use { c ->
                    if (c.moveToFirst()) {
                        resumePos = c.getLong(0)
                        watched = c.getInt(1) == 1
                    }
                }
                val cv = ContentValues().apply {
                    put("episode_id", ep.episodeId)
                    put("series_id", seriesId)
                    put("season_num", ep.seasonNumber)
                    put("episode_num", ep.episodeNumber)
                    put("title", ep.title)
                    put("plot", ep.plot)
                    put("duration_secs", ep.durationSecs)
                    put("container_ext", ep.containerExtension)
                    put("thumbnail_url", ep.thumbnailUrl)
                    put("added_timestamp", ep.addedTimestamp)
                    put("resume_position_ms", resumePos)
                    put("is_watched", if (watched) 1 else 0)
                }
                db.insertWithOnConflict("series_episodes", null, cv, SQLiteDatabase.CONFLICT_REPLACE)
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    // Titles whose details could not be sent to the cloud yet (cloud over its daily limit, offline...). They are sent later.
    private fun ensureCloudPendingTable() {
        writableDatabase.execSQL("CREATE TABLE IF NOT EXISTS cloud_upload_pending (dedup_key TEXT PRIMARY KEY)")
    }

    fun addCloudPending(keys: Collection<String>) {
        if (keys.isEmpty()) return
        ensureCloudPendingTable()
        val db = writableDatabase
        db.beginTransaction()
        try {
            for (k in keys) db.execSQL("INSERT OR IGNORE INTO cloud_upload_pending (dedup_key) VALUES (?)", arrayOf(k))
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }

    fun removeCloudPending(keys: Collection<String>) {
        if (keys.isEmpty()) return
        ensureCloudPendingTable()
        val db = writableDatabase
        db.beginTransaction()
        try {
            for (k in keys) db.execSQL("DELETE FROM cloud_upload_pending WHERE dedup_key = ?", arrayOf(k))
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }

    fun takeCloudPending(limit: Int): List<String> {
        ensureCloudPendingTable()
        val out = ArrayList<String>()
        writableDatabase.rawQuery("SELECT dedup_key FROM cloud_upload_pending LIMIT ?", arrayOf(limit.toString())).use { c ->
            while (c.moveToNext()) out.add(c.getString(0))
        }
        return out
    }

    fun countCloudPending(): Int {
        ensureCloudPendingTable()
        writableDatabase.rawQuery("SELECT COUNT(*) FROM cloud_upload_pending", null).use { c -> return if (c.moveToFirst()) c.getInt(0) else 0 }
    }

    /** Season counts for many series in ONE query (poster cards show "3 Seasons" instead of a bare "SERIES"). */
    fun seasonCountsFor(seriesIds: Collection<String>): Map<String, Int> {
        val ids = seriesIds.filter { it.isNotBlank() }.distinct()
        if (ids.isEmpty()) return emptyMap()
        val out = HashMap<String, Int>()
        val db = readableDatabase
        for (chunk in ids.chunked(500)) {
            val marks = chunk.joinToString(",") { "?" }
            db.rawQuery(
                "SELECT series_id, COUNT(DISTINCT season_num) FROM series_episodes WHERE series_id IN ($marks) AND season_num > 0 GROUP BY series_id",
                chunk.toTypedArray()
            ).use { c -> while (c.moveToNext()) out[c.getString(0)] = c.getInt(1) }
        }
        return out
    }

    fun getSeriesEpisodes(seriesId: String): List<SeriesEpisode> {
        val db = readableDatabase
        val list = mutableListOf<SeriesEpisode>()
        db.rawQuery(
            "SELECT * FROM series_episodes WHERE series_id = ? ORDER BY season_num ASC, episode_num ASC",
            arrayOf(seriesId)
        ).use { c ->
            while (c.moveToNext()) {
                list.add(
                    SeriesEpisode(
                        episodeId = c.getString(c.getColumnIndexOrThrow("episode_id")),
                        seriesId = c.getString(c.getColumnIndexOrThrow("series_id")),
                        seasonNumber = c.getInt(c.getColumnIndexOrThrow("season_num")),
                        episodeNumber = c.getInt(c.getColumnIndexOrThrow("episode_num")),
                        title = c.getString(c.getColumnIndexOrThrow("title")),
                        plot = c.getString(c.getColumnIndexOrThrow("plot")) ?: "",
                        durationSecs = c.getInt(c.getColumnIndexOrThrow("duration_secs")),
                        containerExtension = c.getString(c.getColumnIndexOrThrow("container_ext")) ?: "mp4",
                        thumbnailUrl = c.getString(c.getColumnIndexOrThrow("thumbnail_url")) ?: "",
                        addedTimestamp = c.getLong(c.getColumnIndexOrThrow("added_timestamp")),
                        resumePositionMs = c.getLong(c.getColumnIndexOrThrow("resume_position_ms")),
                        isWatched = c.getInt(c.getColumnIndexOrThrow("is_watched")) == 1
                    )
                )
            }
        }
        return list
    }

    fun saveEpisodeProgress(episodeId: String, positionMs: Long, durationMs: Long, profileId: String = "") {
        val db = writableDatabase
        val finished = durationMs > 60_000L && positionMs.toDouble() / durationMs.toDouble() >= 0.90
        val now = System.currentTimeMillis()

        if (profileId.isNotBlank()) {
            val cv = ContentValues().apply {
                put("resume_position_ms", if (finished) 0L else positionMs)
                put("duration_secs", (durationMs / 1000).toInt())
                if (finished) put("is_watched", 1)
                put("updated_at", now)
            }
            val rows = db.update("profile_episode_state", cv, "profile_id = ? AND episode_id = ?", arrayOf(profileId, episodeId))
            if (rows == 0) {
                cv.put("profile_id", profileId)
                cv.put("episode_id", episodeId)
                cv.put("is_watched", if (finished) 1 else 0)
                db.insert("profile_episode_state", null, cv)
            }
        }

        val cv = ContentValues().apply {
            put("resume_position_ms", if (finished) 0L else positionMs)
            if (finished) put("is_watched", 1)
        }
        db.update("series_episodes", cv, "episode_id = ?", arrayOf(episodeId))
    }

    // Live TV Channels
    // Set by the sync before a live import: false on the very first import (nothing is "new"), true afterwards
    @Volatile var treatNewLiveAsNew: Boolean = false

    fun hasLiveChannels(): Boolean = readableDatabase.rawQuery("SELECT 1 FROM live_channels LIMIT 1", null).use { it.moveToFirst() }

    fun upsertLiveChannels(channels: List<LiveChannel>) {
        if (channels.isEmpty()) return
        val db = writableDatabase
        val hadLiveChannelsBefore = treatNewLiveAsNew
        db.beginTransactionNonExclusive()
        try {
            for (ch in channels) {
                var fav = ch.isFavorite
                // First time we see a channel without a provider date = now, so "new since last refresh" works
                var added = if (ch.addedTimestamp > 0L) ch.addedTimestamp else 0L
                var seenBefore = false
                db.rawQuery("SELECT is_favorite, added_timestamp FROM live_channels WHERE stream_id = ?", arrayOf(ch.streamId)).use { c ->
                    if (c.moveToFirst()) {
                        seenBefore = true
                        fav = c.getInt(0) == 1
                        if (added == 0L) added = c.getLong(1)
                    }
                }
                if (added == 0L && !seenBefore && hadLiveChannelsBefore) added = System.currentTimeMillis() / 1000
                val cv = ContentValues().apply {
                    put("stream_id", ch.streamId)
                    put("name", ch.name)
                    put("logo_url", ch.logoUrl)
                    put("category_id", ch.categoryId)
                    put("category_name", ch.categoryName)
                    put("epg_channel_id", ch.epgChannelId)
                    put("current_program", ch.currentProgramTitle)
                    put("current_program_time", ch.currentProgramTime)
                    put("next_program", ch.nextProgramTitle)
                    put("is_favorite", if (fav) 1 else 0)
                    put("added_timestamp", added)
                }
                db.insertWithOnConflict("live_channels", null, cv, SQLiteDatabase.CONFLICT_REPLACE)
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    fun getLiveChannels(
        categoryName: String? = null,
        searchQuery: String = "",
        profileId: String = "",
        isKids: Boolean = false,
        group: String = "normal",
        keywords: List<String> = emptyList()
    ): List<LiveChannel> {
        // Kids mode: Live TV is hidden completely.
        if (isKids) return emptyList()
        val db = readableDatabase
        val clauses = mutableListOf<String>()
        val args = mutableListOf<String>()

        if (profileId.isNotBlank()) {
            args.add(profileId)
        }

        if (categoryName == "★ Favorites") {
            if (profileId.isNotBlank()) {
                clauses.add("plf.stream_id IS NOT NULL")
            } else {
                clauses.add("lc.is_favorite = 1")
            }
        } else if (!categoryName.isNullOrBlank() && categoryName != "All Channels") {
            clauses.add("lc.category_name = ?")
            args.add(categoryName)
        }

        if (searchQuery.isNotBlank()) {
            clauses.add("(lc.name LIKE ? OR lc.category_name LIKE ?)")
            args.add("%$searchQuery%")
            args.add("%$searchQuery%")
        }

        // Quick-tab keywords (Sports, News, Kids ...) match the provider's category name
        if (keywords.isNotEmpty()) {
            clauses.add("(" + keywords.joinToString(" OR ") { "lower(lc.category_name) LIKE ?" } + ")")
            keywords.forEach { args.add("%$it%") }
        }

        // Adult and Extras live channels only ever appear in their own unlocked tab, never in normal Live TV.
        clauses.add(liveGroupClause(group))
        if (group != "adult") {
            clauses.add("lc.name NOT LIKE '%xxx%'")
            clauses.add("lc.name NOT LIKE '%18+%'")
        }

        val where = if (clauses.isEmpty()) "" else "WHERE " + clauses.joinToString(" AND ")
        val sql = if (profileId.isNotBlank()) {
            """
            SELECT lc.*, CASE WHEN plf.stream_id IS NOT NULL THEN 1 ELSE 0 END AS p_is_fav
            FROM live_channels lc
            LEFT JOIN profile_live_favorites plf ON plf.stream_id = lc.stream_id AND plf.profile_id = ?
            $where
            ORDER BY p_is_fav DESC, lc.name ASC
            LIMIT 500
            """.trimIndent()
        } else {
            """
            SELECT lc.*, lc.is_favorite AS p_is_fav
            FROM live_channels lc
            $where
            ORDER BY lc.is_favorite DESC, lc.name ASC
            LIMIT 500
            """.trimIndent()
        }

        val list = mutableListOf<LiveChannel>()
        db.rawQuery(sql, args.toTypedArray()).use { c ->
            while (c.moveToNext()) {
                list.add(
                    LiveChannel(
                        streamId = c.getString(c.getColumnIndexOrThrow("stream_id")),
                        name = c.getString(c.getColumnIndexOrThrow("name")),
                        logoUrl = c.getString(c.getColumnIndexOrThrow("logo_url")) ?: "",
                        categoryId = c.getString(c.getColumnIndexOrThrow("category_id")) ?: "",
                        categoryName = c.getString(c.getColumnIndexOrThrow("category_name")) ?: "General",
                        epgChannelId = c.getString(c.getColumnIndexOrThrow("epg_channel_id")) ?: "",
                        currentProgramTitle = c.getString(c.getColumnIndexOrThrow("current_program")) ?: "",
                        currentProgramTime = c.getString(c.getColumnIndexOrThrow("current_program_time")) ?: "",
                        nextProgramTitle = c.getString(c.getColumnIndexOrThrow("next_program")) ?: "",
                        isFavorite = c.getInt(c.getColumnIndexOrThrow("p_is_fav")) == 1
                    )
                )
            }
        }
        return list
    }

    /** Latest added titles: last [days] days, newest first, at most [maxItems]; if fewer than [minItems], the newest [fillTo]. */
    fun getLatestAdded(mediaType: String, isKids: Boolean, days: Int = 14, maxItems: Int = 50, minItems: Int = 10, fillTo: Int = 30, group: String = "normal"): List<MediaItem> {
        val db = readableDatabase
        val kidsClause = if (isKids) "AND " + ContentCertifications.kidsClause("certification") else ""
        val cutoff = System.currentTimeMillis() / 1000 - days * 86400L
        val groupWhere = when (group) {
            "adult" -> "is_adult = 1"
            "extras" -> "is_extra = 1 AND is_adult = 0"
            else -> "is_adult = 0 AND is_extra = 0"
        }
        fun run(extra: String, args: Array<String>, limit: Int): List<MediaItem> =
            db.rawQuery(
                "SELECT * FROM media_items WHERE media_type = ? AND $groupWhere $kidsClause $extra " +
                    "ORDER BY added_timestamp DESC, rating DESC LIMIT $limit",
                arrayOf(mediaType) + args
            ).use { readMediaList(it) }
        val recent = run("AND added_timestamp > ?", arrayOf(cutoff.toString()), maxItems)
        return if (recent.size >= minItems) recent else run("AND added_timestamp > 0", emptyArray(), fillTo)
    }

    fun getLatestLiveChannels(days: Int = 14, maxItems: Int = 50, minItems: Int = 10, fillTo: Int = 30, group: String = "normal"): List<LiveChannel> {
        val db = readableDatabase
        val cutoff = System.currentTimeMillis() / 1000 - days * 86400L
        val nameGuard = if (group == "normal") "AND lc.name NOT LIKE '%xxx%' AND lc.name NOT LIKE '%18+%'" else ""
        fun run(extra: String, args: Array<String>, limit: Int): List<LiveChannel> {
            val out = mutableListOf<LiveChannel>()
            db.rawQuery(
                "SELECT lc.* FROM live_channels lc WHERE ${liveGroupClause(group)} $nameGuard $extra " +
                    "ORDER BY lc.added_timestamp DESC, lc.name ASC LIMIT $limit",
                args
            ).use { c ->
                while (c.moveToNext()) {
                    out.add(
                        LiveChannel(
                            streamId = c.getString(c.getColumnIndexOrThrow("stream_id")),
                            name = c.getString(c.getColumnIndexOrThrow("name")),
                            logoUrl = c.getString(c.getColumnIndexOrThrow("logo_url")) ?: "",
                            categoryId = c.getString(c.getColumnIndexOrThrow("category_id")) ?: "",
                            categoryName = c.getString(c.getColumnIndexOrThrow("category_name")) ?: "",
                            addedTimestamp = c.getLong(c.getColumnIndexOrThrow("added_timestamp"))
                        )
                    )
                }
            }
            return out
        }
        val recent = run("AND lc.added_timestamp > ?", arrayOf(cutoff.toString()), maxItems)
        return if (recent.size >= minItems) recent else run("AND lc.added_timestamp > 0", emptyArray(), fillTo)
    }

    fun getLiveCategories(group: String = "normal"): List<String> {
        val db = readableDatabase
        val cats = mutableListOf("All Channels", "★ Favorites")
        db.rawQuery("SELECT DISTINCT lc.category_name FROM live_channels lc WHERE lc.category_name != '' AND ${liveGroupClause(group)} ORDER BY lc.category_name ASC", null).use { c ->
            while (c.moveToNext()) {
                c.getString(0)?.takeIf { it.isNotBlank() }?.let { cats.add(it) }
            }
        }
        return cats
    }

    fun toggleFavoriteChannel(streamId: String, profileId: String = ""): Boolean {
        val db = writableDatabase
        var fav = false
        if (profileId.isNotBlank()) {
            val exists = db.rawQuery("SELECT 1 FROM profile_live_favorites WHERE profile_id = ? AND stream_id = ?", arrayOf(profileId, streamId)).use { it.moveToFirst() }
            if (exists) {
                db.delete("profile_live_favorites", "profile_id = ? AND stream_id = ?", arrayOf(profileId, streamId))
                fav = false
            } else {
                val cv = ContentValues().apply {
                    put("profile_id", profileId)
                    put("stream_id", streamId)
                }
                db.insertWithOnConflict("profile_live_favorites", null, cv, SQLiteDatabase.CONFLICT_REPLACE)
                fav = true
            }
        } else {
            db.rawQuery("SELECT is_favorite FROM live_channels WHERE stream_id = ?", arrayOf(streamId)).use { c ->
                if (c.moveToFirst()) fav = c.getInt(0) == 0
            }
            val cv = ContentValues().apply { put("is_favorite", if (fav) 1 else 0) }
            db.update("live_channels", cv, "stream_id = ?", arrayOf(streamId))
        }
        return fav
    }

    // --- Profiles Management (Limit 5, Scoped Personal Data) ---
    fun getProfiles(defaultName: String = "User"): List<UserProfile> {
        val db = readableDatabase
        val list = mutableListOf<UserProfile>()
        db.rawQuery(
            "SELECT profile_id, name, avatar_color, is_kids, theme, is_primary, updated_at FROM profiles ORDER BY is_primary DESC, updated_at ASC",
            null
        ).use { c ->
            while (c.moveToNext()) {
                list.add(
                    UserProfile(
                        id = c.getString(0),
                        name = c.getString(1),
                        avatarColor = c.getString(2) ?: "#8B5CF6",
                        isKids = c.getInt(3) == 1,
                        theme = c.getString(4) ?: "purple",
                        isPrimary = c.getInt(5) == 1,
                        updatedAt = c.getLong(6)
                    )
                )
            }
        }
        if (list.isEmpty()) {
            val seeded = ensureDefaultProfile(defaultName)
            return listOf(seeded)
        }
        return list
    }

    fun ensureDefaultProfile(defaultName: String = "User"): UserProfile {
        val db = writableDatabase
        val existing = getProfileById("prof_primary")
        if (existing != null) return existing
        val now = System.currentTimeMillis()
        val prof = UserProfile(
            id = "prof_primary",
            name = defaultName.ifBlank { "User" },
            avatarColor = "#7C3AED",
            isKids = false,
            theme = "purple",
            isPrimary = true,
            updatedAt = now
        )
        val cv = ContentValues().apply {
            put("profile_id", prof.id)
            put("name", prof.name)
            put("avatar_color", prof.avatarColor)
            put("is_kids", if (prof.isKids) 1 else 0)
            put("theme", prof.theme)
            put("is_primary", 1)
            put("updated_at", now)
        }
        db.insertWithOnConflict("profiles", null, cv, SQLiteDatabase.CONFLICT_REPLACE)
        return prof
    }

    fun getPrimaryProfile(): UserProfile {
        val db = readableDatabase
        db.rawQuery(
            "SELECT profile_id, name, avatar_color, is_kids, theme, is_primary, updated_at FROM profiles WHERE is_primary = 1 LIMIT 1",
            null
        ).use { c ->
            if (c.moveToFirst()) {
                return UserProfile(
                    id = c.getString(0),
                    name = c.getString(1),
                    avatarColor = c.getString(2) ?: "#8B5CF6",
                    isKids = c.getInt(3) == 1,
                    theme = c.getString(4) ?: "purple",
                    isPrimary = true,
                    updatedAt = c.getLong(6)
                )
            }
        }
        return ensureDefaultProfile()
    }

    fun getProfileById(profileId: String): UserProfile? {
        if (profileId.isBlank()) return null
        val db = readableDatabase
        db.rawQuery(
            "SELECT profile_id, name, avatar_color, is_kids, theme, is_primary, updated_at FROM profiles WHERE profile_id = ?",
            arrayOf(profileId)
        ).use { c ->
            if (c.moveToFirst()) {
                return UserProfile(
                    id = c.getString(0),
                    name = c.getString(1),
                    avatarColor = c.getString(2) ?: "#8B5CF6",
                    isKids = c.getInt(3) == 1,
                    theme = c.getString(4) ?: "purple",
                    isPrimary = c.getInt(5) == 1,
                    updatedAt = c.getLong(6)
                )
            }
        }
        return null
    }

    fun createProfile(name: String, avatarColor: String, theme: String, isKids: Boolean): UserProfile? {
        val db = writableDatabase
        var count = 0
        db.rawQuery("SELECT COUNT(*) FROM profiles", null).use { c ->
            if (c.moveToFirst()) count = c.getInt(0)
        }
        if (count >= 5) {
            return null // Strict Limit: Max 5 profiles per account
        }
        val id = "prof_" + java.util.UUID.randomUUID().toString().take(8)
        val now = System.currentTimeMillis()
        val prof = UserProfile(
            id = id,
            name = name.trim().ifBlank { "Profile ${count + 1}" },
            avatarColor = avatarColor.ifBlank { "#8B5CF6" },
            isKids = isKids,
            theme = theme.ifBlank { "purple" },
            isPrimary = false,
            updatedAt = now
        )
        val cv = ContentValues().apply {
            put("profile_id", prof.id)
            put("name", prof.name)
            put("avatar_color", prof.avatarColor)
            put("is_kids", if (prof.isKids) 1 else 0)
            put("theme", prof.theme)
            put("is_primary", 0)
            put("updated_at", now)
        }
        db.insert("profiles", null, cv)
        return prof
    }

    fun updateProfile(id: String, name: String, avatarColor: String, theme: String, isKids: Boolean): Boolean {
        val db = writableDatabase
        val cv = ContentValues().apply {
            if (name.isNotBlank()) put("name", name.trim())
            if (avatarColor.isNotBlank()) put("avatar_color", avatarColor.trim())
            if (theme.isNotBlank()) put("theme", theme.trim())
            put("is_kids", if (isKids) 1 else 0)
            put("updated_at", System.currentTimeMillis())
        }
        return db.update("profiles", cv, "profile_id = ?", arrayOf(id)) > 0
    }

    fun deleteProfile(id: String): Boolean {
        val db = writableDatabase
        val prof = getProfileById(id) ?: return false
        if (prof.isPrimary) return false // Primary profile cannot be deleted

        db.beginTransaction()
        try {
            db.delete("profiles", "profile_id = ?", arrayOf(id))
            db.delete("profile_media_state", "profile_id = ?", arrayOf(id))
            db.delete("profile_episode_state", "profile_id = ?", arrayOf(id))
            db.delete("profile_live_favorites", "profile_id = ?", arrayOf(id))
            db.setTransactionSuccessful()
            return true
        } finally {
            db.endTransaction()
        }
    }

    // Pinned Smart Rows
    fun getPinnedSmartRows(): List<PinnedSmartRow> {
        val db = readableDatabase
        val rows = mutableListOf<PinnedSmartRow>()
        db.rawQuery("SELECT * FROM pinned_smart_rows ORDER BY created_at ASC", null).use { c ->
            while (c.moveToNext()) {
                val id = c.getString(c.getColumnIndexOrThrow("row_id"))
                val title = c.getString(c.getColumnIndexOrThrow("title"))
                val jsonStr = c.getString(c.getColumnIndexOrThrow("filter_json"))
                val filter = runCatching { SuperFilterState.fromJson(JSONObject(jsonStr)) }
                    .getOrDefault(SuperFilterState())
                rows.add(PinnedSmartRow(id, title, filter))
            }
        }
        return rows
    }

    fun savePinnedSmartRow(title: String, filterState: SuperFilterState): PinnedSmartRow {
        val db = writableDatabase
        val id = "smart_${System.currentTimeMillis()}"
        val cv = ContentValues().apply {
            put("row_id", id)
            put("title", title)
            put("filter_json", filterState.toJson().toString())
            put("created_at", System.currentTimeMillis())
        }
        db.insertWithOnConflict("pinned_smart_rows", null, cv, SQLiteDatabase.CONFLICT_REPLACE)
        return PinnedSmartRow(id, title, filterState)
    }

    fun deletePinnedSmartRow(rowId: String) {
        writableDatabase.delete("pinned_smart_rows", "row_id = ?", arrayOf(rowId))
    }

    /** Removes titles, episodes and channels only: profiles, watchlists, watched marks and resume points stay. */
    fun clearTitlesOnly() {
        val db = writableDatabase
        db.beginTransaction()
        try {
            db.delete("media_items", null, null)
            db.delete("series_episodes", null, null)
            db.delete("live_channels", null, null)
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    fun clearCatalog() {
        val db = writableDatabase
        db.beginTransaction()
        try {
            db.delete("media_items", null, null)
            db.delete("series_episodes", null, null)
            db.delete("live_channels", null, null)
            db.delete("pinned_smart_rows", null, null)
            db.delete("profile_media_state", null, null)
            db.delete("profile_episode_state", null, null)
            db.delete("profile_live_favorites", null, null)
            db.delete("profiles", null, null)
            seedDefaultSmartRows(db)
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    // Export & Import User Data (Watchlist, Watched, Resume Progress, Pinned Smart Rows)
    fun exportUserDataJson(): String {
        val root = JSONObject()
        val watchlistArr = JSONArray()
        val watchedArr = JSONArray()
        val progressArr = JSONArray()
        readableDatabase.rawQuery(
            "SELECT dedup_key, in_watchlist, is_watched, resume_position_ms, duration_ms FROM media_items WHERE in_watchlist = 1 OR is_watched = 1 OR resume_position_ms > 0",
            null
        ).use { c ->
            while (c.moveToNext()) {
                val key = c.getString(0)
                if (c.getInt(1) == 1) watchlistArr.put(key)
                if (c.getInt(2) == 1) watchedArr.put(key)
                val pos = c.getLong(3)
                val dur = c.getLong(4)
                if (pos > 0) {
                    progressArr.put(JSONObject().apply {
                        put("key", key)
                        put("pos", pos)
                        put("dur", dur)
                    })
                }
            }
        }
        val smartRowsArr = JSONArray()
        for (row in getPinnedSmartRows()) {
            smartRowsArr.put(JSONObject().apply {
                put("id", row.id)
                put("title", row.title)
                put("filter", row.filterState.toJson())
            })
        }
        root.put("watchlist", watchlistArr)
        root.put("watched", watchedArr)
        root.put("progress", progressArr)
        root.put("smartRows", smartRowsArr)
        return root.toString(2)
    }

    fun importUserDataJson(jsonString: String) {
        val root = JSONObject(jsonString)
        val db = writableDatabase
        db.beginTransactionNonExclusive()
        try {
            root.optJSONArray("watchlist")?.let { arr ->
                for (i in 0 until arr.length()) {
                    val cv = ContentValues().apply { put("in_watchlist", 1) }
                    db.update("media_items", cv, "dedup_key = ?", arrayOf(arr.getString(i)))
                }
            }
            root.optJSONArray("watched")?.let { arr ->
                for (i in 0 until arr.length()) {
                    val cv = ContentValues().apply { put("is_watched", 1) }
                    db.update("media_items", cv, "dedup_key = ?", arrayOf(arr.getString(i)))
                }
            }
            root.optJSONArray("progress")?.let { arr ->
                for (i in 0 until arr.length()) {
                    val obj = arr.getJSONObject(i)
                    val cv = ContentValues().apply {
                        put("resume_position_ms", obj.optLong("pos"))
                        put("duration_ms", obj.optLong("dur"))
                    }
                    db.update("media_items", cv, "dedup_key = ?", arrayOf(obj.optString("key")))
                }
            }
            root.optJSONArray("smartRows")?.let { arr ->
                for (i in 0 until arr.length()) {
                    val obj = arr.getJSONObject(i)
                    val cv = ContentValues().apply {
                        put("row_id", obj.optString("id"))
                        put("title", obj.optString("title"))
                        put("filter_json", obj.optJSONObject("filter")?.toString() ?: "{}")
                        put("created_at", System.currentTimeMillis() + i)
                    }
                    db.insertWithOnConflict("pinned_smart_rows", null, cv, SQLiteDatabase.CONFLICT_REPLACE)
                }
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
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

                val isAdult = c.getColumnIndex("is_adult").let { if (it >= 0) c.getInt(it) == 1 else false }
                val cert = c.getColumnIndex("certification").let { if (it >= 0) c.getString(it) ?: "" else "" }

                val inWatchlist = c.getColumnIndex("p_in_watchlist").let { if (it >= 0) c.getInt(it) == 1 else c.getInt(c.getColumnIndexOrThrow("in_watchlist")) == 1 }
                val isWatched = c.getColumnIndex("p_is_watched").let { if (it >= 0) c.getInt(it) == 1 else c.getInt(c.getColumnIndexOrThrow("is_watched")) == 1 }
                val resumePos = c.getColumnIndex("p_resume_position_ms").let { if (it >= 0) c.getLong(it) else c.getLong(c.getColumnIndexOrThrow("resume_position_ms")) }
                val durationMs = c.getColumnIndex("p_duration_ms").let { if (it >= 0) c.getLong(it) else c.getLong(c.getColumnIndexOrThrow("duration_ms")) }
                val userRating = c.getColumnIndex("p_user_rating").let { if (it >= 0) c.getDouble(it) else 0.0 }

                val versions = mutableListOf<StreamVersion>()
                runCatching {
                    val arr = JSONArray(versionsJson)
                    for (i in 0 until arr.length()) {
                        versions.add(StreamVersion.fromJson(arr.getJSONObject(i)))
                    }
                }

                list.add(
                    MediaItem(
                        dedupKey = c.getString(c.getColumnIndexOrThrow("dedup_key")),
                        primaryStreamId = c.getString(c.getColumnIndexOrThrow("primary_stream_id")),
                        tmdbId = c.getInt(c.getColumnIndexOrThrow("tmdb_id")),
                        imdbId = c.getString(c.getColumnIndexOrThrow("imdb_id")) ?: "",
                        mediaType = runCatching {
                            MediaType.valueOf(c.getString(c.getColumnIndexOrThrow("media_type")))
                        }.getOrDefault(MediaType.MOVIE),
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
                        inWatchlist = inWatchlist,
                        isWatched = isWatched,
                        resumePositionMs = resumePos,
                        durationMs = durationMs,
                        isAdult = isAdult,
                        certification = cert,
                        userRating = userRating,
                        versions = versions
                    )
                )
            }
        }
        return list
    }
}
