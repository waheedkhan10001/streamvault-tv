package com.streamvault.tv.data

import java.util.Locale

object TitleParser {

    data class ParsedTitleInfo(
        val cleanTitle: String,
        val year: Int,
        val language: String,
        val qualityBadges: List<String>,
        val subtitleHint: String,
        val inferredGenres: List<String>,
        val dedupKey: String
    )

    private val LANGUAGE_PREFIX_MAP = mapOf(
        "EN" to "English", "ENG" to "English", "US" to "English", "UK" to "English",
        "HI" to "Hindi", "HIN" to "Hindi", "HINDI" to "Hindi", "BOLLYWOOD" to "Hindi", "IND" to "Hindi", "IN" to "Hindi",
        "UR" to "Urdu", "URDU" to "Urdu", "PK" to "Urdu", "PAK" to "Urdu", "PUNJABI" to "Punjabi",
        "AR" to "Arabic", "ARA" to "Arabic", "ARABIC" to "Arabic",
        "TR" to "Turkish", "TUR" to "Turkish", "TURKISH" to "Turkish",
        "KR" to "Korean", "KOR" to "Korean", "KOREAN" to "Korean",
        "JA" to "Japanese", "JP" to "Japanese", "JAP" to "Japanese", "ANIME" to "Japanese",
        "ES" to "Spanish", "ESP" to "Spanish", "LAT" to "Spanish", "SPA" to "Spanish",
        "FR" to "French", "FRE" to "French", "VF" to "French",
        "DE" to "German", "GER" to "German", "IT" to "Italian", "ITA" to "Italian",
        "PT" to "Portuguese", "BR" to "Portuguese", "RU" to "Russian", "PL" to "Polish",
        "NL" to "Dutch", "FA" to "Persian", "IR" to "Persian", "TA" to "Tamil", "TAMIL" to "Tamil",
        "TE" to "Telugu", "TELUGU" to "Telugu", "ML" to "Malayalam",
        "MULTI" to "Multi-Audio", "DUAL" to "Multi-Audio"
    )

    private val GENRE_KEYWORDS_IN_FOLDER = mapOf(
        "action" to "Action", "adventure" to "Adventure", "animat" to "Animation", "anime" to "Animation",
        "kids" to "Family", "children" to "Family", "family" to "Family", "disney" to "Family", "pixar" to "Animation",
        "comedy" to "Comedy", "standup" to "Comedy", "stand-up" to "Comedy", "crime" to "Crime", "mafia" to "Crime",
        "documentary" to "Documentary", "docu" to "Documentary", "nature" to "Documentary", "drama" to "Drama",
        "fantasy" to "Fantasy", "history" to "History", "biograph" to "History", "horror" to "Horror", "scary" to "Horror",
        "music" to "Music", "mystery" to "Mystery", "romance" to "Romance", "romantic" to "Romance",
        "sci-fi" to "Sci-Fi", "scifi" to "Sci-Fi", "science fiction" to "Sci-Fi",
        "marvel" to "Action", "dc " to "Action", "superhero" to "Action",
        "thriller" to "Thriller", "suspense" to "Thriller", "war" to "War", "western" to "Western"
    )

    private val YEAR_REGEX = Regex("""(?:^|[\s(\[._-])((?:19[2-9]\d|20[0-2]\d))(?:[\s)\]._-]|$)""")
    private val BRACKET_TAG_REGEX = Regex("""\[([^\]]+)]|\|([^|]+)\|""")
    private val LEADING_PREFIX_REGEX = Regex("""^\s*(?:\|?([A-Za-z]{2,10})\|?\s*[-:|]\s*)+""")
    private val QUALITY_NOISE_REGEX = Regex(
        """(?i)\b(4K|UHD|2160p|FHD|1080p|HD|720p|480p|HEVC|x265|H\.?265|x264|H\.?264|HDR|HDR10|DV|Dolby\s*Vision|BluRay|WEB-?DL|WEBRip|BRRip|HDTS|CAM|MULTI-?SUB|ESUB|E-?SUB|SUBBED|DUBBED|DUAL\s*AUDIO|MULTI\s*AUDIO)\b"""
    )

    fun parse(rawTitle: String, categoryName: String = "", tmdbId: Int = 0): ParsedTitleInfo {
        var working = rawTitle.trim()
        var detectedLanguage: String? = null
        val qualities = mutableSetOf<String>()
        var subtitleHint = ""

        val upperCat = categoryName.uppercase(Locale.ROOT)
        for ((code, langName) in LANGUAGE_PREFIX_MAP) {
            if (Regex("""(^|[\s|\[\-_:])$code([\s|\]\-_:]|$)""").containsMatchIn(upperCat)) {
                detectedLanguage = langName
                break
            }
        }

        val inferredGenres = mutableListOf<String>()
        val lowerCat = categoryName.lowercase(Locale.ROOT)
        for ((kw, genre) in GENRE_KEYWORDS_IN_FOLDER) {
            if (lowerCat.contains(kw) && !inferredGenres.contains(genre)) {
                inferredGenres.add(genre)
            }
        }

        BRACKET_TAG_REGEX.findAll(working).forEach { match ->
            val token = (match.groups[1]?.value ?: match.groups[2]?.value ?: "").trim().uppercase(Locale.ROOT)
            LANGUAGE_PREFIX_MAP[token]?.let { detectedLanguage = it }
            extractQualityAndSubFromToken(token, qualities)?.let { subtitleHint = it }
        }
        working = BRACKET_TAG_REGEX.replace(working, " ")

        val prefixMatch = LEADING_PREFIX_REGEX.find(working)
        if (prefixMatch != null) {
            val token = (prefixMatch.groups[1]?.value ?: "").trim().uppercase(Locale.ROOT)
            LANGUAGE_PREFIX_MAP[token]?.let {
                detectedLanguage = it
                working = working.substring(prefixMatch.range.last + 1)
            }
        }

        var extractedYear = 0
        val yearMatches = YEAR_REGEX.findAll(working).toList()
        if (yearMatches.isNotEmpty()) {
            val lastMatch = yearMatches.last()
            extractedYear = lastMatch.groupValues[1].toIntOrNull() ?: 0
            val idx = lastMatch.range.first
            if (idx > 2) {
                working = working.substring(0, idx)
            }
        } else {
            YEAR_REGEX.find(categoryName)?.groupValues?.getOrNull(1)?.toIntOrNull()?.let {
                extractedYear = it
            }
        }

        extractQualityAndSubFromToken(rawTitle.uppercase(Locale.ROOT), qualities)?.let {
            if (subtitleHint.isBlank()) subtitleHint = it
        }

        working = QUALITY_NOISE_REGEX.replace(working, " ")
        working = working
            .replace(Regex("""\(\s*\)|\[\s*]"""), " ")
            .replace('_', ' ')
            .replace(Regex("""\s+[-:|]\s*$"""), "")
            .replace(Regex("""\s{2,}"""), " ")
            .trim()

        if (working.isBlank()) {
            working = rawTitle.trim()
        }

        val finalLanguage = detectedLanguage ?: "English"
        val finalQualities = if (qualities.isEmpty()) listOf("HD") else qualities.toList()

        val normalizedAlphaNum = working.lowercase(Locale.ROOT).replace(Regex("""[^a-z0-9]"""), "")
        val dedupKey = when {
            tmdbId > 0 -> "tmdb:$tmdbId"
            extractedYear > 0 && normalizedAlphaNum.length >= 2 -> "title:$normalizedAlphaNum:$extractedYear"
            normalizedAlphaNum.length >= 3 -> "title:$normalizedAlphaNum"
            else -> "raw:${rawTitle.hashCode()}"
        }

        return ParsedTitleInfo(
            cleanTitle = working,
            year = extractedYear,
            language = finalLanguage,
            qualityBadges = finalQualities,
            subtitleHint = subtitleHint,
            inferredGenres = inferredGenres,
            dedupKey = dedupKey
        )
    }

    private fun extractQualityAndSubFromToken(upperText: String, qualities: MutableSet<String>): String? {
        if (upperText.contains("4K") || upperText.contains("UHD") || upperText.contains("2160P")) {
            qualities.add("4K")
        }
        if (upperText.contains("1080P") || upperText.contains("FHD")) {
            qualities.add("1080p")
        } else if (upperText.contains("720P")) {
            qualities.add("720p")
        }
        if (upperText.contains("HEVC") || upperText.contains("265")) {
            qualities.add("HEVC")
        }
        if (upperText.contains("HDR") || upperText.contains("DOLBY VISION") || upperText.contains(" DV ")) {
            qualities.add("HDR")
        }
        if (upperText.contains("MULTI") && upperText.contains("AUDIO") || upperText.contains("DUAL")) {
            qualities.add("Multi-Audio")
        }
        return when {
            upperText.contains("MULTI-SUB") || upperText.contains("MULTISUB") -> "Multi-Sub"
            upperText.contains("ESUB") || upperText.contains("E-SUB") || upperText.contains("ENG SUB") -> "English Sub"
            upperText.contains("SUB") -> "Subtitled"
            else -> null
        }
    }
}
