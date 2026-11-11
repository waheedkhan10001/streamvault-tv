package com.streamvault.tv.data

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

/**
 * High-performance In-App API Router for StreamVault TV.
 * Serves the identical /api REST contracts that tv-ui.html expects,
 * executing directly on the TCL 55P635 (Android TV 11) using SQLite and memory-safe streaming.
 */
class AppApiRouter(
    private val context: Context,
    private val db: StreamVaultDatabase,
    private val prefs: PreferencesManager,
    private val syncEngine: CatalogSyncEngine
) {

    fun handle(method: String, fullPath: String, bodyStr: String, authHeader: String? = null): String {
        val path = if (fullPath.contains("?")) fullPath.substringBefore("?") else fullPath
        val queryString = if (fullPath.contains("?")) fullPath.substringAfter("?") else ""
        val queryParams = parseQueryParams(queryString)

        val token = authHeader?.removePrefix("Bearer ")?.trim()?.takeIf { it.isNotBlank() }
        val hasSession = !token.isNullOrBlank() || prefs.hasActiveSession()

        // 6. Enforce in the native router too:
        // /api/playlists*, /api/save-credentials, /api/sync-now, /api/profiles* return 401 when there is no session.
        val isProtected = path.startsWith("/api/playlists") ||
                path == "/api/save-credentials" ||
                path == "/api/sync-now" ||
                path == "/api/clear-playlist" ||
                path.startsWith("/api/profiles")

        if (isProtected && !hasSession) {
            return """{"error":"Unauthorized - No active session","status":401,"ok":false}"""
        }

        return try {
            when {
                // 0. Session & Cloud Auth endpoints
                method == "POST" && (path == "/api/session" || path == "/api/auth/session") -> handleSetSession(bodyStr)
                (method == "DELETE" && (path == "/api/session" || path == "/api/auth/session")) ||
                    (method == "POST" && path == "/api/auth/signout") -> handleSignOut()

                // 1. App State Endpoint
                method == "GET" && path == "/api/state" -> handleGetState()

                // 2. Home Catalog Rows
                method == "GET" && path == "/api/home" -> handleGetHome()

                // 3. Super-Filter & Catalog Query
                (method == "POST" || method == "GET") && path == "/api/query" -> handleQuery(bodyStr, queryParams)

                // 4. Watchlist
                method == "GET" && path == "/api/watchlist" -> handleGetWatchlist()
                method == "POST" && (path == "/api/watchlist/toggle" || path == "/api/toggle-item") -> handleToggleWatchlist(bodyStr)

                // 5. Watched Toggle
                method == "POST" && path == "/api/watched/toggle" -> handleToggleWatched(bodyStr)

                // 6. Playback Progress
                method == "POST" && path == "/api/progress" -> handleSaveProgress(bodyStr)

                // 7. Star Rating
                method == "POST" && path == "/api/rate" -> handleSaveRate(bodyStr)

                // 8. Media Details (Movie / Series + Episodes + More Like This)
                method == "GET" && path == "/api/detail" -> handleGetDetail(queryParams)
                method == "GET" && path == "/api/probe-versions" -> handleProbeVersions(queryParams)
                method == "GET" && path == "/api/related" -> handleGetRelated(queryParams)

                // 9. Live TV
                method == "GET" && path == "/api/live" -> handleGetLive(queryParams)
                method == "GET" && path == "/api/latest" -> handleGetLatest()
                method == "POST" && path == "/api/live/favorite" -> handleToggleLiveFavorite(bodyStr)

                // 10. Search History
                method == "GET" && path == "/api/search-history" -> handleGetSearchHistory()
                method == "POST" && path == "/api/search-history" -> handleAddSearchHistory(bodyStr)
                method == "POST" && path == "/api/search-history/delete" -> handleDeleteSearchHistory(bodyStr)
                method == "POST" && path == "/api/search-history/clear" -> handleClearSearchHistory()

                // 11. Parental Controls & PIN
                method == "POST" && (path == "/api/parental-pin" || path == "/api/parental-control") -> handleParentalPin(bodyStr)

                // 12. Save Credentials & Trigger Sync
                method == "POST" && path == "/api/save-credentials" -> handleSaveCredentials(bodyStr)

                // 12b. Stream address (built here so the password never leaves the TV engine)
                method == "POST" && path == "/api/stream-url" -> handleStreamUrl(bodyStr)

                // 13. Trigger Sync Now
                method == "POST" && path == "/api/sync-now" -> handleSyncNow()
                method == "POST" && path == "/api/clear-playlist" -> handleClearPlaylist()
                method == "POST" && path == "/api/clear-crash" -> { prefs.lastCrash = null; """{"ok":true}""" }
                method == "POST" && path == "/api/catalog/pull-cloud" -> handlePullCloudCatalog()
                method == "GET" && path == "/api/sync/status" -> handleGetSyncStatus()

                // 14. Factory Reset
                method == "POST" && path == "/api/factory-reset" -> handleFactoryReset()

                // 15. Playlists Management
                method == "GET" && path == "/api/playlists" -> handleGetPlaylists()
                method == "POST" && path == "/api/playlists" -> handleAddPlaylist(bodyStr)
                method == "PUT" && path.startsWith("/api/playlists") -> handleUpdatePlaylist(bodyStr)
                method == "DELETE" && path.startsWith("/api/playlists") -> handleDeletePlaylist(path)

                // 16. Profiles Management (Native Room/SQLite + Scoped Data)
                method == "GET" && path == "/api/profiles" -> handleGetProfiles()
                method == "POST" && path == "/api/profiles/create" -> handleCreateProfile(bodyStr)
                method == "POST" && path == "/api/profiles/update" -> handleUpdateProfile(bodyStr)
                method == "POST" && path == "/api/profiles/delete" -> handleDeleteProfile(bodyStr)
                method == "POST" && path == "/api/profiles/switch" -> handleSwitchProfile(bodyStr)

                else -> """{"error":"Endpoint not found","path":"$path"}"""
            }
        } catch (e: Exception) {
            """{"error":"Internal error: ${e.message}","ok":false}"""
        }
    }

    private fun getActiveUserProfile(): UserProfile {
        val activeId = prefs.getActiveProfileId()
        val profiles = db.getProfiles(prefs.getAccountDisplayName())
        val found = if (activeId.isNotBlank()) profiles.find { it.id == activeId } else null
        if (found != null) return found
        val primary = profiles.find { it.isPrimary } ?: profiles.first()
        prefs.setActiveProfileId(primary.id)
        return primary
    }

    private fun handleGetState(): String {
        val creds = prefs.loadCredentials()
        val (enriched, total) = db.getEnrichmentCounts()
        val syncState = syncEngine.syncState.value
        val activeProf = getActiveUserProfile()
        val allProfiles = db.getProfiles(prefs.getAccountDisplayName())

        val credsObj = JSONObject().apply {
            put("playlistName", creds.playlistName)
            put("serverUrl", creds.serverUrl)
            put("username", creds.username)
            put("hasPassword", creds.password.isNotBlank())
            val primaryDisplayName = prefs.getAccountDisplayName().ifBlank { creds.playlistName.ifBlank { "User" } }
            put("displayName", primaryDisplayName)
        }

        val parentalObj = JSONObject().apply {
            put("isLocked", prefs.isParentalLocked())
            put("showAdult", prefs.isAdultVaultUnlocked())
            put("showExtras", prefs.isExtrasUnlocked())
            put("hasCustomPin", prefs.hasCustomParentalPin())
        }

        val syncObj = JSONObject().apply {
            put("isSyncing", syncState.isSyncing)
            put("phase", syncState.phase)
            put("newlyAddedCount", syncState.newlyAddedCount)
            put("totalMovies", total)
            put("totalSeries", 0)
            put("enrichedCount", enriched)
            put("percentComplete", if (total > 0) (enriched * 100) / total else 100)
            put("stage", syncState.stage)
            put("processedItems", syncState.processedItems)
            put("estimatedTotal", syncState.estimatedTotal)
            put("removedCount", syncState.removedCount)
            put("note", syncState.note ?: JSONObject.NULL)
            put("error", syncState.errorMessage ?: JSONObject.NULL)
            put("lastSyncTimestamp", prefs.lastFullSyncTimestamp)
        }

        val smartRowsArr = JSONArray()
        for (sr in db.getPinnedSmartRows()) {
            smartRowsArr.put(JSONObject().apply {
                put("id", sr.id)
                put("title", sr.title)
            })
        }

        val profArr = JSONArray()
        for (p in allProfiles) {
            profArr.put(p.toJson())
        }

        return JSONObject().apply {
            put("credentials", credsObj)
            put("parentalControl", parentalObj)
            put("syncStatus", syncObj)
            put("remoteSearchQuery", prefs.remoteSearchCommand.value ?: "")
            put("pinnedSmartRows", smartRowsArr)
            put("totalCatalogCount", total)
            put("lastCrash", prefs.lastCrash ?: JSONObject.NULL)
            put("totalLiveCount", db.countLiveChannels())
            put("localIpUrl", "http://127.0.0.1:8765/phone")
            put("activeProfile", activeProf.toJson())
            put("profiles", profArr)
        }.toString()
    }

    private fun handleGetHome(): String {
        val activeProf = getActiveUserProfile()
        val continueWatching = db.getContinueWatchingList(profileId = activeProf.id, isKids = activeProf.isKids, limit = 30)
        val allMovies = db.queryMedia(
            filter = SuperFilterState(minRating = 6.0, sortBy = SortOption.RELEASE_YEAR_DESC),
            limit = 60,
            profileId = activeProf.id,
            isKids = activeProf.isKids,
            isAdultVaultUnlocked = false,
            isVaultTab = false
        )

        val trending = db.queryMedia(
            filter = SuperFilterState(minRating = 6.8, sortBy = SortOption.RATING_DESC),
            limit = 10,
            profileId = activeProf.id,
            isKids = activeProf.isKids,
            isAdultVaultUnlocked = false,
            isVaultTab = false
        )

        val hollywood = db.queryMedia(
            filter = SuperFilterState(
                selectedLanguages = setOf("English", "Multi-Audio"),
                minRating = 6.0,
                sortBy = SortOption.RELEASE_YEAR_DESC
            ),
            limit = 28,
            profileId = activeProf.id,
            isKids = activeProf.isKids,
            isAdultVaultUnlocked = false,
            isVaultTab = false
        )

        val regional = db.queryMedia(
            filter = SuperFilterState(
                selectedLanguages = setOf("Hindi", "Urdu", "Punjabi", "Tamil", "Telugu", "Multi-Audio"),
                sortBy = SortOption.RELEASE_YEAR_DESC
            ),
            limit = 28,
            profileId = activeProf.id,
            isKids = activeProf.isKids,
            isAdultVaultUnlocked = false,
            isVaultTab = false
        )

        val actionThrillers = db.queryMedia(
            filter = SuperFilterState(
                includedGenres = setOf("Action", "Thriller"),
                minRating = 6.5,
                sortBy = SortOption.RATING_DESC
            ),
            limit = 24,
            profileId = activeProf.id,
            isKids = activeProf.isKids,
            isAdultVaultUnlocked = false,
            isVaultTab = false
        )

        val criticallyAcclaimed = db.queryMedia(
            filter = SuperFilterState(minRating = 8.0, sortBy = SortOption.RATING_DESC),
            limit = 24,
            profileId = activeProf.id,
            isKids = activeProf.isKids,
            isAdultVaultUnlocked = false,
            isVaultTab = false
        )

        val heroItem = hollywood.firstOrNull { it.backdropUrl.isNotBlank() && it.plot.isNotBlank() }
            ?: trending.firstOrNull { it.backdropUrl.isNotBlank() }
            ?: allMovies.firstOrNull()

        val rowsArr = JSONArray()

        if (continueWatching.isNotEmpty()) {
            rowsArr.put(JSONObject().apply {
                put("title", "Continue Watching")
                put("subtitle", "Resume from your exact timestamp")
                put("items", mediaListToJsonArray(continueWatching))
            })
        }

        if (trending.isNotEmpty()) {
            rowsArr.put(JSONObject().apply {
                put("title", "Top 10 Trending Today")
                put("subtitle", "")
                put("items", mediaListToJsonArray(trending))
            })
        }

        if (hollywood.isNotEmpty()) {
            rowsArr.put(JSONObject().apply {
                put("title", "Hollywood Blockbusters")
                put("subtitle", "")
                put("items", mediaListToJsonArray(hollywood))
            })
        }

        if (regional.isNotEmpty()) {
            rowsArr.put(JSONObject().apply {
                put("title", "Bollywood & Regional Cinema")
                put("subtitle", "")
                put("items", mediaListToJsonArray(regional))
            })
        }

        if (actionThrillers.isNotEmpty()) {
            rowsArr.put(JSONObject().apply {
                put("title", "Action & Thrillers")
                put("subtitle", "")
                put("items", mediaListToJsonArray(actionThrillers))
            })
        }

        if (criticallyAcclaimed.isNotEmpty()) {
            rowsArr.put(JSONObject().apply {
                put("title", "Critically Acclaimed (8.0+)")
                put("subtitle", "")
                put("items", mediaListToJsonArray(criticallyAcclaimed))
            })
        }

        return JSONObject().apply {
            put("hero", heroItem?.let { mediaItemToJson(it) } ?: JSONObject.NULL)
            put("rows", rowsArr)
        }.toString()
    }

    private fun handleQuery(bodyStr: String, queryParams: Map<String, String>): String {
        val parsed = runCatching { JSONObject(bodyStr.ifBlank { "{}" }) }.getOrDefault(JSONObject())
        val filterObj = parsed.optJSONObject("filter") ?: parsed

        val searchQuery = filterObj.optString("searchQuery", queryParams["q"] ?: "")
        val mediaTypeStr = filterObj.optString("mediaTypeFilter", queryParams["mediaType"] ?: "")
        val mediaType = when (mediaTypeStr.uppercase(Locale.ROOT)) {
            "SERIES" -> MediaType.SERIES
            "MOVIE" -> MediaType.MOVIE
            else -> null
        }

        val minRating = filterObj.optDouble("minRating", queryParams["minRating"]?.toDoubleOrNull() ?: 0.0)
        val limit = parsed.optInt("limit", filterObj.optInt("limit", 120)).coerceIn(1, 500)
        val offset = parsed.optInt("offset", filterObj.optInt("offset", 0)).coerceAtLeast(0)

        fun stringSet(key: String): Set<String> {
            val out = linkedSetOf<String>()
            val arr = filterObj.optJSONArray(key)
            if (arr != null) for (i in 0 until arr.length()) arr.optString(i, "").takeIf { it.isNotBlank() }?.let { out.add(it) }
            return out
        }
        fun intOrNull(key: String): Int? = if (filterObj.isNull(key) || !filterObj.has(key)) null else filterObj.optInt(key, 0).takeIf { it > 0 }

        val incGenres = stringSet("includedGenres")
        val excGenres = stringSet("excludedGenres")
        val languages = stringSet("selectedLanguages")
        val matchAll = filterObj.optBoolean("matchAllIncludedGenres", true)
        val quality = filterObj.optString("qualityFilter", "").takeIf { it.isNotBlank() && it != "null" }
        val decade = intOrNull("decade")
        val exactYear = intOrNull("yearFilter")
        // Studio / category chip (18+ Vault) is matched against the title/plot/cast text
        val category = filterObj.optString("categoryFilter", "").takeIf { it.isNotBlank() && it != "null" }
        val fullSearch = listOfNotNull(searchQuery.takeIf { it.isNotBlank() }, category).joinToString(" ")

        val sortStr = filterObj.optString("sortBy", "RELEASE_YEAR_DESC")
        val sortOption = when (sortStr) {
            "RATING_DESC" -> SortOption.RATING_DESC
            "TITLE_ASC" -> SortOption.TITLE_ASC
            "RANDOM" -> SortOption.RANDOM
            "ADDED_DESC", "NEWLY_ADDED" -> SortOption.NEWLY_ADDED
            else -> SortOption.RELEASE_YEAR_DESC
        }

        val filter = SuperFilterState(
            searchQuery = fullSearch,
            mediaTypeFilter = mediaType,
            includedGenres = incGenres,
            excludedGenres = excGenres,
            matchAllIncludedGenres = matchAll,
            selectedLanguages = languages,
            minYear = if (decade == null) exactYear else null,
            maxYear = if (decade == null) exactYear else null,
            decade = decade,
            minRating = minRating,
            qualityFilter = quality,
            sortBy = sortOption
        )

        val activeProf = getActiveUserProfile()
        val isVaultTab = parsed.optBoolean("adultOnly", false) || queryParams["tab"] == "VAULT_18"
        val isExtrasTab = parsed.optBoolean("extrasOnly", false) || queryParams["tab"] == "EXTRAS"

        val total = IntArray(1)
        val items = db.queryMedia(
            filter = filter,
            limit = limit,
            profileId = activeProf.id,
            isKids = activeProf.isKids,
            isAdultVaultUnlocked = prefs.isAdultVaultUnlocked(),
            isVaultTab = isVaultTab,
            isExtrasUnlocked = prefs.isExtrasUnlocked(),
            isExtrasTab = isExtrasTab,
            offset = offset,
            totalOut = total
        )
        return JSONObject().apply {
            put("ok", true)
            put("items", mediaListToJsonArray(items))
            put("totalCount", items.size)
            put("totalMatched", total[0])
            put("hasMore", offset + items.size < total[0])
        }.toString()
    }

    private fun handleGetWatchlist(): String {
        val activeProf = getActiveUserProfile()
        val items = db.getWatchlist(profileId = activeProf.id, isKids = activeProf.isKids)
        return JSONObject().apply {
            put("ok", true)
            put("items", mediaListToJsonArray(items))
        }.toString()
    }

    private fun handleToggleWatchlist(bodyStr: String): String {
        val activeProf = getActiveUserProfile()
        val obj = JSONObject(bodyStr.ifBlank { "{}" })
        val dedupKey = obj.optString("dedupKey", obj.optString("id", ""))
        val inWatchlist = db.toggleWatchlist(dedupKey = dedupKey, profileId = activeProf.id)
        return JSONObject().apply {
            put("ok", true)
            put("inWatchlist", inWatchlist)
        }.toString()
    }

    private fun handleToggleWatched(bodyStr: String): String {
        val activeProf = getActiveUserProfile()
        val obj = JSONObject(bodyStr.ifBlank { "{}" })
        val dedupKey = obj.optString("dedupKey", obj.optString("id", ""))
        val isWatched = db.toggleWatched(dedupKey = dedupKey, profileId = activeProf.id)
        return JSONObject().apply {
            put("ok", true)
            put("isWatched", isWatched)
        }.toString()
    }

    private fun handleSaveProgress(bodyStr: String): String {
        val activeProf = getActiveUserProfile()
        val obj = JSONObject(bodyStr.ifBlank { "{}" })
        val dedupKey = obj.optString("dedupKey")
        val positionMs = obj.optLong("positionMs", obj.optLong("position", 0L))
        val durationMs = obj.optLong("durationMs", obj.optLong("duration", 0L))
        if (dedupKey.isNotBlank()) {
            val ok = db.savePlaybackProgress(dedupKey = dedupKey, positionMs = positionMs, durationMs = durationMs, profileId = activeProf.id)
            if (!ok) {
                return """{"ok":false,"error":"Progress recording rejected for adult content"}"""
            }
        }
        return """{"ok":true}"""
    }

    private fun handleSaveRate(bodyStr: String): String {
        val activeProf = getActiveUserProfile()
        val obj = JSONObject(bodyStr.ifBlank { "{}" })
        val dedupKey = obj.optString("dedupKey")
        val rating = obj.optDouble("rating", obj.optDouble("stars", 0.0))
        if (dedupKey.isNotBlank() && rating > 0.0) {
            db.setUserStarRating(dedupKey = dedupKey, starRating = rating, profileId = activeProf.id)
        }
        return """{"ok":true}"""
    }

    private fun handleGetDetail(queryParams: Map<String, String>): String {
        val activeProf = getActiveUserProfile()
        val dedupKey = queryParams["dedupKey"] ?: queryParams["id"] ?: ""
        val item = db.getItemByDedupKey(dedupKey, profileId = activeProf.id) ?: return """{"ok":false,"error":"Item not found"}"""
        val mlt = db.getMoreLikeThis(
            item,
            isKids = activeProf.isKids,
            limit = 8,          // only the best few on the detail screen; "Show more" pages through the rest
            matchMode = queryParams["matchMode"] ?: "everything",
            hideWatched = queryParams["hideWatched"] == "true",
            profileId = activeProf.id
        )
        // A series is checked against the provider every time it is opened, so new seasons/episodes always show.
        // First time (nothing saved yet): wait for the list. Otherwise show what is saved now and refresh in the background.
        val episodes = if (item.mediaType == MediaType.SERIES) {
            val saved = db.getSeriesEpisodes(item.primaryStreamId)
            if (saved.isEmpty()) {
                runCatching { kotlinx.coroutines.runBlocking { syncEngine.fetchSeriesEpisodesOnDemand(item) } }.getOrDefault(saved)
            } else {
                kotlin.concurrent.thread(isDaemon = true) {
                    runCatching { kotlinx.coroutines.runBlocking { syncEngine.fetchSeriesEpisodesOnDemand(item) } }
                }
                saved
            }
        } else emptyList()

        val epArr = JSONArray()
        for (ep in episodes) {
            epArr.put(JSONObject().apply {
                put("id", ep.episodeId)
                put("season", ep.seasonNumber)
                put("episodeNum", ep.episodeNumber)
                put("title", ep.title)
                put("plot", ep.plot)
                put("containerExtension", ep.containerExtension)
                put("durationSecs", ep.durationSecs)
                put("runtimeMins", ep.durationSecs / 60)
            })
        }

        // The screen reads item.episodes and "related"; older callers read the top-level names, so both are sent
        val itemJson = mediaItemToJson(item)
        itemJson.put("episodes", epArr)
        val relatedArr = mediaListToJsonArray(mlt)
        return JSONObject().apply {
            put("ok", true)
            put("item", itemJson)
            put("episodes", epArr)
            put("related", relatedArr)
            put("moreLikeThis", relatedArr)
        }.toString()
    }

    // Paged "More Like This": offset/limit, best matches first; hasMore tells the screen whether another page exists
    private fun handleGetRelated(queryParams: Map<String, String>): String {
        val activeProf = getActiveUserProfile()
        val dedupKey = queryParams["dedupKey"] ?: ""
        val item = db.getItemByDedupKey(dedupKey, profileId = activeProf.id) ?: return """{"ok":false,"error":"Item not found"}"""
        val offset = (queryParams["offset"]?.toIntOrNull() ?: 0).coerceAtLeast(0)
        val limit = (queryParams["limit"]?.toIntOrNull() ?: 24).coerceIn(1, 60)
        val rows = db.getMoreLikeThis(
            item, isKids = activeProf.isKids, limit = limit + 1, offset = offset,
            matchMode = queryParams["matchMode"] ?: "everything",
            hideWatched = queryParams["hideWatched"] == "true", profileId = activeProf.id
        )
        return JSONObject().apply {
            put("ok", true)
            put("items", mediaListToJsonArray(rows.take(limit)))
            put("hasMore", rows.size > limit)
            put("offset", offset)
        }.toString()
    }

    private fun handleProbeVersions(queryParams: Map<String, String>): String {
        val dedupKey = queryParams["dedupKey"] ?: ""
        if (dedupKey.isBlank()) {
            return JSONObject().apply {
                put("ok", true)
                put("versions", JSONArray())
            }.toString()
        }

        val activeProf = getActiveUserProfile()
        val item = db.getItemByDedupKey(dedupKey, profileId = activeProf.id)
        if (item == null || item.versions.size <= 1) {
            val vArr = JSONArray()
            item?.versions?.forEach { v ->
                vArr.put(JSONObject().apply {
                    put("streamId", v.streamId)
                    put("rawTitle", v.rawTitle)
                    put("languageTag", v.languageTag)
                    put("qualityTag", v.qualityTag)
                    put("containerExtension", v.containerExtension)
                    put("fileSizeBytes", 0L)
                    put("fileSizeStr", "")
                    put("qualityScore", if (rawTitleIsBadPrint(v.rawTitle)) 1 else printScore(v.rawTitle, v.qualityTag, 0L))
                    put("isCam", rawTitleIsBadPrint(v.rawTitle))
                })
            }
            return JSONObject().apply {
                put("ok", true)
                put("versions", vArr)
            }.toString()
        }

        val creds = prefs.loadCredentials()
        val updatedVersions = mutableListOf<JSONObject>()

        for (v in item.versions) {
            var fileSizeBytes = 0L
            var fileSizeStr = ""
            var sizeMb = 0L

            if (creds.serverUrl.isNotBlank() && creds.username.isNotBlank() && creds.password.isNotBlank()) {
                val size = probeStreamSize(creds.serverUrl, creds.username, creds.password, v.streamId, v.containerExtension)
                if (size > 0L) {
                    fileSizeBytes = size
                    fileSizeStr = formatBytes(size)
                    sizeMb = size / (1024L * 1024L)
                }
            }

            // Quality comes first (labels in the title, clean-print mark, size as a small extra).
            // Language never outranks quality: a better print in another language wins, the player offers the audio tracks.
            val isCam = rawTitleIsBadPrint(v.rawTitle)
            val qualityScore = if (isCam) 1 else printScore(v.rawTitle, v.qualityTag, sizeMb)

            val obj = JSONObject().apply {
                put("streamId", v.streamId)
                put("rawTitle", v.rawTitle)
                put("languageTag", v.languageTag)
                put("qualityTag", v.qualityTag)
                put("containerExtension", v.containerExtension)
                put("fileSizeBytes", fileSizeBytes)
                put("fileSizeStr", fileSizeStr)
                put("qualityScore", qualityScore)
                put("isCam", isCam)
            }
            updatedVersions.add(obj)
        }

        updatedVersions.sortByDescending { it.optInt("qualityScore", 0) }

        val resArr = JSONArray()
        for (uv in updatedVersions) {
            resArr.put(uv)
        }

        return JSONObject().apply {
            put("ok", true)
            put("versions", resArr)
        }.toString()
    }

    private fun probeStreamSize(
        serverUrl: String,
        username: String,
        pass: String,
        streamId: String,
        ext: String
    ): Long {
        return try {
            val base = serverUrl.trimEnd('/')
            val safeBase = if (!base.startsWith("http://", ignoreCase = true) && !base.startsWith("https://", ignoreCase = true)) {
                "http://$base"
            } else base
            val safeExt = ext.ifBlank { "mp4" }
            val urlStr = "$safeBase/movie/${android.net.Uri.encode(username)}/${android.net.Uri.encode(pass)}/${android.net.Uri.encode(streamId)}.$safeExt"
            val url = java.net.URL(urlStr)
            val conn = (url.openConnection() as java.net.HttpURLConnection).apply {
                requestMethod = "GET"
                setRequestProperty("Range", "bytes=0-10")
                setRequestProperty("User-Agent", "IPTVSmartersPlayer/1.0")
                connectTimeout = 3000
                readTimeout = 3000
                instanceFollowRedirects = true
            }
            try {
                val code = conn.responseCode
                if (code in 200..299) {
                    val cr = conn.getHeaderField("Content-Range") ?: ""
                    val m = Regex("""/(\d+)$""").find(cr)
                    if (m != null) {
                        m.groupValues[1].toLongOrNull() ?: 0L
                    } else {
                        val cl = conn.contentLengthLong
                        if (cl > 1000L) cl else 0L
                    }
                } else 0L
            } finally {
                conn.disconnect()
            }
        } catch (_: Exception) {
            0L
        }
    }

    private fun formatBytes(bytes: Long): String {
        if (bytes <= 0L) return ""
        val gb = bytes / (1024.0 * 1024.0 * 1024.0)
        if (gb >= 1.0) {
            return String.format(Locale.US, "%.1f GB", gb)
        }
        val mb = bytes / (1024L * 1024L)
        if (mb >= 1L) {
            return "$mb MB"
        }
        val kb = bytes / 1024L
        return "$kb KB"
    }

    // Whole-word match only: "American Gangster" or "Camelot" must not be flagged as a CAM copy.
    private fun rawTitleMatchesCam(rawTitle: String): Boolean =
        Regex("""(?<![A-Za-z0-9])(cam|camrip|hdcam|hd-cam|telesync|hdts|ts)(?![A-Za-z0-9])""", RegexOption.IGNORE_CASE).containsMatchIn(rawTitle)

    // Cinema recordings and prints carrying a watermark / betting-site advert are always ranked last.
    private val badPrintRegex = Regex(
        """(?<![A-Za-z0-9])(cam|camrip|hdcam|hd-cam|telesync|hdts|ts|tc|telecine|screener|scr|dvdscr|workprint|1xbet|betwinner|linebet|dragon\s*money|sponsored|watermark(ed)?)(?![A-Za-z0-9])""",
        RegexOption.IGNORE_CASE
    )
    private fun rawTitleIsBadPrint(rawTitle: String): Boolean = badPrintRegex.containsMatchIn(rawTitle)

    private fun printScore(rawTitle: String, qualityTag: String, sizeMb: Long): Int {
        val t = "$rawTitle $qualityTag".uppercase(java.util.Locale.ROOT)
        fun has(re: String) = Regex(re).containsMatchIn(t)
        var score = 10
        score += when {
            has("(?<![A-Z0-9])(4K|UHD|2160P?)(?![A-Z0-9])") -> 40
            has("(?<![A-Z0-9])(BLURAY|BD-?RIP|BRRIP|REMUX)(?![A-Z0-9])") -> 30
            has("(?<![A-Z0-9])(WEB-?DL|WEBRIP)(?![A-Z0-9])") -> 25
            has("(?<![A-Z0-9])(1080P?|FHD)(?![A-Z0-9])") -> 15
            has("(?<![A-Z0-9])720P?(?![A-Z0-9])") -> 5
            else -> 0
        }
        if (has("(?<![A-Z0-9])(HDR10?|DOLBY\\s*VISION)(?![A-Z0-9])")) score += 3
        if (has("(?<![A-Z0-9])(HEVC|X265|H\\.?265)(?![A-Z0-9])")) score += 5
        if (has("(?<![A-Z0-9])(DUAL[\\s-]*AUDIO|MULTI[\\s-]*AUDIO)(?![A-Z0-9])")) score += 4
        // A trailing "*" on this provider marks the clean Hindi-dubbed / dual-audio print
        if (rawTitle.trimEnd().endsWith("*")) score += 15
        // File size is only a small extra so a big recording can never beat a clean print
        score += when {
            sizeMb > 2500 -> 8
            sizeMb > 1500 -> 6
            sizeMb > 800 -> 4
            sizeMb > 0 -> 1
            else -> 0
        }
        return score
    }

    private fun handleGetLive(queryParams: Map<String, String>): String {
        val activeProf = getActiveUserProfile()
        // The screen sends tab=<id>&q=<text>; older callers used category= and search=
        val tab = (queryParams["tab"] ?: "ALL").uppercase()
        val search = (queryParams["q"] ?: queryParams["search"] ?: "").trim()
        val legacyCat = queryParams["category"]

        // Live TV: hidden completely in Kids mode; adult / extras channels only in their own unlocked tab.
        val group = when {
            activeProf.isKids -> "normal"
            queryParams["group"] == "adult" && prefs.isAdultVaultUnlocked() -> "adult"
            queryParams["group"] == "extras" && prefs.isExtrasUnlocked() -> "extras"
            else -> "normal"
        }

        val tabKeywords = mapOf(
            "SPORTS" to listOf("sport", "cricket", "football", "soccer", "golf", "wwe", "ufc", "f1", "racing", "tennis", "nba", "espn"),
            "NEWS" to listOf("news"),
            "MOVIES" to listOf("cinema", "movie", "film", "hbo", "box office"),
            "ENTERTAINMENT" to listOf("entertain", "drama", "series", "shows", "comedy"),
            "KIDS" to listOf("kids", "cartoon", "disney", "nick", "pogo", "anime"),
            "PAKISTAN" to listOf("pak", "urdu"),
            "INDIA" to listOf("india", "hindi", "ind |", "in |"),
            "UK" to listOf("uk"),
            "US" to listOf("usa", "us |")
        )

        val channels = if (activeProf.isKids) emptyList() else db.getLiveChannels(
            categoryName = if (tab == "FAVORITES") "★ Favorites" else legacyCat,
            searchQuery = search,
            profileId = activeProf.id,
            isKids = false,
            group = group,
            keywords = if (group == "normal") tabKeywords[tab] ?: emptyList() else emptyList()
        )

        // Favourites are never kept for adult / extras channels
        val tabsArr = JSONArray()
        tabsArr.put(JSONObject().put("id", "ALL").put("label", "All"))
        if (group == "normal") {
            tabsArr.put(JSONObject().put("id", "FAVORITES").put("label", "★ Favorites"))
            listOf("SPORTS" to "Sports", "NEWS" to "News", "MOVIES" to "Movies", "ENTERTAINMENT" to "Entertainment",
                "KIDS" to "Kids", "PAKISTAN" to "Pakistan", "INDIA" to "India", "UK" to "UK", "US" to "US")
                .forEach { tabsArr.put(JSONObject().put("id", it.first).put("label", it.second)) }
        }

        val chArr = JSONArray()
        for (ch in channels) {
            chArr.put(JSONObject().apply {
                put("streamId", ch.streamId)
                put("name", ch.name)
                put("logoUrl", ch.logoUrl)
                put("categoryName", ch.categoryName)
                put("isFavorite", ch.isFavorite && group == "normal")
                put("currentProgram", ch.currentProgramTitle)
            })
        }

        return JSONObject().apply {
            put("ok", true)
            put("tabs", tabsArr)
            put("currentTab", tab)
            put("channels", chArr)
            put("matchedCount", channels.size)
        }.toString()
    }

    // "Latest added": last 14 days, newest first, max 50 per list (Movies, Series, Live TV)
    private fun liveToJson(live: List<LiveChannel>): JSONArray {
        val arr = JSONArray()
        for (ch in live) {
            arr.put(JSONObject().apply {
                put("streamId", ch.streamId)
                put("name", ch.name)
                put("logoUrl", ch.logoUrl)
                put("categoryName", ch.categoryName)
                put("addedTimestamp", ch.addedTimestamp)
            })
        }
        return arr
    }

    // Adult / Extras lists are only included while that area is unlocked (and never for Kids profiles)
    private fun latestGroupJson(group: String): JSONObject = JSONObject().apply {
        put("movies", mediaListToJsonArray(db.getLatestAdded("MOVIE", false, group = group)))
        put("series", mediaListToJsonArray(db.getLatestAdded("SERIES", false, group = group)))
        put("live", liveToJson(db.getLatestLiveChannels(group = group)))
    }

    private fun handleGetLatest(): String {
        val activeProf = getActiveUserProfile()
        val kids = activeProf.isKids
        val movies = db.getLatestAdded("MOVIE", kids)
        val series = db.getLatestAdded("SERIES", kids)
        val live = if (kids) emptyList() else db.getLatestLiveChannels()
        return JSONObject().apply {
            put("ok", true)
            put("movies", mediaListToJsonArray(movies))
            put("series", mediaListToJsonArray(series))
            put("live", liveToJson(live))
            put("days", 14)
            if (!kids && prefs.isAdultVaultUnlocked()) put("adult", latestGroupJson("adult"))
            if (!kids && prefs.isExtrasUnlocked()) put("extras", latestGroupJson("extras"))
        }.toString()
    }

    private fun handleToggleLiveFavorite(bodyStr: String): String {
        val activeProf = getActiveUserProfile()
        val obj = JSONObject(bodyStr.ifBlank { "{}" })
        val streamId = obj.optString("streamId")
        val isFav = db.toggleFavoriteChannel(streamId = streamId, profileId = activeProf.id)
        return JSONObject().apply {
            put("ok", true)
            put("isFavorite", isFav)
        }.toString()
    }

    private fun handleGetSearchHistory(): String {
        val activeProf = getActiveUserProfile()
        val history = prefs.getRecentSearches(activeProf.id)
        return JSONObject().apply {
            put("ok", true)
            put("history", JSONArray(history))
        }.toString()
    }

    private fun handleAddSearchHistory(bodyStr: String): String {
        val activeProf = getActiveUserProfile()
        val obj = JSONObject(bodyStr.ifBlank { "{}" })
        val query = obj.optString("query")
        val isVault = obj.optBoolean("isVault", false)
        // Phase B Rule: Never record search-history entry for adult titles
        if (query.isNotBlank() && !isVault && !StreamVaultDatabase.checkIsAdult(query, "", "", "")) {
            prefs.addRecentSearch(query = query, profileId = activeProf.id)
        }
        return """{"ok":true}"""
    }

    private fun handleDeleteSearchHistory(bodyStr: String): String {
        val activeProf = getActiveUserProfile()
        val obj = JSONObject(bodyStr.ifBlank { "{}" })
        val query = obj.optString("query")
        if (query.isNotBlank()) {
            prefs.removeRecentSearch(query = query, profileId = activeProf.id)
        }
        return """{"ok":true}"""
    }

    private fun handleClearSearchHistory(): String {
        val activeProf = getActiveUserProfile()
        prefs.clearRecentSearches(activeProf.id)
        return """{"ok":true}"""
    }

    private fun handleParentalPin(bodyStr: String): String {
        val obj = JSONObject(bodyStr.ifBlank { "{}" })
        val action = obj.optString("action", "status")
        val pin = obj.optString("pin")
        val newPin = obj.optString("newPin")
        val password = obj.optString("password", "")
        val code = obj.optString("code", "")

        return when (action) {
            "status" -> {
                JSONObject().apply {
                    put("success", true)
                    put("isLocked", !prefs.isAdultVaultUnlocked())
                    put("showAdult", prefs.isAdultVaultUnlocked())
                    put("showExtras", prefs.isExtrasUnlocked())
                    put("hasCustomPin", prefs.hasCustomParentalPin())
                    put("hasPin", prefs.hasCustomParentalPin())
                    put("isLockedOut", System.currentTimeMillis() < prefs.getPinLockoutUntil())
                    put("pinHash", prefs.getPinHash() ?: "")
                    put("pinSalt", if (prefs.hasCustomParentalPin()) prefs.getPinSalt() else "")
                }.toString()
            }
            "lock" -> {
                // target: "adult", "extras" or (default) both
                when (obj.optString("target", "all")) {
                    "adult" -> prefs.setAdultVaultUnlocked(false)
                    "extras" -> prefs.setExtrasUnlocked(false)
                    else -> prefs.lockAllVaults()
                }
                JSONObject().apply {
                    put("success", true)
                    put("isLocked", !prefs.isAdultVaultUnlocked())
                    put("showAdult", prefs.isAdultVaultUnlocked())
                    put("showExtras", prefs.isExtrasUnlocked())
                }.toString()
            }
            "unlock" -> {
                // Kids mode can never open Adult or Extras; the profile must leave Kids mode first (needs the PIN).
                if (getActiveUserProfile().isKids) {
                    return """{"success":false,"error":"Not available in Kids mode"}"""
                }
                if (!prefs.hasCustomParentalPin()) {
                    return """{"success":false,"requireSetPin":true,"error":"Master PIN must be set before accessing 18+ Vault"}"""
                }
                if (System.currentTimeMillis() < prefs.getPinLockoutUntil()) {
                    return """{"success":false,"isLockedOut":true,"error":"Too many failed attempts. Try again later."}"""
                }
                val ok = prefs.verifyParentalPin(pin)
                if (ok) {
                    val target = obj.optString("target", "adult")
                    if (target == "extras") prefs.setExtrasUnlocked(true) else prefs.setAdultVaultUnlocked(true)
                    JSONObject().apply {
                        put("success", true)
                        put("isLocked", !prefs.isAdultVaultUnlocked())
                        put("showAdult", prefs.isAdultVaultUnlocked())
                        put("showExtras", prefs.isExtrasUnlocked())
                    }.toString()
                } else {
                    val lockedOut = System.currentTimeMillis() < prefs.getPinLockoutUntil()
                    val err = if (lockedOut) "Too many failed attempts. Locked for 60 seconds." else "Incorrect Master PIN"
                    JSONObject().apply {
                        put("success", false)
                        put("error", err)
                        put("isLockedOut", lockedOut)
                    }.toString()
                }
            }
            "verify" -> {
                if (!prefs.hasCustomParentalPin()) {
                    return """{"success":false,"requireSetPin":true,"error":"Master PIN must be set first"}"""
                }
                if (System.currentTimeMillis() < prefs.getPinLockoutUntil()) {
                    return """{"success":false,"isLockedOut":true,"error":"Too many failed attempts. Try again later."}"""
                }
                val ok = prefs.verifyParentalPin(pin)
                if (ok) {
                    """{"success":true,"ok":true}"""
                } else {
                    val lockedOut = System.currentTimeMillis() < prefs.getPinLockoutUntil()
                    val err = if (lockedOut) "Too many failed attempts. Locked for 60 seconds." else "Incorrect Master PIN"
                    JSONObject().apply {
                        put("success", false)
                        put("error", err)
                        put("isLockedOut", lockedOut)
                    }.toString()
                }
            }
            "set_pin" -> {
                val currentPin = pin.takeIf { it.isNotBlank() }
                val ok = prefs.setParentalPin(currentPin, newPin)
                if (ok) {
                    JSONObject().apply {
                        put("success", true)
                        put("message", "PIN updated")
                        put("pinHash", prefs.getPinHash() ?: "")
                        put("pinSalt", prefs.getPinSalt())
                        put("hasCustomPin", true)
                    }.toString()
                } else {
                    val err = if (prefs.hasCustomParentalPin()) "Current PIN incorrect or new PIN invalid" else "New PIN must be exactly 4 digits"
                    """{"success":false,"error":"$err"}"""
                }
            }
            "reset_pin" -> {
                if (newPin.trim().length != 4) {
                    return """{"success":false,"error":"New PIN must be exactly 4 digits"}"""
                }
                val (verified, msg) = verifyResetPinWithWorker(accountPassword = password, code = code, newPin = newPin)
                if (verified) {
                    JSONObject().apply {
                        put("success", true)
                        put("message", msg)
                        put("pinHash", prefs.getPinHash() ?: "")
                        put("pinSalt", prefs.getPinSalt())
                    }.toString()
                } else {
                    JSONObject().apply {
                        put("success", false)
                        put("error", msg)
                    }.toString()
                }
            }
            "restore" -> {
                val pinHash = obj.optString("pinHash")
                val pinSalt = obj.optString("pinSalt")
                if (pinHash.isNotBlank()) {
                    prefs.restorePinHash(pinHash, pinSalt)
                }
                """{"success":true}"""
            }
            "signout" -> {
                prefs.clearAuthSession()
                """{"success":true}"""
            }
            else -> """{"success":false,"error":"Unknown action"}"""
        }
    }

    private fun verifyResetPinWithWorker(accountPassword: String, code: String, newPin: String): Pair<Boolean, String> {
        val token = prefs.getAuthToken()
        if (token.isNullOrBlank()) {
            return Pair(false, "Cloud session required to reset PIN. Please sign in.")
        }
        return try {
            val baseUrl = prefs.getCloudSyncBaseUrl()
            val url = java.net.URL("$baseUrl/api/account/reset-pin")
            val conn = url.openConnection() as java.net.HttpURLConnection
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Authorization", "Bearer $token")
            conn.connectTimeout = 8000
            conn.readTimeout = 8000
            conn.doOutput = true

            val payload = JSONObject().apply {
                if (accountPassword.isNotBlank()) put("password", accountPassword)
                if (code.isNotBlank()) put("code", code)
                put("newPin", newPin)
            }

            conn.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }
            val codeResp = conn.responseCode
            val respStr = if (codeResp in 200..299) {
                conn.inputStream.bufferedReader().use { it.readText() }
            } else {
                conn.errorStream?.bufferedReader()?.use { it.readText() } ?: ""
            }
            conn.disconnect()

            if (codeResp in 200..299) {
                prefs.resetParentalPinWithAuth(newPin)
                Pair(true, "PIN reset successfully")
            } else {
                val err = try { JSONObject(respStr).optString("error", "Verification failed") } catch (_: Exception) { "Verification failed" }
                Pair(false, err)
            }
        } catch (e: Exception) {
            Pair(false, "Network error: ${e.message}")
        }
    }

    private fun handleGetProfiles(): String {
        val profiles = db.getProfiles(prefs.getAccountDisplayName())
        val activeId = prefs.getActiveProfileId().ifBlank { profiles.first().id }
        val arr = JSONArray()
        for (p in profiles) {
            arr.put(JSONObject().apply {
                put("id", p.id)
                put("name", p.name)
                put("avatarColor", p.avatarColor)
                put("isKids", p.isKids)
                put("theme", p.theme)
                put("isPrimary", p.isPrimary)
                put("updatedAt", p.updatedAt)
            })
        }
        return JSONObject().apply {
            put("success", true)
            put("ok", true)
            put("activeProfileId", activeId)
            put("profiles", arr)
        }.toString()
    }

    private fun handleCreateProfile(bodyStr: String): String {
        val json = JSONObject(bodyStr.ifBlank { "{}" })
        val name = json.optString("name", json.optString("displayName", "")).trim()
        val avatarColor = json.optString("avatarColor", "#8B5CF6")
        val theme = json.optString("theme", "purple")
        val isKids = json.optBoolean("isKids", false)

        if (name.isBlank()) {
            return """{"ok":false,"error":"Profile name required"}"""
        }

        val prof = db.createProfile(name, avatarColor, theme, isKids)
            ?: return """{"ok":false,"error":"Maximum 5 profiles allowed"}"""

        return JSONObject().apply {
            put("success", true)
            put("ok", true)
            put("profile", prof.toJson())
        }.toString()
    }

    private fun handleUpdateProfile(bodyStr: String): String {
        val json = JSONObject(bodyStr.ifBlank { "{}" })
        val id = json.optString("id", json.optString("profileId", ""))
        val name = json.optString("name", json.optString("displayName", "")).trim()
        val avatarColor = json.optString("avatarColor", "")
        val theme = json.optString("theme", "")
        val targetIsKids = json.optBoolean("isKids", false)
        val pin = json.optString("pin", "")

        val existing = db.getProfileById(id) ?: return """{"ok":false,"error":"Profile not found"}"""

        // Phase B Rule: Turning Kids Mode OFF requires Master PIN!
        if (existing.isKids && !targetIsKids) {
            if (!prefs.hasCustomParentalPin()) {
                return """{"ok":false,"requireSetPin":true,"error":"Master PIN must be set before disabling Kids Mode"}"""
            }
            if (!prefs.verifyParentalPin(pin)) {
                return """{"ok":false,"error":"Master PIN required to disable Kids Mode"}"""
            }
        }

        val ok = db.updateProfile(
            id = id,
            name = if (name.isNotBlank()) name else existing.name,
            avatarColor = if (avatarColor.isNotBlank()) avatarColor else existing.avatarColor,
            theme = if (theme.isNotBlank()) theme else existing.theme,
            isKids = targetIsKids
        )

        return if (ok) {
            val updated = db.getProfileById(id) ?: existing
            JSONObject().apply {
                put("success", true)
                put("ok", true)
                put("profile", updated.toJson())
            }.toString()
        } else {
            """{"ok":false,"error":"Failed to update profile"}"""
        }
    }

    private fun handleDeleteProfile(bodyStr: String): String {
        val json = JSONObject(bodyStr.ifBlank { "{}" })
        val id = json.optString("id", json.optString("profileId", ""))
        if (id.isBlank()) return """{"ok":false,"error":"Profile ID required"}"""

        val prof = db.getProfileById(id) ?: return """{"ok":false,"error":"Profile not found"}"""
        if (prof.isPrimary) {
            return """{"ok":false,"error":"Primary profile cannot be deleted"}"""
        }

        val ok = db.deleteProfile(id)
        if (ok) {
            if (prefs.getActiveProfileId() == id) {
                val primary = db.getPrimaryProfile()
                prefs.setActiveProfileId(primary.id)
                prefs.lockAllVaults()
            }
            return """{"success":true,"ok":true}"""
        }
        return """{"ok":false,"error":"Could not delete profile"}"""
    }

    private fun handleSwitchProfile(bodyStr: String): String {
        val json = JSONObject(bodyStr.ifBlank { "{}" })
        val id = json.optString("id", json.optString("profileId", ""))
        val prof = db.getProfileById(id) ?: return """{"ok":false,"error":"Profile not found"}"""

        prefs.setActiveProfileId(prof.id)
        // Phase B Rule: Re-lock 18+ Vault in memory on profile switch!
        prefs.lockAllVaults()

        return JSONObject().apply {
            put("success", true)
            put("ok", true)
            put("activeProfileId", prof.id)
            put("profile", prof.toJson())
        }.toString()
    }

    private fun handleSaveCredentials(bodyStr: String): String {
        val obj = JSONObject(bodyStr.ifBlank { "{}" })
        val serverUrl = obj.optString("serverUrl")
        val username = obj.optString("username")
        val password = obj.optString("password")
        val playlistName = obj.optString("playlistName", obj.optString("name", "My IPTV"))

        val current = prefs.loadCredentials()
        val updated = current.copy(
            playlistName = playlistName.ifBlank { "My IPTV" },
            serverUrl = serverUrl.ifBlank { current.serverUrl },
            username = username.ifBlank { current.username },
            password = if (password.isNotBlank()) password else current.password
        )
        prefs.saveCredentials(updated)
        syncEngine.triggerSync(isManual = true)
        return """{"ok":true}"""
    }

    /**
     * Builds the playable address for a movie, an episode or a live channel.
     * Body: { kind: "movie" | "series" | "live", id, ext }. The screen never sees the IPTV password.
     */
    private fun handleStreamUrl(bodyStr: String): String {
        val obj = JSONObject(bodyStr.ifBlank { "{}" })
        val creds = prefs.loadCredentials()
        if (!creds.isConfigured) {
            return JSONObject().apply {
                put("ok", false)
                put("error", "no_login")
                put("message", "Your IPTV login is not on this TV yet. Open Settings, then IPTV Playlists.")
            }.toString()
        }
        val kind = when (obj.optString("kind")) { "series" -> "series"; "live" -> "live"; else -> "movie" }
        val id = obj.optString("id").trim()
        if (id.isBlank()) {
            return JSONObject().apply { put("ok", false); put("error", "no_id"); put("message", "This title has no playable stream.") }.toString()
        }
        val ext = if (kind == "live") "m3u8" else obj.optString("ext").ifBlank { "mp4" }.trim('.')
        fun enc(s: String) = java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")
        val url = "${creds.normalizedServerUrl}/$kind/${enc(creds.username)}/${enc(creds.password)}/${enc(id)}.$ext"
        return JSONObject().apply { put("ok", true); put("url", url) }.toString()
    }

    private fun handleSyncNow(): String {
        if (!prefs.loadCredentials().isConfigured) {
            return JSONObject().apply {
                put("ok", false)
                put("error", "No working IPTV playlist to check. Add one under IPTV Playlists first.")
            }.toString()
        }
        syncEngine.triggerSync(isManual = true)
        return """{"ok":true}"""
    }

    private fun handlePullCloudCatalog(): String {
        val count = syncEngine.pullCatalogFromCloud()
        return JSONObject().apply {
            put("ok", true)
            put("count", count)
            put("message", "Catalog pulled from cloud ($count titles)")
        }.toString()
    }

    private fun handleGetSyncStatus(): String {
        return JSONObject().apply {
            put("ok", true)
            put("lastSyncTimestamp", prefs.lastFullSyncTimestamp)
            put("syncState", syncEngine.syncState.value.phase)
        }.toString()
    }

    private fun handleFactoryReset(): String {
        prefs.clearAuthSession()
        prefs.saveCredentials(XtreamCredentials())
        prefs.clearRecentSearches()
        prefs.lockAllVaults()
        db.clearCatalog()
        return """{"ok":true,"message":"Factory reset complete"}"""
    }

    private fun handleSignOut(): String {
        prefs.clearAuthSession()
        prefs.saveCredentials(XtreamCredentials())
        prefs.clearRecentSearches()
        prefs.lockAllVaults()
        db.clearCatalog()
        return """{"ok":true,"message":"Signed out successfully"}"""
    }

    private fun handleSetSession(bodyStr: String): String {
        return try {
            val json = JSONObject(bodyStr)
            val token = json.optString("token", "").ifBlank { json.optString("authToken", "") }
            val email = json.optString("email", "")
            val displayName = json.optString("displayName", "")
            if (token.isNotBlank()) {
                prefs.setAuthToken(token)
                if (email.isNotBlank()) prefs.setAccountEmail(email)
                if (displayName.isNotBlank()) prefs.setAccountDisplayName(displayName)
                """{"ok":true,"authenticated":true}"""
            } else {
                """{"ok":false,"error":"Token missing"}"""
            }
        } catch (e: Exception) {
            """{"ok":false,"error":"${e.message}"}"""
        }
    }

    private fun handleGetPlaylists(): String {
        val creds = prefs.loadCredentials()
        val (enriched, total) = db.getEnrichmentCounts()
        val syncState = syncEngine.syncState.value
        val playlistsArr = JSONArray()

        if (creds.serverUrl.isNotBlank() && creds.username.isNotBlank()) {
            val pl = JSONObject().apply {
                put("playlist_id", "local_pl_primary")
                put("name", creds.playlistName.ifBlank { "Primary IPTV" })
                put("server_url", creds.serverUrl)
                put("username", creds.username)
                put("is_enabled", 1)
                put("status", when {
                    syncState.isSyncing -> "syncing"
                    syncState.errorMessage != null -> "failed"
                    else -> "working"
                })
                put("total_titles", total)
                put("enriched_titles", enriched)
                put("last_sync_at", System.currentTimeMillis())
            }
            playlistsArr.put(pl)
        }

        return JSONObject().apply {
            put("success", true)
            put("playlists", playlistsArr)
        }.toString()
    }

    private fun handleAddPlaylist(bodyStr: String): String {
        handleSaveCredentials(bodyStr)
        return JSONObject().apply {
            put("success", true)
            put("message", "Playlist added")
        }.toString()
    }

    private fun handleUpdatePlaylist(bodyStr: String): String {
        val obj = JSONObject(bodyStr.ifBlank { "{}" })
        // Switching a playlist on/off only changes the cloud record: nothing to re-download
        if (obj.has("isEnabled") && !obj.has("serverUrl")) {
            return JSONObject().apply { put("success", true); put("message", "Playlist updated") }.toString()
        }
        handleSaveCredentials(bodyStr)
        return JSONObject().apply {
            put("success", true)
            put("message", "Playlist updated")
        }.toString()
    }

    /** Stops using the playlist on this TV: forgets the login and removes its titles. Watch progress is kept. */
    private fun handleClearPlaylist(): String {
        val current = prefs.loadCredentials()
        prefs.saveCredentials(current.copy(serverUrl = "", username = "", password = ""))
        db.clearTitlesOnly()
        prefs.lastFullSyncTimestamp = 0L
        return JSONObject().apply {
            put("success", true)
            put("message", "Playlist removed")
        }.toString()
    }

    private fun handleDeletePlaylist(@Suppress("UNUSED_PARAMETER") path: String): String = handleClearPlaylist()

    // --- Helpers ---

    private fun mediaItemToJson(item: MediaItem): JSONObject {
        return JSONObject().apply {
            put("dedupKey", item.dedupKey)
            put("primaryStreamId", item.primaryStreamId)
            put("tmdbId", item.tmdbId)
            put("imdbId", item.imdbId)
            put("mediaType", item.mediaType.name)
            put("cleanTitle", item.cleanTitle)
            put("rawTitle", item.rawTitle)
            put("year", item.year)
            put("rating", item.rating)
            put("voteCount", item.voteCount)
            put("genres", JSONArray(item.genres))
            put("plot", item.plot)
            put("cast", JSONArray(item.cast))
            put("director", item.director)
            put("runtimeMins", item.runtimeMins)
            put("posterUrl", item.posterUrl)
            put("backdropUrl", item.backdropUrl)
            put("language", item.language)
            put("qualityBadges", JSONArray(item.qualityBadges))
            put("inWatchlist", item.inWatchlist)
            put("isWatched", item.isWatched)
            put("resumePositionMs", item.resumePositionMs)
            put("durationMs", item.durationMs)
            put("isAdult", item.isAdult)
            put("certification", item.certification)
            put("userRating", item.userRating)
            put("versions", JSONArray(item.versions.map { v ->
                JSONObject().apply {
                    put("streamId", v.streamId)
                    put("rawTitle", v.rawTitle)
                    put("languageTag", v.languageTag)
                    put("qualityTag", v.qualityTag)
                    put("containerExtension", v.containerExtension)
                }
            }))
        }
    }

    private fun mediaListToJsonArray(items: List<MediaItem>): JSONArray {
        val arr = JSONArray()
        val seasonCounts = db.seasonCountsFor(items.filter { it.mediaType == MediaType.SERIES }.map { it.primaryStreamId })
        for (item in items) {
            val json = mediaItemToJson(item)
            val n = seasonCounts[item.primaryStreamId] ?: 0
            if (item.mediaType == MediaType.SERIES && n > 0) json.put("seasonTag", if (n == 1) "S1" else "$n Seasons")
            arr.put(json)
        }
        return arr
    }

    private fun parseQueryParams(query: String): Map<String, String> {
        if (query.isBlank()) return emptyMap()
        val map = mutableMapOf<String, String>()
        for (pair in query.split("&")) {
            val parts = pair.split("=", limit = 2)
            if (parts.size == 2) {
                map[java.net.URLDecoder.decode(parts[0], "UTF-8")] =
                    java.net.URLDecoder.decode(parts[1], "UTF-8")
            }
        }
        return map
    }
}
