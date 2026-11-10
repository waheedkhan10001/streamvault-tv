package com.streamvault.tv.data

import org.json.JSONArray
import org.json.JSONObject

enum class MediaType {
    MOVIE,
    SERIES,
    LIVE
}

enum class SubtitleFilterMode(val label: String) {
    ANY("Any (All Movies)"),
    ANY_SUBTITLES("Has Subtitles (Embedded or Online)"),
    EMBEDDED_ONLY("Embedded Subtitles Inside Stream"),
    ONLINE_AVAILABLE("Online Auto-Subtitles Ready"),
    SPECIFIC_LANGUAGE("Specific Subtitle Language")
}

enum class SortOption(val label: String) {
    NEWLY_ADDED("Recently Added to IPTV"),
    RELEASE_YEAR_DESC("Release Year (Newest First)"),
    RATING_DESC("Highest Rated (IMDb / TMDB)"),
    TITLE_ASC("Title (A → Z)"),
    RANDOM("Surprise Me (Random Pick)")
}

data class XtreamCredentials(
    val playlistName: String = "My IPTV",
    val serverUrl: String = "",
    val username: String = "",
    val password: String = "",
    val tmdbApiKey: String = DEFAULT_TMDB_KEY,
    val preferredLanguages: Set<String> = setOf("English", "Hindi", "Urdu", "Multi-Audio"),
    val hiddenLanguages: Set<String> = emptySet(),
    val preferredSubtitleLanguages: List<String> = listOf("en", "ur", "hi", "ar")
) {
    val isConfigured: Boolean
        get() = serverUrl.isNotBlank() && username.isNotBlank() && password.isNotBlank()

    val normalizedServerUrl: String
        get() {
            var clean = serverUrl.trim().removeSuffix("/")
            if (!clean.startsWith("http://") && !clean.startsWith("https://")) {
                clean = "http://$clean"
            }
            return clean
        }

    companion object {
        // TMDB requests are proxied via Worker or configured via TMDB_API_KEY; no hardcoded keys in APK
        const val DEFAULT_TMDB_KEY = ""
        val KIDS_CERTIFICATIONS = setOf("G", "PG", "TV-Y", "TV-Y7", "TV-G", "TV-PG", "U")
    }
}

data class UserProfile(
    val id: String,
    val name: String,
    val avatarColor: String = "#8B5CF6",
    val isKids: Boolean = false,
    val theme: String = "purple",
    val isPrimary: Boolean = false,
    val updatedAt: Long = System.currentTimeMillis()
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id)
        put("name", name)
        put("avatarColor", avatarColor)
        put("isKids", isKids)
        put("theme", theme)
        put("isPrimary", isPrimary)
        put("updatedAt", updatedAt)
    }

    companion object {
        fun fromJson(obj: JSONObject): UserProfile = UserProfile(
            id = obj.optString("id", obj.optString("profile_id", "prof_1")),
            name = obj.optString("name", obj.optString("display_name", "User")),
            avatarColor = obj.optString("avatarColor", obj.optString("avatar_color", "#8B5CF6")),
            isKids = obj.optBoolean("isKids", obj.optInt("is_kids", 0) == 1),
            theme = obj.optString("theme", "purple"),
            isPrimary = obj.optBoolean("isPrimary", obj.optInt("is_primary", 0) == 1),
            updatedAt = obj.optLong("updatedAt", obj.optLong("updated_at", System.currentTimeMillis()))
        )
    }
}

data class StreamVersion(
    val streamId: String,
    val rawTitle: String,
    val languageTag: String,
    val qualityTag: String,
    val subtitleTag: String,
    val containerExtension: String,
    val categoryId: String,
    val categoryName: String,
    val addedTimestamp: Long
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("streamId", streamId)
        put("rawTitle", rawTitle)
        put("languageTag", languageTag)
        put("qualityTag", qualityTag)
        put("subtitleTag", subtitleTag)
        put("containerExtension", containerExtension)
        put("categoryId", categoryId)
        put("categoryName", categoryName)
        put("addedTimestamp", addedTimestamp)
    }

    companion object {
        fun fromJson(obj: JSONObject): StreamVersion = StreamVersion(
            streamId = obj.optString("streamId"),
            rawTitle = obj.optString("rawTitle"),
            languageTag = obj.optString("languageTag", "English"),
            qualityTag = obj.optString("qualityTag", "HD"),
            subtitleTag = obj.optString("subtitleTag", ""),
            containerExtension = obj.optString("containerExtension", "mp4"),
            categoryId = obj.optString("categoryId", ""),
            categoryName = obj.optString("categoryName", ""),
            addedTimestamp = obj.optLong("addedTimestamp", 0L)
        )
    }
}

data class MediaItem(
    val dedupKey: String,
    val primaryStreamId: String,
    val tmdbId: Int = 0,
    val imdbId: String = "",
    val mediaType: MediaType = MediaType.MOVIE,
    val cleanTitle: String,
    val rawTitle: String,
    val year: Int = 0,
    val rating: Double = 0.0,
    val voteCount: Int = 0,
    val genres: List<String> = emptyList(),
    val plot: String = "",
    val cast: List<String> = emptyList(),
    val director: String = "",
    val runtimeMins: Int = 0,
    val posterUrl: String = "",
    val backdropUrl: String = "",
    val language: String = "English",
    val qualityBadges: List<String> = emptyList(),
    val hasEmbeddedSubtitles: Boolean = false,
    val embeddedSubtitleLanguages: List<String> = emptyList(),
    val hasOnlineSubtitles: Boolean = true,
    val embeddedAudioLanguages: List<String> = emptyList(),
    val categoryId: String = "",
    val categoryName: String = "",
    val addedTimestamp: Long = 0L,
    val isEnriched: Boolean = false,
    val isNewlyAdded: Boolean = false,
    val inWatchlist: Boolean = false,
    val isWatched: Boolean = false,
    val resumePositionMs: Long = 0L,
    val durationMs: Long = 0L,
    val isAdult: Boolean = false,
    val certification: String = "",
    val userRating: Double = 0.0,
    val versions: List<StreamVersion> = emptyList()
) {
    val progressFraction: Float
        get() = if (durationMs > 0 && resumePositionMs > 0) {
            (resumePositionMs.toFloat() / durationMs.toFloat()).coerceIn(0f, 1f)
        } else 0f

    val availableLanguagesSummary: String
        get() {
            val all = (versions.map { it.languageTag } + embeddedAudioLanguages + listOf(language))
                .filter { it.isNotBlank() }
                .distinct()
            return all.joinToString(", ")
        }

    val subtitleSummary: String
        get() = when {
            embeddedSubtitleLanguages.isNotEmpty() -> "Embedded (${embeddedSubtitleLanguages.joinToString(", ")}) + Online Subtitles"
            hasEmbeddedSubtitles -> "Embedded Subtitles + Online Subtitles"
            tmdbId > 0 || imdbId.isNotBlank() || year > 1950 -> "Online Auto-Subtitles Available (Multi-Language)"
            else -> "Online Search Available"
        }
}

data class SeriesEpisode(
    val episodeId: String,
    val seriesId: String,
    val seasonNumber: Int,
    val episodeNumber: Int,
    val title: String,
    val plot: String = "",
    val durationSecs: Int = 0,
    val containerExtension: String = "mp4",
    val thumbnailUrl: String = "",
    val addedTimestamp: Long = 0L,
    val resumePositionMs: Long = 0L,
    val isWatched: Boolean = false
)

data class LiveChannel(
    val streamId: String,
    val name: String,
    val logoUrl: String = "",
    val categoryId: String = "",
    val categoryName: String = "General",
    val epgChannelId: String = "",
    val currentProgramTitle: String = "",
    val currentProgramTime: String = "",
    val nextProgramTitle: String = "",
    val isFavorite: Boolean = false
)

data class SuperFilterState(
    val searchQuery: String = "",
    val mediaTypeFilter: MediaType? = null, // null = All (Movies + Series)
    val includedGenres: Set<String> = emptySet(),
    val excludedGenres: Set<String> = emptySet(),
    val matchAllIncludedGenres: Boolean = true, // true = AND, false = OR
    val selectedLanguages: Set<String> = emptySet(),
    val subtitleFilterMode: SubtitleFilterMode = SubtitleFilterMode.ANY,
    val specificSubtitleLanguage: String = "English",
    val minYear: Int? = null,
    val maxYear: Int? = null,
    val decade: Int? = null, // e.g. 1990, 2000, 2010, 2020
    val minRating: Double = 0.0,
    val qualityFilter: String? = null, // e.g. "4K", "1080p", "HEVC"
    val hideWatched: Boolean = false,
    val serverCategoryId: String? = null,
    val actorFilter: String? = null,
    val directorFilter: String? = null,
    val sortBy: SortOption = SortOption.NEWLY_ADDED
) {
    val activeFilterCount: Int
        get() {
            var count = 0
            if (searchQuery.isNotBlank()) count++
            count += includedGenres.size
            count += excludedGenres.size
            count += selectedLanguages.size
            if (subtitleFilterMode != SubtitleFilterMode.ANY) count++
            if (minYear != null || maxYear != null || decade != null) count++
            if (minRating > 0.0) count++
            if (qualityFilter != null) count++
            if (hideWatched) count++
            if (serverCategoryId != null) count++
            if (actorFilter != null) count++
            if (directorFilter != null) count++
            return count
        }

    fun toSummaryString(): String {
        val parts = mutableListOf<String>()
        if (searchQuery.isNotBlank()) parts.add("\"$searchQuery\"")
        if (includedGenres.isNotEmpty()) {
            val joiner = if (matchAllIncludedGenres) " + " else " | "
            parts.add(includedGenres.joinToString(joiner))
        }
        if (excludedGenres.isNotEmpty()) {
            parts.add("NOT " + excludedGenres.joinToString(", NOT "))
        }
        if (selectedLanguages.isNotEmpty()) parts.add(selectedLanguages.joinToString("/"))
        if (decade != null) parts.add("${decade}s")
        else if (minYear != null || maxYear != null) parts.add("${minYear ?: 1900}–${maxYear ?: 2026}")
        if (minRating > 0) parts.add("★ ${minRating}+")
        if (qualityFilter != null) parts.add(qualityFilter)
        if (subtitleFilterMode != SubtitleFilterMode.ANY) parts.add("CC: ${subtitleFilterMode.label}")
        if (hideWatched) parts.add("Unwatched Only")
        if (actorFilter != null) parts.add("Cast: $actorFilter")
        if (directorFilter != null) parts.add("Dir: $directorFilter")
        return if (parts.isEmpty()) "All Titles (${sortBy.label})" else parts.joinToString(" • ")
    }

    fun toJson(): JSONObject = JSONObject().apply {
        put("searchQuery", searchQuery)
        put("mediaTypeFilter", mediaTypeFilter?.name ?: "")
        put("includedGenres", JSONArray(includedGenres.toList()))
        put("excludedGenres", JSONArray(excludedGenres.toList()))
        put("matchAllIncludedGenres", matchAllIncludedGenres)
        put("selectedLanguages", JSONArray(selectedLanguages.toList()))
        put("subtitleFilterMode", subtitleFilterMode.name)
        put("specificSubtitleLanguage", specificSubtitleLanguage)
        if (minYear != null) put("minYear", minYear)
        if (maxYear != null) put("maxYear", maxYear)
        if (decade != null) put("decade", decade)
        put("minRating", minRating)
        if (qualityFilter != null) put("qualityFilter", qualityFilter)
        put("hideWatched", hideWatched)
        if (serverCategoryId != null) put("serverCategoryId", serverCategoryId)
        if (actorFilter != null) put("actorFilter", actorFilter)
        if (directorFilter != null) put("directorFilter", directorFilter)
        put("sortBy", sortBy.name)
    }

    companion object {
        fun fromJson(obj: JSONObject): SuperFilterState {
            val inc = mutableSetOf<String>()
            obj.optJSONArray("includedGenres")?.let { arr ->
                for (i in 0 until arr.length()) inc.add(arr.getString(i))
            }
            val exc = mutableSetOf<String>()
            obj.optJSONArray("excludedGenres")?.let { arr ->
                for (i in 0 until arr.length()) exc.add(arr.getString(i))
            }
            val langs = mutableSetOf<String>()
            obj.optJSONArray("selectedLanguages")?.let { arr ->
                for (i in 0 until arr.length()) langs.add(arr.getString(i))
            }
            val mt = obj.optString("mediaTypeFilter")
            return SuperFilterState(
                searchQuery = obj.optString("searchQuery", ""),
                mediaTypeFilter = if (mt.isNotBlank()) runCatching { MediaType.valueOf(mt) }.getOrNull() else null,
                includedGenres = inc,
                excludedGenres = exc,
                matchAllIncludedGenres = obj.optBoolean("matchAllIncludedGenres", true),
                selectedLanguages = langs,
                subtitleFilterMode = runCatching {
                    SubtitleFilterMode.valueOf(obj.optString("subtitleFilterMode", "ANY"))
                }.getOrDefault(SubtitleFilterMode.ANY),
                specificSubtitleLanguage = obj.optString("specificSubtitleLanguage", "English"),
                minYear = if (obj.has("minYear")) obj.optInt("minYear") else null,
                maxYear = if (obj.has("maxYear")) obj.optInt("maxYear") else null,
                decade = if (obj.has("decade")) obj.optInt("decade") else null,
                minRating = obj.optDouble("minRating", 0.0),
                qualityFilter = obj.optString("qualityFilter").takeIf { it.isNotBlank() },
                hideWatched = obj.optBoolean("hideWatched", false),
                serverCategoryId = obj.optString("serverCategoryId").takeIf { it.isNotBlank() },
                actorFilter = obj.optString("actorFilter").takeIf { it.isNotBlank() },
                directorFilter = obj.optString("directorFilter").takeIf { it.isNotBlank() },
                sortBy = runCatching {
                    SortOption.valueOf(obj.optString("sortBy", "NEWLY_ADDED"))
                }.getOrDefault(SortOption.NEWLY_ADDED)
            )
        }
    }
}

data class PinnedSmartRow(
    val id: String,
    val title: String,
    val filterState: SuperFilterState
)

data class SubtitleTrackItem(
    val id: String,
    val label: String,
    val languageCode: String,
    val languageName: String,
    val isEmbedded: Boolean,
    val downloadUrl: String = "",
    val format: String = "srt"
)

data class SyncProgressState(
    val isSyncing: Boolean = false,
    val phase: String = "Idle",
    val totalItems: Int = 0,
    val processedItems: Int = 0,
    val newlyAddedCount: Int = 0,
    val enrichedCount: Int = 0,
    val totalToEnrich: Int = 0,
    val lastSyncTimestamp: Long = 0L,
    val errorMessage: String? = null
)
