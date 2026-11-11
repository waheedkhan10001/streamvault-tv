package com.streamvault.tv.data

import android.util.JsonReader
import android.util.JsonToken
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.InputStreamReader
import java.net.URLEncoder
import java.util.Locale
import java.util.concurrent.TimeUnit

/**
 * Memory-safe, streaming Xtream Codes + TMDB Catalog Sync Engine.
 *
 * Key Guarantees for TCL 55P635 (2GB RAM):
 * 1. Uses Android's streaming JsonReader to parse 60,000+ movies without loading the
 *    entire JSON array into memory (prevents OutOfMemoryError crashes).
 * 2. Deduplicates multiple copies/qualities/languages of the same movie BEFORE calling TMDB.
 * 3. Respects the 1-Connection Playback Lock: pauses IPTV server calls whenever video is playing.
 * 4. Enriches 100% of the catalog via TMDB in Smart Priority order (preferred languages & newest first).
 */
class CatalogSyncEngine(
    private val db: StreamVaultDatabase,
    private val prefs: PreferencesManager,
    private val scope: CoroutineScope
) {
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .followRedirects(true)
        .followSslRedirects(true)
        .build()

    private val _syncState = MutableStateFlow(SyncProgressState())
    val syncState: StateFlow<SyncProgressState> = _syncState

    private var syncJob: Job? = null
    private var enrichJob: Job? = null

    private val tmdbGenreMap = mapOf(
        28 to "Action",
        12 to "Adventure",
        16 to "Animation",
        35 to "Comedy",
        80 to "Crime",
        99 to "Documentary",
        18 to "Drama",
        10751 to "Family",
        14 to "Fantasy",
        36 to "History",
        27 to "Horror",
        10402 to "Music",
        9648 to "Mystery",
        10749 to "Romance",
        878 to "Sci-Fi",
        10770 to "TV Movie",
        53 to "Thriller",
        10752 to "War",
        37 to "Western",
        10759 to "Action",
        10765 to "Sci-Fi",
        10768 to "War"
    )

    private val isoLangMap = mapOf(
        "en" to "English",
        "hi" to "Hindi",
        "ur" to "Urdu",
        "pa" to "Punjabi",
        "ar" to "Arabic",
        "tr" to "Turkish",
        "ko" to "Korean",
        "ja" to "Japanese",
        "es" to "Spanish",
        "fr" to "French",
        "de" to "German",
        "it" to "Italian",
        "pt" to "Portuguese",
        "ru" to "Russian",
        "ta" to "Tamil",
        "te" to "Telugu",
        "fa" to "Persian"
    )

    fun triggerSync(isManual: Boolean = false, onCatalogUpdated: () -> Unit = {}) {
        val creds = prefs.loadCredentials()
        if (!creds.isConfigured) {
            seedSampleShowcaseCatalogIfEmpty()
            onCatalogUpdated()
            return
        }
        if (_syncState.value.isSyncing && !isManual) return

        syncJob?.cancel()
        syncJob = scope.launch(Dispatchers.IO) {
            // Respect 1-Connection Playback Lock
            if (prefs.isPlaybackActive.get() && !isManual) {
                return@launch
            }
            try {
                val isFirstSync = prefs.lastFullSyncTimestamp == 0L
                _syncState.value = SyncProgressState(
                    isSyncing = true,
                    phase = "Connecting to IPTV Server...",
                    lastSyncTimestamp = prefs.lastFullSyncTimestamp
                )

                val baseUrl = "${creds.normalizedServerUrl}/player_api.php?username=${
                    URLEncoder.encode(creds.username, "UTF-8")
                }&password=${URLEncoder.encode(creds.password, "UTF-8")}"

                // 1. Fetch VOD Categories Map
                _syncState.value = _syncState.value.copy(phase = "Loading Movie Categories...")
                val vodCatMap = fetchCategoryMap("$baseUrl&action=get_vod_categories")

                // 2. Stream & Deduplicate VOD Movies
                _syncState.value = _syncState.value.copy(phase = "Streaming Movies Catalog (Memory-Safe)...")
                val newMovies = streamAndSaveMedia(
                    url = "$baseUrl&action=get_vod_streams",
                    mediaType = MediaType.MOVIE,
                    categoryMap = vodCatMap,
                    markNew = !isFirstSync
                )
                onCatalogUpdated()

                // 3. Fetch Series Categories & Stream Series
                if (!prefs.isPlaybackActive.get()) {
                    _syncState.value = _syncState.value.copy(phase = "Streaming TV Series Catalog...")
                    val seriesCatMap = fetchCategoryMap("$baseUrl&action=get_series_categories")
                    val newSeries = streamAndSaveMedia(
                        url = "$baseUrl&action=get_series",
                        mediaType = MediaType.SERIES,
                        categoryMap = seriesCatMap,
                        markNew = !isFirstSync
                    )
                    _syncState.value = _syncState.value.copy(newlyAddedCount = newMovies + newSeries)
                    onCatalogUpdated()
                }

                // 4. Fetch Live TV Categories & Channels
                if (!prefs.isPlaybackActive.get()) {
                    _syncState.value = _syncState.value.copy(phase = "Loading Live TV Channels...")
                    val liveCatMap = fetchCategoryMap("$baseUrl&action=get_live_categories")
                    streamAndSaveLiveChannels("$baseUrl&action=get_live_streams", liveCatMap)
                    onCatalogUpdated()
                }

                prefs.lastFullSyncTimestamp = System.currentTimeMillis()
                val (enriched, total) = db.getEnrichmentCounts()
                _syncState.value = _syncState.value.copy(
                    isSyncing = false,
                    phase = "Catalog Synced • Starting Background TMDB Enrichment ($enriched / $total)",
                    enrichedCount = enriched,
                    totalToEnrich = total,
                    lastSyncTimestamp = prefs.lastFullSyncTimestamp,
                    errorMessage = null
                )

                // 5. Kick off Background 100% TMDB Enrichment Worker
                startBackgroundTmdbEnrichment(onCatalogUpdated)

            } catch (e: Throwable) {
                // Throwable (not just Exception) so running out of memory is reported instead of closing the app
                android.util.Log.e("StreamVault", "Catalog sync failed", e)
                val reason = when (e) {
                    is OutOfMemoryError -> "The TV ran out of memory while reading the catalog"
                    is java.net.UnknownHostException -> "Cannot find the IPTV server address. Check the Server URL"
                    is java.net.SocketTimeoutException -> "The IPTV server took too long to answer"
                    is java.net.ConnectException -> "Cannot connect to the IPTV server. Check the Server URL and port"
                    else -> e.localizedMessage ?: "Connection failed"
                }
                _syncState.value = _syncState.value.copy(
                    isSyncing = false,
                    phase = "Sync Error: $reason",
                    errorMessage = reason
                )
            }
        }
    }

    private fun fetchCategoryMap(url: String): Map<String, String> {
        val map = mutableMapOf<String, String>()
        runCatching {
            val req = Request.Builder().url(url).header("User-Agent", "StreamVaultTV/1.0").build()
            httpClient.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return map
                val bodyStr = resp.body?.string() ?: return map
                val arr = JSONArray(bodyStr)
                for (i in 0 until arr.length()) {
                    val obj = arr.getJSONObject(i)
                    val id = obj.optString("category_id")
                    val name = obj.optString("category_name")
                    if (id.isNotBlank() && name.isNotBlank()) {
                        map[id] = name
                    }
                }
            }
        }
        return map
    }

    /**
     * Streams potentially huge JSON arrays (50,000+ movies) using JsonReader
     * and groups duplicate copies by dedupKey before batch-saving to SQLite.
     */
    private fun streamAndSaveMedia(
        url: String,
        mediaType: MediaType,
        categoryMap: Map<String, String>,
        markNew: Boolean
    ): Int {
        val req = Request.Builder().url(url).header("User-Agent", "StreamVaultTV/1.0").build()
        val dedupMap = LinkedHashMap<String, MediaItem>(4096)

        httpClient.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) {
                throw IllegalStateException(
                    when (resp.code) {
                        401, 403 -> "The IPTV server refused the login (HTTP ${resp.code}). Check username and password"
                        404 -> "The IPTV server address is wrong (HTTP 404). Check the Server URL"
                        in 500..599 -> "The IPTV server has a problem (HTTP ${resp.code}). Try again later"
                        else -> "The IPTV server answered HTTP ${resp.code}"
                    }
                )
            }
            val stream = resp.body?.byteStream() ?: return 0
            val reader = JsonReader(InputStreamReader(stream, Charsets.UTF_8))

            // A list is expected. Providers answer with an object ({"user_info":{"auth":0}}) when the login is wrong.
            if (reader.peek() == JsonToken.BEGIN_OBJECT) {
                throw IllegalStateException("The IPTV server did not accept this username and password")
            }
            if (reader.peek() != JsonToken.BEGIN_ARRAY) return 0
            reader.beginArray()
            var count = 0
            while (reader.hasNext()) {
                if (reader.peek() != JsonToken.BEGIN_OBJECT) {
                    reader.skipValue()
                    continue
                }
                var streamId = ""
                var name = ""
                var poster = ""
                var backdrop = ""
                var rating = 0.0
                var categoryId = ""
                var containerExt = "mp4"
                var addedTs = 0L
                var tmdbId = 0
                var plot = ""
                var castStr = ""
                var director = ""
                var genreStr = ""
                var releaseDate = ""

                reader.beginObject()
                while (reader.hasNext()) {
                    val key = reader.nextName()
                    if (reader.peek() == JsonToken.NULL) {
                        reader.nextNull()
                        continue
                    }
                    when (key) {
                        "stream_id", "series_id" -> streamId = reader.nextStringOrNumber()
                        "name", "title" -> name = reader.nextStringOrNumber()
                        "stream_icon", "cover" -> poster = reader.nextStringOrNumber()
                        "rating" -> rating = reader.nextStringOrNumber().toDoubleOrNull() ?: 0.0
                        "category_id" -> categoryId = reader.nextStringOrNumber()
                        "container_extension" -> containerExt = reader.nextStringOrNumber()
                        "added", "last_modified" -> addedTs = reader.nextStringOrNumber().toLongOrNull() ?: 0L
                        "tmdb", "tmdb_id" -> tmdbId = reader.nextStringOrNumber().toIntOrNull() ?: 0
                        "plot" -> plot = reader.nextStringOrNumber()
                        "cast" -> castStr = reader.nextStringOrNumber()
                        "director" -> director = reader.nextStringOrNumber()
                        "genre" -> genreStr = reader.nextStringOrNumber()
                        "releaseDate", "release_date" -> releaseDate = reader.nextStringOrNumber()
                        "backdrop_path" -> {
                            if (reader.peek() == JsonToken.BEGIN_ARRAY) {
                                reader.beginArray()
                                if (reader.hasNext() && reader.peek() == JsonToken.STRING) {
                                    backdrop = reader.nextString()
                                }
                                while (reader.hasNext()) reader.skipValue()
                                reader.endArray()
                            } else {
                                backdrop = reader.nextStringOrNumber()
                            }
                        }
                        else -> reader.skipValue()
                    }
                }
                reader.endObject()

                if (streamId.isBlank() || name.isBlank()) continue
                val catName = categoryMap[categoryId] ?: "Movies"
                val parsed = TitleParser.parse(name, catName, tmdbId)
                val yearFromDate = releaseDate.take(4).toIntOrNull() ?: 0
                val finalYear = if (parsed.year > 0) parsed.year else yearFromDate

                val serverGenres = genreStr.split(",", "/", "|")
                    .map { it.trim() }
                    .filter { it.isNotBlank() }
                val combinedGenres = (serverGenres + parsed.inferredGenres).distinct()

                val version = StreamVersion(
                    streamId = streamId,
                    rawTitle = name,
                    languageTag = parsed.language,
                    qualityTag = parsed.qualityBadges.joinToString(" "),
                    subtitleTag = parsed.subtitleHint,
                    containerExtension = containerExt.ifBlank { "mp4" },
                    categoryId = categoryId,
                    categoryName = catName,
                    addedTimestamp = addedTs
                )

                val existing = dedupMap[parsed.dedupKey]
                if (existing == null) {
                    dedupMap[parsed.dedupKey] = MediaItem(
                        dedupKey = parsed.dedupKey,
                        primaryStreamId = streamId,
                        tmdbId = tmdbId,
                        mediaType = mediaType,
                        cleanTitle = parsed.cleanTitle,
                        rawTitle = name,
                        year = finalYear,
                        rating = rating.coerceIn(0.0, 10.0),
                        genres = combinedGenres,
                        plot = plot,
                        cast = castStr.split(",").map { it.trim() }.filter { it.isNotBlank() },
                        director = director,
                        posterUrl = poster,
                        backdropUrl = backdrop,
                        language = parsed.language,
                        qualityBadges = parsed.qualityBadges,
                        hasEmbeddedSubtitles = parsed.subtitleHint.isNotBlank() || containerExt.equals("mkv", ignoreCase = true),
                        embeddedSubtitleLanguages = if (parsed.subtitleHint.isNotBlank()) listOf("English") else emptyList(),
                        hasOnlineSubtitles = true,
                        categoryId = categoryId,
                        categoryName = catName,
                        addedTimestamp = addedTs,
                        isEnriched = plot.isNotBlank() && serverGenres.isNotEmpty(),
                        versions = listOf(version)
                    )
                } else {
                    // Merge duplicate stream version onto the same unified Netflix card!
                    val mergedQualities = (existing.qualityBadges + parsed.qualityBadges).distinct()
                    val mergedGenres = (existing.genres + combinedGenres).distinct()
                    val mergedVersions = existing.versions + version
                    val bestPoster = if (existing.posterUrl.isNotBlank()) existing.posterUrl else poster
                    val bestRating = maxOf(existing.rating, rating.coerceIn(0.0, 10.0))
                    val bestAdded = maxOf(existing.addedTimestamp, addedTs)
                    dedupMap[parsed.dedupKey] = existing.copy(
                        qualityBadges = mergedQualities,
                        genres = mergedGenres,
                        posterUrl = bestPoster,
                        rating = bestRating,
                        addedTimestamp = bestAdded,
                        versions = mergedVersions,
                        plot = existing.plot.ifBlank { plot },
                        cast = if (existing.cast.isNotEmpty()) existing.cast else castStr.split(",").map { it.trim() }.filter { it.isNotBlank() },
                        director = existing.director.ifBlank { director },
                        backdropUrl = existing.backdropUrl.ifBlank { backdrop },
                        tmdbId = if (existing.tmdbId > 0) existing.tmdbId else tmdbId,
                        year = if (existing.year > 0) existing.year else finalYear
                    )
                }

                count++
                if (count % 1500 == 0) {
                    _syncState.value = _syncState.value.copy(
                        processedItems = count,
                        phase = "Parsed $count ${if (mediaType == MediaType.MOVIE) "Movies" else "Series"} (${dedupMap.size} unique cards)..."
                    )
                }
            }
            reader.endArray()
        }

        // Same movie listed once WITH a TMDB id and once WITHOUT one gets two different keys: fold the second into the first
        val byTitleKey = HashMap<String, String>()
        for ((key, item) in dedupMap) {
            if (key.startsWith("tmdb:")) byTitleKey[TitleParser.parse(item.rawTitle, item.categoryName).dedupKey] = key
        }
        if (byTitleKey.isNotEmpty()) {
            for (key in dedupMap.keys.toList()) {
                val target = byTitleKey[key] ?: continue
                if (target == key) continue
                val loose = dedupMap.remove(key) ?: continue
                val keep = dedupMap[target] ?: continue
                dedupMap[target] = keep.copy(
                    qualityBadges = (keep.qualityBadges + loose.qualityBadges).distinct(),
                    genres = (keep.genres + loose.genres).distinct(),
                    versions = keep.versions + loose.versions,
                    posterUrl = keep.posterUrl.ifBlank { loose.posterUrl },
                    rating = maxOf(keep.rating, loose.rating),
                    addedTimestamp = maxOf(keep.addedTimestamp, loose.addedTimestamp)
                )
            }
        }

        // Save in memory-safe chunks of 500
        var totalNew = 0
        val allUnique = dedupMap.values.toList()
        for (chunk in allUnique.chunked(500)) {
            totalNew += db.upsertMediaBatch(chunk, markNewIfInserted = markNew)
        }
        return totalNew
    }

    private fun streamAndSaveLiveChannels(url: String, categoryMap: Map<String, String>) {
        val req = Request.Builder().url(url).header("User-Agent", "StreamVaultTV/1.0").build()
        val batch = mutableListOf<LiveChannel>()
        httpClient.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) return
            val stream = resp.body?.byteStream() ?: return
            val reader = JsonReader(InputStreamReader(stream, Charsets.UTF_8))
            if (reader.peek() != JsonToken.BEGIN_ARRAY) return
            reader.beginArray()
            while (reader.hasNext()) {
                if (reader.peek() != JsonToken.BEGIN_OBJECT) {
                    reader.skipValue()
                    continue
                }
                var streamId = ""
                var name = ""
                var icon = ""
                var catId = ""
                var epgId = ""
                reader.beginObject()
                while (reader.hasNext()) {
                    when (reader.nextName()) {
                        "stream_id" -> streamId = reader.nextStringOrNumber()
                        "name" -> name = reader.nextStringOrNumber()
                        "stream_icon" -> icon = reader.nextStringOrNumber()
                        "category_id" -> catId = reader.nextStringOrNumber()
                        "epg_channel_id" -> epgId = reader.nextStringOrNumber()
                        else -> reader.skipValue()
                    }
                }
                reader.endObject()
                if (streamId.isNotBlank() && name.isNotBlank()) {
                    batch.add(
                        LiveChannel(
                            streamId = streamId,
                            name = name.trim(),
                            logoUrl = icon,
                            categoryId = catId,
                            categoryName = categoryMap[catId] ?: "Live TV",
                            epgChannelId = epgId
                        )
                    )
                    if (batch.size >= 500) {
                        db.upsertLiveChannels(batch)
                        batch.clear()
                    }
                }
            }
            reader.endArray()
        }
        if (batch.isNotEmpty()) {
            db.upsertLiveChannels(batch)
        }
    }

    /**
     * Background Worker that enriches 100% of the catalog via TMDB API
     * (prioritizing preferred languages + newest/highest rated items first).
     * Never touches the user's IPTV server unless a regional item is missing from TMDB
     * AND no video playback is currently active.
     */
    /** App start: if the last enrichment was cut short (app closed, TV switched off), carry on where it stopped. */
    fun resumeEnrichmentIfNeeded() {
        val (enriched, total) = db.getEnrichmentCounts()
        if (total > 0 && enriched < total) startBackgroundTmdbEnrichment()
    }

    fun startBackgroundTmdbEnrichment(onProgress: () -> Unit = {}) {
        if (enrichJob?.isActive == true) return
        enrichJob = scope.launch(Dispatchers.IO) {
            val creds = prefs.loadCredentials()
            val apiKey = creds.tmdbApiKey.ifBlank { XtreamCredentials.DEFAULT_TMDB_KEY }

            while (isActive) {
                val queue = db.getUnenrichedMediaQueue(creds.preferredLanguages, limit = 150)
                if (queue.isEmpty()) {
                    val (enriched, total) = db.getEnrichmentCounts()
                    _syncState.value = _syncState.value.copy(
                        phase = "100% Catalog Enriched ($enriched Titles Ready)",
                        enrichedCount = enriched,
                        totalToEnrich = total
                    )
                    break
                }

                var updatedInBatch = 0
                val enrichedBatch = mutableListOf<MediaItem>()
                for (item in queue) {
                    if (!isActive) break
                    val enrichedOk = enrichSingleItemFromTmdb(item, apiKey)
                    if (!enrichedOk && !prefs.isPlaybackActive.get() && creds.isConfigured) {
                        // Gentle fallback to IPTV server VOD info only when not playing video
                        enrichFallbackFromXtreamServer(item, creds)
                        delay(1500) // Safe 1.5s trickle delay for IPTV fallback
                    } else {
                        delay(30) // ~33 requests/sec to TMDB (well within TMDB's 40-50 req/sec limit)
                    }
                    val updatedItem = db.getItemByDedupKey(item.dedupKey)
                    if (updatedItem != null) {
                        enrichedBatch.add(updatedItem)
                    }
                    updatedInBatch++
                    if (updatedInBatch % 25 == 0) {
                        val (enriched, total) = db.getEnrichmentCounts()
                        _syncState.value = _syncState.value.copy(
                            phase = "TMDB Enriching: $enriched / $total Titles",
                            enrichedCount = enriched,
                            totalToEnrich = total
                        )
                        if (enrichedBatch.isNotEmpty()) {
                            uploadCatalogSyncBatch(enrichedBatch.toList())
                            enrichedBatch.clear()
                        }
                        onProgress()
                    }
                }
                if (enrichedBatch.isNotEmpty()) {
                    uploadCatalogSyncBatch(enrichedBatch.toList())
                    enrichedBatch.clear()
                }
                onProgress()
            }
        }
    }

    fun uploadCatalogSyncBatch(items: List<MediaItem>) {
        val token = prefs.getAuthToken()?.takeIf { it.isNotBlank() } ?: return
        val cloudBase = prefs.getCloudSyncBaseUrl()

        items.chunked(25).forEach { chunk ->
            var attempt = 0
            var success = false
            val payload = JSONObject().apply {
                put("playlistId", "primary")
                val arr = JSONArray()
                chunk.forEach { it ->
                    arr.put(JSONObject().apply {
                        put("dedupKey", it.dedupKey)
                        put("mediaType", it.mediaType.name)
                        put("title", it.cleanTitle)
                        put("cleanTitle", it.cleanTitle)
                        put("year", it.year)
                        put("tmdbId", it.tmdbId)
                        put("overview", it.plot)
                        put("posterPath", it.posterUrl)
                        put("backdropPath", it.backdropUrl)
                        put("rating", it.rating)
                        put("runtimeMins", it.runtimeMins)
                        put("genres", JSONArray(it.genres))
                        put("versions", JSONArray(it.versions.map { v ->
                            JSONObject().apply {
                                put("streamId", v.streamId)
                                put("name", v.rawTitle)
                                put("language", v.languageTag)
                                put("quality", v.qualityTag)
                            }
                        }))
                        put("isAdult", it.isAdult)
                    })
                }
                put("items", arr)
            }.toString()

            while (attempt < 3 && !success) {
                attempt++
                try {
                    val req = Request.Builder()
                        .url("$cloudBase/api/catalog/sync-batch")
                        .header("Authorization", "Bearer $token")
                        .header("Content-Type", "application/json")
                        .post(payload.toRequestBody("application/json".toMediaTypeOrNull()))
                        .build()
                    httpClient.newCall(req).execute().use { resp ->
                        if (resp.isSuccessful) {
                            success = true
                        } else if (resp.code == 401) {
                            return
                        }
                    }
                } catch (e: Exception) {
                    if (attempt < 3) {
                        Thread.sleep(1000L * attempt)
                    }
                }
            }
        }
    }

    fun markCatalogTitlesRemoved(dedupKeys: List<String>) {
        val token = prefs.getAuthToken()?.takeIf { it.isNotBlank() } ?: return
        val cloudBase = prefs.getCloudSyncBaseUrl()
        if (dedupKeys.isEmpty()) return
        dedupKeys.chunked(50).forEach { chunk ->
            try {
                val payload = JSONObject().apply {
                    put("dedupKeys", JSONArray(chunk))
                }.toString()
                val req = Request.Builder()
                    .url("$cloudBase/api/catalog/mark-removed")
                    .header("Authorization", "Bearer $token")
                    .header("Content-Type", "application/json")
                    .post(payload.toRequestBody("application/json".toMediaTypeOrNull()))
                    .build()
                httpClient.newCall(req).execute().close()
            } catch (_: Exception) {}
        }
    }

    fun pullCatalogFromCloud(onProgress: (Int, Int) -> Unit = { _, _ -> }): Int {
        val token = prefs.getAuthToken()?.takeIf { it.isNotBlank() } ?: return 0
        val cloudBase = prefs.getCloudSyncBaseUrl()
        var offset = 0
        val limit = 100
        var hasMore = true
        var totalImported = 0

        while (hasMore) {
            val url = "$cloudBase/api/catalog/pull?limit=$limit&offset=$offset"
            val req = Request.Builder()
                .url(url)
                .header("Authorization", "Bearer $token")
                .build()

            try {
                val (items, total, more) = httpClient.newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) return totalImported
                    val json = JSONObject(resp.body?.string() ?: "{}")
                    val itemsArr = json.optJSONArray("items") ?: JSONArray()
                    val totalCount = json.optInt("total", 0)
                    val moreFlag = json.optBoolean("hasMore", false)
                    val parsedItems = mutableListOf<MediaItem>()
                    for (i in 0 until itemsArr.length()) {
                        val it = itemsArr.getJSONObject(i)
                        if (it.optBoolean("isRemoved", false)) continue
                        val dedupKey = it.optString("dedupKey")
                        if (dedupKey.isBlank()) continue
                        val genresArr = it.optJSONArray("genres") ?: JSONArray()
                        val genresList = (0 until genresArr.length()).map { g -> genresArr.getString(g) }
                        val versionsArr = it.optJSONArray("versions") ?: JSONArray()
                        val versionsList = mutableListOf<StreamVersion>()
                        for (v in 0 until versionsArr.length()) {
                            val vObj = versionsArr.getJSONObject(v)
                            versionsList.add(
                                StreamVersion(
                                    streamId = vObj.optString("streamId"),
                                    rawTitle = vObj.optString("name", vObj.optString("rawTitle")),
                                    languageTag = vObj.optString("language", vObj.optString("languageTag", "English")),
                                    qualityTag = vObj.optString("quality", vObj.optString("qualityTag", "HD")),
                                    subtitleTag = "",
                                    containerExtension = "mp4",
                                    categoryId = "",
                                    categoryName = "",
                                    addedTimestamp = 0L
                                )
                            )
                        }
                        parsedItems.add(
                            MediaItem(
                                dedupKey = dedupKey,
                                primaryStreamId = versionsList.firstOrNull()?.streamId ?: "",
                                tmdbId = it.optInt("tmdbId", 0),
                                mediaType = if (it.optString("mediaType").equals("SERIES", ignoreCase = true)) MediaType.SERIES else MediaType.MOVIE,
                                cleanTitle = it.optString("cleanTitle", it.optString("title")),
                                rawTitle = it.optString("title"),
                                year = it.optInt("year", 0),
                                rating = it.optDouble("rating", 0.0),
                                plot = it.optString("overview", ""),
                                posterUrl = it.optString("posterPath", ""),
                                backdropUrl = it.optString("backdropPath", ""),
                                runtimeMins = it.optInt("runtimeMins", 0),
                                genres = genresList,
                                isEnriched = it.optInt("tmdbId", 0) > 0,
                                versions = versionsList,
                                isAdult = it.optBoolean("isAdult", false)
                            )
                        )
                    }
                    Triple(parsedItems, totalCount, moreFlag)
                }

                if (items.isNotEmpty()) {
                    db.upsertMediaBatch(items, markNewIfInserted = false)
                    totalImported += items.size
                    onProgress(totalImported, total)
                }

                hasMore = more && items.isNotEmpty()
                offset += limit
            } catch (e: Exception) {
                break
            }
        }
        return totalImported
    }

    private fun enrichSingleItemFromTmdb(item: MediaItem, apiKey: String): Boolean {
        return try {
            val endpointType = if (item.mediaType == MediaType.SERIES) "tv" else "movie"
            var resolvedTmdbId = item.tmdbId
            val token = prefs.getAuthToken() ?: ""
            val cloudBase = prefs.getCloudSyncBaseUrl()
            val useWorkerProxy = apiKey.isBlank() || apiKey == XtreamCredentials.DEFAULT_TMDB_KEY

            // Step 1: If no TMDB ID was supplied by IPTV vendor, search TMDB by cleanTitle + year
            if (resolvedTmdbId <= 0) {
                val q = URLEncoder.encode(item.cleanTitle, "UTF-8")
                val yearParam = if (item.year > 1900) {
                    if (item.mediaType == MediaType.SERIES) "&first_air_date_year=${item.year}" else "&year=${item.year}"
                } else ""
                val searchUrl = if (useWorkerProxy) {
                    "$cloudBase/api/tmdb/search/$endpointType?query=$q$yearParam"
                } else {
                    "https://api.themoviedb.org/3/search/$endpointType?api_key=$apiKey&query=$q$yearParam"
                }
                val reqBuilder = Request.Builder().url(searchUrl)
                if (useWorkerProxy && token.isNotBlank()) {
                    reqBuilder.header("Authorization", "Bearer $token")
                }
                httpClient.newCall(reqBuilder.build()).execute().use { resp ->
                    if (resp.code == 429) {
                        Thread.sleep(1200) // Respect rate limit backoff
                        return false
                    }
                    if (!resp.isSuccessful) return false
                    val json = JSONObject(resp.body?.string() ?: "{}")
                    val results = json.optJSONArray("results")
                    if (results != null && results.length() > 0) {
                        val first = results.getJSONObject(0)
                        resolvedTmdbId = first.optInt("id", 0)
                    }
                }
            }

            if (resolvedTmdbId <= 0) {
                // Mark enriched with inferred genres so we don't loop infinitely
                db.updateEnrichedMetadata(
                    dedupKey = item.dedupKey,
                    tmdbId = 0,
                    imdbId = item.imdbId,
                    year = item.year,
                    rating = item.rating,
                    voteCount = item.voteCount,
                    genres = item.genres.ifEmpty { listOf("General") },
                    plot = item.plot,
                    cast = item.cast,
                    director = item.director,
                    runtimeMins = item.runtimeMins,
                    posterUrl = item.posterUrl,
                    backdropUrl = item.backdropUrl,
                    language = item.language,
                    hasEmbeddedSubs = item.hasEmbeddedSubtitles,
                    embeddedSubLangs = item.embeddedSubtitleLanguages,
                    embeddedAudioLangs = item.embeddedAudioLanguages,
                    certification = item.certification
                )
                return false
            }

            // Step 2: Fetch full TMDB Details + Credits (Cast & Director) + External IDs (IMDb ID) in 1 call!
            val detailUrl = if (useWorkerProxy) {
                "$cloudBase/api/tmdb/$endpointType/$resolvedTmdbId?append_to_response=credits,external_ids,release_dates,content_ratings"
            } else {
                "https://api.themoviedb.org/3/$endpointType/$resolvedTmdbId?api_key=$apiKey&append_to_response=credits,external_ids,release_dates,content_ratings"
            }
            val reqBuilder = Request.Builder().url(detailUrl)
            if (useWorkerProxy && token.isNotBlank()) {
                reqBuilder.header("Authorization", "Bearer $token")
            }
            httpClient.newCall(reqBuilder.build()).execute().use { resp ->
                if (resp.code == 429) {
                    Thread.sleep(1200)
                    return false
                }
                if (!resp.isSuccessful) return false
                val obj = JSONObject(resp.body?.string() ?: "{}")

                val plot = obj.optString("overview", item.plot)
                val rating = obj.optDouble("vote_average", item.rating)
                val voteCount = obj.optInt("vote_count", item.voteCount)
                val runtime = obj.optInt("runtime", 0).let { rt ->
                    if (rt > 0) rt else obj.optJSONArray("episode_run_time")?.optInt(0, 0) ?: 0
                }
                val releaseDate = obj.optString("release_date").ifBlank { obj.optString("first_air_date") }
                val year = releaseDate.take(4).toIntOrNull() ?: item.year
                val origLangCode = obj.optString("original_language", "en")
                val resolvedLang = isoLangMap[origLangCode] ?: item.language

                val genresList = mutableListOf<String>()
                obj.optJSONArray("genres")?.let { gArr ->
                    for (i in 0 until gArr.length()) {
                        val gObj = gArr.getJSONObject(i)
                        val gId = gObj.optInt("id")
                        val gName = tmdbGenreMap[gId] ?: gObj.optString("name")
                        if (gName.isNotBlank()) genresList.add(gName)
                    }
                }

                val castList = mutableListOf<String>()
                var directorName = item.director
                obj.optJSONObject("credits")?.let { credits ->
                    credits.optJSONArray("cast")?.let { cArr ->
                        for (i in 0 until minOf(8, cArr.length())) {
                            val actor = cArr.getJSONObject(i).optString("name")
                            if (actor.isNotBlank()) castList.add(actor)
                        }
                    }
                    credits.optJSONArray("crew")?.let { crewArr ->
                        for (i in 0 until crewArr.length()) {
                            val member = crewArr.getJSONObject(i)
                            if (member.optString("job").equals("Director", ignoreCase = true)) {
                                directorName = member.optString("name")
                                break
                            }
                        }
                    }
                }

                val imdbId = obj.optString("imdb_id").ifBlank {
                    obj.optJSONObject("external_ids")?.optString("imdb_id") ?: ""
                }

                var certification = item.certification
                if (endpointType == "movie") {
                    obj.optJSONObject("release_dates")?.optJSONArray("results")?.let { results ->
                        for (i in 0 until results.length()) {
                            val rObj = results.getJSONObject(i)
                            if (rObj.optString("iso_3166_1").equals("US", ignoreCase = true)) {
                                val dates = rObj.optJSONArray("release_dates")
                                if (dates != null && dates.length() > 0) {
                                    for (j in 0 until dates.length()) {
                                        val cert = dates.getJSONObject(j).optString("certification")
                                        if (cert.isNotBlank()) {
                                            certification = cert
                                            break
                                        }
                                    }
                                }
                                if (certification.isNotBlank()) break
                            }
                        }
                    }
                } else {
                    obj.optJSONObject("content_ratings")?.optJSONArray("results")?.let { results ->
                        for (i in 0 until results.length()) {
                            val rObj = results.getJSONObject(i)
                            if (rObj.optString("iso_3166_1").equals("US", ignoreCase = true)) {
                                val cert = rObj.optString("rating")
                                if (cert.isNotBlank()) {
                                    certification = cert
                                    break
                                }
                            }
                        }
                    }
                }

                val posterPath = obj.optString("poster_path")
                val backdropPath = obj.optString("backdrop_path")
                val fullPoster = if (posterPath.startsWith("/")) "https://image.tmdb.org/t/p/w500$posterPath" else item.posterUrl
                val fullBackdrop = if (backdropPath.startsWith("/")) "https://image.tmdb.org/t/p/w1280$backdropPath" else item.backdropUrl

                db.updateEnrichedMetadata(
                    dedupKey = item.dedupKey,
                    tmdbId = resolvedTmdbId,
                    imdbId = imdbId,
                    year = year,
                    rating = rating,
                    voteCount = voteCount,
                    genres = genresList,
                    plot = plot,
                    cast = castList,
                    director = directorName,
                    runtimeMins = runtime,
                    posterUrl = fullPoster,
                    backdropUrl = fullBackdrop,
                    language = resolvedLang,
                    hasEmbeddedSubs = item.hasEmbeddedSubtitles,
                    embeddedSubLangs = item.embeddedSubtitleLanguages,
                    embeddedAudioLangs = item.embeddedAudioLanguages,
                    certification = certification
                )
                true
            }
        } catch (_: Exception) {
            false
        }
    }

    private fun enrichFallbackFromXtreamServer(item: MediaItem, creds: XtreamCredentials) {
        if (item.mediaType != MediaType.MOVIE) return
        runCatching {
            val url = "${creds.normalizedServerUrl}/player_api.php?username=${
                URLEncoder.encode(creds.username, "UTF-8")
            }&password=${URLEncoder.encode(creds.password, "UTF-8")}&action=get_vod_info&vod_id=${item.primaryStreamId}"
            val req = Request.Builder().url(url).build()
            httpClient.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return
                val root = JSONObject(resp.body?.string() ?: "{}")
                val info = root.optJSONObject("info") ?: return
                val plot = info.optString("plot").ifBlank { info.optString("description", item.plot) }
                val genreStr = info.optString("genre", "")
                val genres = genreStr.split(",", "/").map { it.trim() }.filter { it.isNotBlank() }
                val cast = info.optString("cast", "").split(",").map { it.trim() }.filter { it.isNotBlank() }
                val director = info.optString("director", item.director)
                val durationSecs = info.optInt("duration_secs", 0)

                db.updateEnrichedMetadata(
                    dedupKey = item.dedupKey,
                    tmdbId = info.optInt("tmdb_id", item.tmdbId),
                    imdbId = item.imdbId,
                    year = item.year,
                    rating = info.optDouble("rating", item.rating),
                    voteCount = item.voteCount,
                    genres = genres.ifEmpty { item.genres.ifEmpty { listOf("General") } },
                    plot = plot,
                    cast = cast,
                    director = director,
                    runtimeMins = if (durationSecs > 0) durationSecs / 60 else item.runtimeMins,
                    posterUrl = item.posterUrl,
                    backdropUrl = item.backdropUrl,
                    language = item.language,
                    hasEmbeddedSubs = item.hasEmbeddedSubtitles,
                    embeddedSubLangs = item.embeddedSubtitleLanguages,
                    embeddedAudioLangs = item.embeddedAudioLanguages
                )
            }
        }
    }

    /**
     * Auto-refreshes Series Episodes from the IPTV server when the user opens a Series detail page.
     */
    suspend fun fetchSeriesEpisodesOnDemand(seriesItem: MediaItem): List<SeriesEpisode> = withContext(Dispatchers.IO) {
        val creds = prefs.loadCredentials()
        if (!creds.isConfigured) {
            return@withContext db.getSeriesEpisodes(seriesItem.primaryStreamId)
        }
        runCatching {
            val url = "${creds.normalizedServerUrl}/player_api.php?username=${
                URLEncoder.encode(creds.username, "UTF-8")
            }&password=${URLEncoder.encode(creds.password, "UTF-8")}&action=get_series_info&series_id=${seriesItem.primaryStreamId}"
            val req = Request.Builder().url(url).build()
            httpClient.newCall(req).execute().use { resp ->
                if (resp.isSuccessful) {
                    val root = JSONObject(resp.body?.string() ?: "{}")
                    val episodesObj = root.optJSONObject("episodes")
                    if (episodesObj != null) {
                        val parsedEpisodes = mutableListOf<SeriesEpisode>()
                        val seasonKeys = episodesObj.keys()
                        while (seasonKeys.hasNext()) {
                            val sKey = seasonKeys.next()
                            val epArr = episodesObj.optJSONArray(sKey) ?: continue
                            for (i in 0 until epArr.length()) {
                                val ep = epArr.getJSONObject(i)
                                val info = ep.optJSONObject("info")
                                parsedEpisodes.add(
                                    SeriesEpisode(
                                        episodeId = ep.optString("id"),
                                        seriesId = seriesItem.primaryStreamId,
                                        seasonNumber = ep.optInt("season", sKey.toIntOrNull() ?: 1),
                                        episodeNumber = ep.optInt("episode_num", i + 1),
                                        title = ep.optString("title", "Episode ${i + 1}"),
                                        plot = info?.optString("plot") ?: "",
                                        durationSecs = info?.optInt("duration_secs") ?: 0,
                                        containerExtension = ep.optString("container_extension", "mp4"),
                                        thumbnailUrl = info?.optString("movie_image") ?: seriesItem.posterUrl
                                    )
                                )
                            }
                        }
                        if (parsedEpisodes.isNotEmpty()) {
                            db.saveSeriesEpisodes(seriesItem.primaryStreamId, parsedEpisodes)
                        }
                    }
                }
            }
        }
        db.getSeriesEpisodes(seriesItem.primaryStreamId)
    }

    /**
     * Seeds a rich showcase catalog when the app first launches before IPTV credentials are entered,
     * allowing instant testing of Super-Filters, Deduplicated Versions, Smart Rows, and Subtitles.
     */
    fun seedSampleShowcaseCatalogIfEmpty() {
        val (_, total) = db.getEnrichmentCounts()
        if (total > 0) return

        val sampleMovies = listOf(
            MediaItem(
                dedupKey = "tmdb:693134",
                primaryStreamId = "1001",
                tmdbId = 693134,
                imdbId = "tt15239678",
                mediaType = MediaType.MOVIE,
                cleanTitle = "Dune: Part Two",
                rawTitle = "|EN| [4K-HEVC] Dune: Part Two (2024) [MULTI-SUB]",
                year = 2024,
                rating = 8.4,
                voteCount = 5400,
                genres = listOf("Sci-Fi", "Adventure", "Action", "Drama"),
                plot = "Follow the mythic journey of Paul Atreides as he unites with Chani and the Fremen while on a warpath of revenge against the conspirators who destroyed his family.",
                cast = listOf("Timothée Chalamet", "Zendaya", "Rebecca Ferguson", "Javier Bardem", "Austin Butler"),
                director = "Denis Villeneuve",
                runtimeMins = 166,
                posterUrl = "https://image.tmdb.org/t/p/w500/1pdfLvkbY9ohJlCjQH2CZjjYVvJ.jpg",
                backdropUrl = "https://image.tmdb.org/t/p/w1280/xOMo8BRK7PfcJv9JCnx7s5hj0PX.jpg",
                language = "English",
                qualityBadges = listOf("4K", "HEVC", "HDR", "1080p"),
                hasEmbeddedSubtitles = true,
                embeddedSubtitleLanguages = listOf("English", "Arabic", "Spanish"),
                hasOnlineSubtitles = true,
                embeddedAudioLanguages = listOf("English", "Hindi"),
                categoryName = "2024 4K UHD Releases",
                addedTimestamp = System.currentTimeMillis() / 1000,
                isEnriched = true,
                versions = listOf(
                    StreamVersion("1001", "|EN| [4K-HEVC] Dune: Part Two (2024) [MULTI-SUB]", "English", "4K HEVC HDR", "Multi-Sub", "mkv", "1", "4K UHD", 1710000000L),
                    StreamVersion("1002", "EN - Dune: Part Two (2024) 1080p FHD", "English", "1080p FHD", "English Sub", "mp4", "2", "2024 Movies", 1710000000L),
                    StreamVersion("1003", "HI - Dune: Part Two (2024) Dual Audio", "Hindi", "1080p Dual-Audio", "English Sub", "mkv", "3", "Hindi Dubbed", 1710000000L)
                )
            ),
            MediaItem(
                dedupKey = "tmdb:872585",
                primaryStreamId = "1004",
                tmdbId = 872585,
                imdbId = "tt15398776",
                mediaType = MediaType.MOVIE,
                cleanTitle = "Oppenheimer",
                rawTitle = "EN - Oppenheimer (2023) 4K UHD",
                year = 2023,
                rating = 8.1,
                voteCount = 8200,
                genres = listOf("Drama", "History", "Thriller"),
                plot = "The story of J. Robert Oppenheimer's role in the development of the atomic bomb during World War II.",
                cast = listOf("Cillian Murphy", "Emily Blunt", "Matt Damon", "Robert Downey Jr.", "Florence Pugh"),
                director = "Christopher Nolan",
                runtimeMins = 181,
                posterUrl = "https://image.tmdb.org/t/p/w500/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg",
                backdropUrl = "https://image.tmdb.org/t/p/w1280/fm6KqXpk3M2HVveHwCrBSSBaO0V.jpg",
                language = "English",
                qualityBadges = listOf("4K", "1080p"),
                hasEmbeddedSubtitles = true,
                embeddedSubtitleLanguages = listOf("English", "Urdu"),
                hasOnlineSubtitles = true,
                embeddedAudioLanguages = listOf("English", "Hindi"),
                categoryName = "Oscars Winners",
                addedTimestamp = System.currentTimeMillis() / 1000 - 3600,
                isEnriched = true,
                versions = listOf(
                    StreamVersion("1004", "EN - Oppenheimer (2023) 4K UHD", "English", "4K UHD", "Multi-Sub", "mkv", "1", "4K UHD", 1700000000L),
                    StreamVersion("1005", "HI - Oppenheimer (2023) 1080p", "Hindi", "1080p", "English Sub", "mp4", "3", "Hindi Dubbed", 1700000000L)
                )
            ),
            MediaItem(
                dedupKey = "tmdb:157336",
                primaryStreamId = "1006",
                tmdbId = 157336,
                imdbId = "tt0816692",
                mediaType = MediaType.MOVIE,
                cleanTitle = "Interstellar",
                rawTitle = "EN - Interstellar (2014) [4K HEVC]",
                year = 2014,
                rating = 8.7,
                voteCount = 34000,
                genres = listOf("Sci-Fi", "Drama", "Adventure"),
                plot = "The adventures of a group of explorers who make use of a newly discovered wormhole to surpass the limitations on human space travel and conquer the vast distances involved in an interstellar voyage.",
                cast = listOf("Matthew McConaughey", "Anne Hathaway", "Jessica Chastain", "Michael Caine", "Matt Damon"),
                director = "Christopher Nolan",
                runtimeMins = 169,
                posterUrl = "https://image.tmdb.org/t/p/w500/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg",
                backdropUrl = "https://image.tmdb.org/t/p/w1280/xJHokMbljvjADYdit5fK5VQsXEG.jpg",
                language = "English",
                qualityBadges = listOf("4K", "HEVC", "1080p"),
                hasEmbeddedSubtitles = true,
                embeddedSubtitleLanguages = listOf("English", "Arabic"),
                hasOnlineSubtitles = true,
                embeddedAudioLanguages = listOf("English"),
                categoryName = "2014 Classics",
                addedTimestamp = System.currentTimeMillis() / 1000 - 7200,
                isEnriched = true,
                versions = listOf(
                    StreamVersion("1006", "EN - Interstellar (2014) [4K HEVC]", "English", "4K HEVC", "English Sub", "mkv", "4", "Sci-Fi Classics", 1690000000L)
                )
            ),
            MediaItem(
                dedupKey = "tmdb:27205",
                primaryStreamId = "1007",
                tmdbId = 27205,
                imdbId = "tt1375666",
                mediaType = MediaType.MOVIE,
                cleanTitle = "Inception",
                rawTitle = "EN - Inception (2010) 1080p BluRay",
                year = 2010,
                rating = 8.8,
                voteCount = 36000,
                genres = listOf("Action", "Sci-Fi", "Thriller", "Adventure"),
                plot = "Cobb, a skilled thief who commits corporate espionage by infiltrating the subconscious of his targets is offered a chance to regain his old life as payment for a task considered to be impossible: inception.",
                cast = listOf("Leonardo DiCaprio", "Joseph Gordon-Levitt", "Ken Watanabe", "Tom Hardy", "Cillian Murphy"),
                director = "Christopher Nolan",
                runtimeMins = 148,
                posterUrl = "https://image.tmdb.org/t/p/w500/oYuLEt3zVCKq57qu2F8dT7NIa6f.jpg",
                backdropUrl = "https://image.tmdb.org/t/p/w1280/8ZTVqvKDQ8emSGUEMjsS4yHAwrp.jpg",
                language = "English",
                qualityBadges = listOf("1080p", "4K"),
                hasEmbeddedSubtitles = true,
                embeddedSubtitleLanguages = listOf("English", "Urdu", "Hindi"),
                hasOnlineSubtitles = true,
                embeddedAudioLanguages = listOf("English", "Hindi"),
                categoryName = "Top Rated",
                addedTimestamp = System.currentTimeMillis() / 1000 - 10000,
                isEnriched = true,
                versions = listOf(
                    StreamVersion("1007", "EN - Inception (2010) 4K HDR", "English", "4K HDR", "Multi-Sub", "mkv", "1", "4K UHD", 1680000000L),
                    StreamVersion("1008", "HI - Inception (2010) Dual Audio", "Hindi", "1080p", "English Sub", "mp4", "3", "Hindi Dubbed", 1680000000L)
                )
            ),
            MediaItem(
                dedupKey = "tmdb:155",
                primaryStreamId = "1009",
                tmdbId = 155,
                imdbId = "tt0468569",
                mediaType = MediaType.MOVIE,
                cleanTitle = "The Dark Knight",
                rawTitle = "EN - The Dark Knight (2008) [4K UHD]",
                year = 2008,
                rating = 9.0,
                voteCount = 32000,
                genres = listOf("Action", "Crime", "Drama", "Thriller"),
                plot = "Batman raises the stakes in his war on crime. With the help of Lt. Jim Gordon and District Attorney Harvey Dent, Batman sets out to dismantle the remaining criminal organizations that plague the streets.",
                cast = listOf("Christian Bale", "Heath Ledger", "Aaron Eckhart", "Michael Caine", "Gary Oldman"),
                director = "Christopher Nolan",
                runtimeMins = 152,
                posterUrl = "https://image.tmdb.org/t/p/w500/qJ2tW6WMUDux911r6m7haRef0WH.jpg",
                backdropUrl = "https://image.tmdb.org/t/p/w1280/nMKdUUepR0i5zn0y1T4CsSB5chy.jpg",
                language = "English",
                qualityBadges = listOf("4K", "1080p"),
                hasEmbeddedSubtitles = true,
                embeddedSubtitleLanguages = listOf("English"),
                hasOnlineSubtitles = true,
                embeddedAudioLanguages = listOf("English", "Hindi"),
                categoryName = "2008 Releases",
                addedTimestamp = System.currentTimeMillis() / 1000 - 14000,
                isEnriched = true,
                versions = listOf(
                    StreamVersion("1009", "EN - The Dark Knight (2008) [4K UHD]", "English", "4K UHD", "Multi-Sub", "mkv", "1", "2008 Releases", 1670000000L)
                )
            ),
            MediaItem(
                dedupKey = "tmdb:98",
                primaryStreamId = "1010",
                tmdbId = 98,
                imdbId = "tt0172495",
                mediaType = MediaType.MOVIE,
                cleanTitle = "Gladiator",
                rawTitle = "EN - Gladiator (2000) Extended 4K",
                year = 2000,
                rating = 8.5,
                voteCount = 19000,
                genres = listOf("Action", "Drama", "Adventure", "History"),
                plot = "In the year 180, the death of emperor Marcus Aurelius throws the Roman Empire into chaos. Maximus isplet betrayed and reduced to slavery, rising through the gladiatorial ranks to avenge his family.",
                cast = listOf("Russell Crowe", "Joaquin Phoenix", "Connie Nielsen", "Oliver Reed"),
                director = "Ridley Scott",
                runtimeMins = 155,
                posterUrl = "https://image.tmdb.org/t/p/w500/ty8TGRuvJLPUmAR1H1nRIsgwvim.jpg",
                backdropUrl = "https://image.tmdb.org/t/p/w1280/Ar7QuJ7sJEiC0oP3I8fG8QD9uGn.jpg",
                language = "English",
                qualityBadges = listOf("4K", "1080p"),
                hasEmbeddedSubtitles = true,
                embeddedSubtitleLanguages = listOf("English", "Arabic"),
                hasOnlineSubtitles = true,
                embeddedAudioLanguages = listOf("English"),
                categoryName = "2000 Movies",
                addedTimestamp = System.currentTimeMillis() / 1000 - 20000,
                isEnriched = true,
                versions = listOf(
                    StreamVersion("1010", "EN - Gladiator (2000) Extended 4K", "English", "4K UHD", "Multi-Sub", "mkv", "1", "2000 Movies", 1660000000L)
                )
            ),
            MediaItem(
                dedupKey = "tmdb:1396",
                primaryStreamId = "2001",
                tmdbId = 1396,
                imdbId = "tt0903747",
                mediaType = MediaType.SERIES,
                cleanTitle = "Breaking Bad",
                rawTitle = "EN - Breaking Bad (2008) Complete Series FHD",
                year = 2008,
                rating = 9.5,
                voteCount = 14000,
                genres = listOf("Crime", "Drama", "Thriller"),
                plot = "Walter White, a New Mexico chemistry teacher, is diagnosed with Stage III cancer and given a prognosis of only two years left to live. He chooses to enter a dangerous world of drugs and crime.",
                cast = listOf("Bryan Cranston", "Aaron Paul", "Anna Gunn", "Bob Odenkirk", "Giancarlo Esposito"),
                director = "Vince Gilligan",
                runtimeMins = 47,
                posterUrl = "https://image.tmdb.org/t/p/w500/ztkUQFLlC19CCMYHW9o1zWhJRNq.jpg",
                backdropUrl = "https://image.tmdb.org/t/p/w1280/tsRy63Mu5cu8etL1X7ZLyf7UP1M.jpg",
                language = "English",
                qualityBadges = listOf("1080p", "HEVC"),
                hasEmbeddedSubtitles = true,
                embeddedSubtitleLanguages = listOf("English", "Spanish"),
                hasOnlineSubtitles = true,
                embeddedAudioLanguages = listOf("English"),
                categoryName = "Top TV Series",
                addedTimestamp = System.currentTimeMillis() / 1000 - 5000,
                isEnriched = true,
                versions = listOf(
                    StreamVersion("2001", "EN - Breaking Bad (2008) FHD", "English", "1080p", "English Sub", "mkv", "10", "Crime Series", 1705000000L)
                )
            )
        )
        db.upsertMediaBatch(sampleMovies, markNewIfInserted = false)
        db.saveSeriesEpisodes(
            "2001",
            listOf(
                SeriesEpisode("ep1", "2001", 1, 1, "Pilot", "Walter White embarks on a new life.", 3480, "mp4"),
                SeriesEpisode("ep2", "2001", 1, 2, "Cat's in the Bag...", "Walt and Jesse clean up the aftermath.", 2880, "mp4"),
                SeriesEpisode("ep3", "2001", 1, 3, "...And the Bag's in the River", "Walt faces an impossible choice.", 2880, "mp4")
            )
        )
        db.upsertLiveChannels(
            listOf(
                LiveChannel("live1", "BBC World News HD", "", "news", "News", "bbc.uk", "World News Today", "18:00 - 19:00", "The Context", true),
                LiveChannel("live2", "Sky Sports Main Event 4K", "", "sports", "Sports", "skysports.uk", "Premier League Live", "18:00 - 20:30", "Post-Match Analysis", true),
                LiveChannel("live3", "HBO HD", "", "movies", "Movies Live", "hbo.us", "Dune: Part Two", "17:30 - 20:15", "The Last of Us", false),
                LiveChannel("live4", "Geo News HD", "", "pk", "Pakistan / Urdu", "geo.pk", "Prime Time Headlines", "18:00 - 19:00", "Capital Talk", false)
            )
        )
    }

    private fun JsonReader.nextStringOrNumber(): String {
        return when (peek()) {
            JsonToken.STRING -> nextString()
            JsonToken.NUMBER -> nextString()
            JsonToken.BOOLEAN -> nextBoolean().toString()
            else -> {
                skipValue()
                ""
            }
        }
    }
}
