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

                // 9. Live TV
                method == "GET" && path == "/api/live" -> handleGetLive(queryParams)
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

                // 13. Trigger Sync Now
                method == "POST" && path == "/api/sync-now" -> handleSyncNow()

                // 14. Factory Reset
                method == "POST" && path == "/api/factory-reset" -> handleFactoryReset()

                // 15. Playlists Management
                method == "GET" && path == "/api/playlists" -> handleGetPlaylists()
                method == "POST" && path == "/api/playlists" -> handleAddPlaylist(bodyStr)
                method == "PUT" && path.startsWith("/api/playlists") -> handleUpdatePlaylist(bodyStr)
                method == "DELETE" && path.startsWith("/api/playlists") -> handleDeletePlaylist(path)

                else -> """{"error":"Endpoint not found","path":"$path"}"""
            }
        } catch (e: Exception) {
            """{"error":"Internal error: ${e.message}","ok":false}"""
        }
    }

    private fun handleGetState(): String {
        val creds = prefs.loadCredentials()
        val (enriched, total) = db.getEnrichmentCounts()
        val syncState = syncEngine.syncState.value

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
        }

        val smartRowsArr = JSONArray()
        for (sr in db.getPinnedSmartRows()) {
            smartRowsArr.put(JSONObject().apply {
                put("id", sr.id)
                put("title", sr.title)
            })
        }

        return JSONObject().apply {
            put("credentials", credsObj)
            put("parentalControl", parentalObj)
            put("syncStatus", syncObj)
            put("remoteSearchQuery", prefs.remoteSearchCommand.value ?: "")
            put("pinnedSmartRows", smartRowsArr)
            put("totalCatalogCount", total)
            put("totalLiveCount", db.getLiveChannels().size)
            put("localIpUrl", "http://127.0.0.1:8765/phone")
        }.toString()
    }

    private fun handleGetHome(): String {
        val continueWatching = db.getContinueWatchingList(30)
        val allMovies = db.queryMedia(
            SuperFilterState(minRating = 6.0, sortBy = SortOption.RELEASE_YEAR_DESC),
            limit = 60
        )

        val trending = db.queryMedia(
            SuperFilterState(minRating = 6.8, sortBy = SortOption.RATING_DESC),
            limit = 10
        )

        val hollywood = db.queryMedia(
            SuperFilterState(
                selectedLanguages = setOf("English", "Multi-Audio"),
                minRating = 6.0,
                sortBy = SortOption.RELEASE_YEAR_DESC
            ),
            limit = 28
        )

        val regional = db.queryMedia(
            SuperFilterState(
                selectedLanguages = setOf("Hindi", "Urdu", "Punjabi", "Tamil", "Telugu", "Multi-Audio"),
                sortBy = SortOption.RELEASE_YEAR_DESC
            ),
            limit = 28
        )

        val actionThrillers = db.queryMedia(
            SuperFilterState(
                includedGenres = setOf("Action", "Thriller"),
                minRating = 6.5,
                sortBy = SortOption.RATING_DESC
            ),
            limit = 24
        )

        val criticallyAcclaimed = db.queryMedia(
            SuperFilterState(minRating = 8.0, sortBy = SortOption.RATING_DESC),
            limit = 24
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
        val limit = parsed.optInt("limit", filterObj.optInt("limit", 120))

        val incGenres = mutableSetOf<String>()
        val incArr = filterObj.optJSONArray("includedGenres")
        if (incArr != null) {
            for (i in 0 until incArr.length()) incGenres.add(incArr.getString(i))
        }

        val sortStr = filterObj.optString("sortBy", "RELEASE_YEAR_DESC")
        val sortOption = when (sortStr) {
            "RATING_DESC" -> SortOption.RATING_DESC
            "TITLE_ASC" -> SortOption.TITLE_ASC
            "ADDED_DESC", "NEWLY_ADDED" -> SortOption.NEWLY_ADDED
            else -> SortOption.RELEASE_YEAR_DESC
        }

        val filter = SuperFilterState(
            searchQuery = searchQuery,
            mediaTypeFilter = mediaType,
            minRating = minRating,
            includedGenres = incGenres,
            sortBy = sortOption
        )

        val items = db.queryMedia(filter, limit = limit)
        return JSONObject().apply {
            put("ok", true)
            put("items", mediaListToJsonArray(items))
            put("totalCount", items.size)
        }.toString()
    }

    private fun handleGetWatchlist(): String {
        val items = db.getWatchlist()
        return JSONObject().apply {
            put("ok", true)
            put("items", mediaListToJsonArray(items))
        }.toString()
    }

    private fun handleToggleWatchlist(bodyStr: String): String {
        val obj = JSONObject(bodyStr.ifBlank { "{}" })
        val dedupKey = obj.optString("dedupKey", obj.optString("id", ""))
        val inWatchlist = db.toggleWatchlist(dedupKey)
        return JSONObject().apply {
            put("ok", true)
            put("inWatchlist", inWatchlist)
        }.toString()
    }

    private fun handleToggleWatched(bodyStr: String): String {
        val obj = JSONObject(bodyStr.ifBlank { "{}" })
        val dedupKey = obj.optString("dedupKey", obj.optString("id", ""))
        val isWatched = db.toggleWatched(dedupKey)
        return JSONObject().apply {
            put("ok", true)
            put("isWatched", isWatched)
        }.toString()
    }

    private fun handleSaveProgress(bodyStr: String): String {
        val obj = JSONObject(bodyStr.ifBlank { "{}" })
        val dedupKey = obj.optString("dedupKey")
        val positionMs = obj.optLong("positionMs", obj.optLong("position", 0L))
        val durationMs = obj.optLong("durationMs", obj.optLong("duration", 0L))
        if (dedupKey.isNotBlank()) {
            db.savePlaybackProgress(dedupKey, positionMs, durationMs)
        }
        return """{"ok":true}"""
    }

    private fun handleSaveRate(bodyStr: String): String {
        val obj = JSONObject(bodyStr.ifBlank { "{}" })
        val dedupKey = obj.optString("dedupKey")
        val rating = obj.optDouble("rating", obj.optDouble("stars", 0.0))
        if (dedupKey.isNotBlank() && rating > 0.0) {
            db.setUserStarRating(dedupKey, rating)
        }
        return """{"ok":true}"""
    }

    private fun handleGetDetail(queryParams: Map<String, String>): String {
        val dedupKey = queryParams["dedupKey"] ?: queryParams["id"] ?: ""
        val item = db.getItemByDedupKey(dedupKey) ?: return """{"ok":false,"error":"Item not found"}"""
        val mlt = db.getMoreLikeThis(item, 12)
        val episodes = if (item.mediaType == MediaType.SERIES) {
            db.getSeriesEpisodes(item.primaryStreamId)
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
                put("runtimeMins", ep.durationSecs / 60)
            })
        }

        return JSONObject().apply {
            put("ok", true)
            put("item", mediaItemToJson(item))
            put("episodes", epArr)
            put("moreLikeThis", mediaListToJsonArray(mlt))
        }.toString()
    }

    private fun handleGetLive(queryParams: Map<String, String>): String {
        val cat = queryParams["category"]
        val search = queryParams["search"] ?: ""
        val channels = db.getLiveChannels(categoryName = cat, searchQuery = search)
        val categories = db.getLiveCategories()

        val chArr = JSONArray()
        for (ch in channels) {
            chArr.put(JSONObject().apply {
                put("streamId", ch.streamId)
                put("name", ch.name)
                put("logoUrl", ch.logoUrl)
                put("categoryName", ch.categoryName)
                put("isFavorite", ch.isFavorite)
                put("currentProgram", ch.currentProgramTitle)
            })
        }

        return JSONObject().apply {
            put("ok", true)
            put("channels", chArr)
            put("categories", JSONArray(categories))
        }.toString()
    }

    private fun handleToggleLiveFavorite(bodyStr: String): String {
        val obj = JSONObject(bodyStr.ifBlank { "{}" })
        val streamId = obj.optString("streamId")
        val isFav = db.toggleFavoriteChannel(streamId)
        return JSONObject().apply {
            put("ok", true)
            put("isFavorite", isFav)
        }.toString()
    }

    private fun handleGetSearchHistory(): String {
        val history = prefs.getRecentSearches()
        return JSONObject().apply {
            put("ok", true)
            put("history", JSONArray(history))
        }.toString()
    }

    private fun handleAddSearchHistory(bodyStr: String): String {
        val obj = JSONObject(bodyStr.ifBlank { "{}" })
        val query = obj.optString("query")
        if (query.isNotBlank()) {
            prefs.addRecentSearch(query)
        }
        return """{"ok":true}"""
    }

    private fun handleDeleteSearchHistory(bodyStr: String): String {
        val obj = JSONObject(bodyStr.ifBlank { "{}" })
        val query = obj.optString("query")
        if (query.isNotBlank()) {
            prefs.removeRecentSearch(query)
        }
        return """{"ok":true}"""
    }

    private fun handleClearSearchHistory(): String {
        prefs.clearRecentSearches()
        return """{"ok":true}"""
    }

    private fun handleParentalPin(bodyStr: String): String {
        val obj = JSONObject(bodyStr.ifBlank { "{}" })
        val action = obj.optString("action", "status")
        val pin = obj.optString("pin")
        val newPin = obj.optString("newPin")

        return when (action) {
            "status" -> {
                JSONObject().apply {
                    put("success", true)
                    put("isLocked", prefs.isParentalLocked())
                    put("showAdult", prefs.isAdultVaultUnlocked())
                    put("hasCustomPin", prefs.hasCustomParentalPin())
                }.toString()
            }
            "lock" -> {
                prefs.setAdultVaultUnlocked(false)
                JSONObject().apply {
                    put("success", true)
                    put("isLocked", true)
                    put("showAdult", false)
                }.toString()
            }
            "unlock" -> {
                val ok = prefs.verifyParentalPin(pin)
                if (ok) {
                    prefs.setAdultVaultUnlocked(true)
                    JSONObject().apply {
                        put("success", true)
                        put("isLocked", false)
                        put("showAdult", true)
                    }.toString()
                } else {
                    """{"success":false,"error":"Incorrect 4-digit PIN"}"""
                }
            }
            "set_pin" -> {
                val ok = prefs.setParentalPin(pin, newPin)
                if (ok) {
                    """{"success":true,"message":"PIN updated"}"""
                } else {
                    """{"success":false,"error":"Current PIN incorrect or new PIN invalid"}"""
                }
            }
            else -> """{"success":false,"error":"Unknown action"}"""
        }
    }

    private fun handleSaveCredentials(bodyStr: String): String {
        val obj = JSONObject(bodyStr.ifBlank { "{}" })
        val serverUrl = obj.optString("serverUrl")
        val username = obj.optString("username")
        val password = obj.optString("password")
        val playlistName = obj.optString("playlistName", "My IPTV")

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

    private fun handleSyncNow(): String {
        syncEngine.triggerSync(isManual = true)
        return """{"ok":true}"""
    }

    private fun handleFactoryReset(): String {
        prefs.clearAuthSession()
        prefs.saveCredentials(XtreamCredentials())
        prefs.clearRecentSearches()
        prefs.setAdultVaultUnlocked(false)
        db.clearCatalog()
        return """{"ok":true,"message":"Factory reset complete"}"""
    }

    private fun handleSignOut(): String {
        prefs.clearAuthSession()
        prefs.saveCredentials(XtreamCredentials())
        prefs.clearRecentSearches()
        prefs.setAdultVaultUnlocked(false)
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
        handleSaveCredentials(bodyStr)
        return JSONObject().apply {
            put("success", true)
            put("message", "Playlist updated")
        }.toString()
    }

    private fun handleDeletePlaylist(path: String): String {
        val current = prefs.loadCredentials()
        prefs.saveCredentials(current.copy(serverUrl = "", username = "", password = ""))
        return JSONObject().apply {
            put("success", true)
            put("message", "Playlist removed")
        }.toString()
    }

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
            put("versions", JSONArray(item.versions.map { v ->
                JSONObject().apply {
                    put("streamId", v.streamId)
                    put("languageTag", v.languageTag)
                    put("qualityTag", v.qualityTag)
                    put("containerExtension", v.containerExtension)
                }
            }))
        }
    }

    private fun mediaListToJsonArray(items: List<MediaItem>): JSONArray {
        val arr = JSONArray()
        for (item in items) {
            arr.put(mediaItemToJson(item))
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
