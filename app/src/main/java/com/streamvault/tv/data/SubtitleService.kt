package com.streamvault.tv.data

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Locale
import java.util.concurrent.TimeUnit

/**
 * Built-in Online Multi-Language Subtitle Downloader.
 * Queries free Wyzie Subs / OpenSubtitles / SubDL index by TMDB ID or IMDb ID
 * so even IPTV movies that have zero embedded subtitles can play with synced
 * multi-language subtitles (English, Urdu, Hindi, Arabic, Spanish, etc.)
 * plus live +/- timing offset adjustments!
 */
class SubtitleService(private val context: Context) {

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(12, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .followRedirects(true)
        .build()

    private val subtitleCacheDir = File(context.cacheDir, "downloaded_subs").apply { mkdirs() }

    private val langCodeToName = mapOf(
        "en" to "English",
        "ur" to "Urdu",
        "hi" to "Hindi",
        "ar" to "Arabic",
        "es" to "Spanish",
        "fr" to "French",
        "de" to "German",
        "tr" to "Turkish",
        "ko" to "Korean",
        "ja" to "Japanese",
        "pt" to "Portuguese",
        "ru" to "Russian",
        "it" to "Italian",
        "fa" to "Persian"
    )

    /**
     * Searches online subtitle providers for a given movie or episode by TMDB ID / IMDb ID.
     */
    suspend fun searchOnlineSubtitles(
        tmdbId: Int,
        imdbId: String,
        season: Int? = null,
        episode: Int? = null,
        preferredLangs: List<String> = listOf("en", "ur", "hi", "ar")
    ): List<SubtitleTrackItem> = withContext(Dispatchers.IO) {
        val results = mutableListOf<SubtitleTrackItem>()
        val lookupId = when {
            tmdbId > 0 -> tmdbId.toString()
            imdbId.isNotBlank() -> imdbId
            else -> return@withContext emptyList()
        }

        runCatching {
            val epParams = if (season != null && episode != null) "&season=$season&episode=$episode" else ""
            val url = "https://sub.wyzie.ru/search?id=$lookupId$epParams"
            val req = Request.Builder()
                .url(url)
                .header("User-Agent", "StreamVaultTV/1.0")
                .build()

            httpClient.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return@use
                val body = resp.body?.string() ?: return@use
                val arr = JSONArray(body)
                for (i in 0 until arr.length()) {
                    val obj = arr.getJSONObject(i)
                    val id = obj.optString("id", "sub_$i")
                    val subUrl = obj.optString("url")
                    val langCode = obj.optString("language", "en").lowercase(Locale.ROOT)
                    val displayLang = obj.optString("display", langCodeToName[langCode] ?: langCode.uppercase())
                    val format = obj.optString("format", "srt")
                    if (subUrl.isNotBlank()) {
                        results.add(
                            SubtitleTrackItem(
                                id = id,
                                label = "🌐 Online: $displayLang (${format.uppercase()})",
                                languageCode = langCode,
                                languageName = displayLang,
                                isEmbedded = false,
                                downloadUrl = subUrl,
                                format = format
                            )
                        )
                    }
                }
            }
        }

        // Sort so user's preferred subtitle languages appear at the very top of the list
        results.sortedWith(
            compareBy<SubtitleTrackItem> { item ->
                val idx = preferredLangs.indexOf(item.languageCode)
                if (idx >= 0) idx else 999
            }.thenBy { it.languageName }
        )
    }

    /**
     * Downloads an online subtitle file (.srt / .vtt) and optionally applies a timing offset
     * (e.g. +1.5s or -1.0s) so the user can fix out-of-sync IPTV subtitles on the fly!
     */
    suspend fun downloadAndPrepareSubtitleFile(
        track: SubtitleTrackItem,
        offsetMs: Long = 0L
    ): File? = withContext(Dispatchers.IO) {
        runCatching {
            val rawFile = File(subtitleCacheDir, "raw_${track.id.replace(Regex("[^a-zA-Z0-9_-]"), "")}.srt")
            if (!rawFile.exists() || rawFile.length() == 0L) {
                val req = Request.Builder().url(track.downloadUrl).header("User-Agent", "StreamVaultTV/1.0").build()
                httpClient.newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) return@withContext null
                    val bytes = resp.body?.bytes() ?: return@withContext null
                    val decoded = decodeSubtitleBytes(bytes)
                    rawFile.writeText(decoded, Charsets.UTF_8)
                }
            }
            if (offsetMs == 0L) {
                return@withContext rawFile
            }
            // Apply live SRT timestamp shift
            val shiftedFile = File(subtitleCacheDir, "shifted_${offsetMs}_${rawFile.name}")
            val shiftedContent = shiftSrtTimestamps(rawFile.readText(Charsets.UTF_8), offsetMs)
            shiftedFile.writeText(shiftedContent, Charsets.UTF_8)
            shiftedFile
        }.getOrNull()
    }

    private val SRT_TIME_LINE_REGEX = Regex(
        """(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})"""
    )

    private fun shiftSrtTimestamps(srtText: String, offsetMs: Long): String {
        return SRT_TIME_LINE_REGEX.replace(srtText) { match ->
            val startMs = parseSrtTime(
                match.groupValues[1], match.groupValues[2], match.groupValues[3], match.groupValues[4]
            )
            val endMs = parseSrtTime(
                match.groupValues[5], match.groupValues[6], match.groupValues[7], match.groupValues[8]
            )
            val newStart = (startMs + offsetMs).coerceAtLeast(0L)
            val newEnd = (endMs + offsetMs).coerceAtLeast(newStart + 100L)
            "${formatSrtTime(newStart)} --> ${formatSrtTime(newEnd)}"
        }
    }

    private fun decodeSubtitleBytes(bytes: ByteArray): String {
        if (bytes.size >= 3 && bytes[0] == 0xEF.toByte() && bytes[1] == 0xBB.toByte() && bytes[2] == 0xBF.toByte()) {
            return String(bytes, 3, bytes.size - 3, Charsets.UTF_8)
        }
        if (bytes.size >= 2 && bytes[0] == 0xFF.toByte() && bytes[1] == 0xFE.toByte()) {
            return String(bytes, 2, bytes.size - 2, Charsets.UTF_16LE)
        }
        if (bytes.size >= 2 && bytes[0] == 0xFE.toByte() && bytes[1] == 0xFF.toByte()) {
            return String(bytes, 2, bytes.size - 2, Charsets.UTF_16BE)
        }
        val utf8 = String(bytes, Charsets.UTF_8)
        if (!utf8.contains('\uFFFD')) {
            return utf8
        }
        // Fallback for Arabic / Windows-1256 or Western Windows-1252
        return runCatching {
            String(bytes, java.nio.charset.Charset.forName("windows-1256"))
        }.getOrElse {
            String(bytes, Charsets.ISO_8859_1)
        }
    }

    private fun parseSrtTime(h: String, m: String, s: String, ms: String): Long {
        return h.toLong() * 3600_000L + m.toLong() * 60_000L + s.toLong() * 1000L + ms.toLong()
    }

    private fun formatSrtTime(totalMs: Long): String {
        val h = totalMs / 3600_000L
        val rem1 = totalMs % 3600_000L
        val m = rem1 / 60_000L
        val rem2 = rem1 % 60_000L
        val s = rem2 / 1000L
        val ms = rem2 % 1000L
        return String.format(Locale.US, "%02d:%02d:%02d,%03d", h, m, s, ms)
    }
}
