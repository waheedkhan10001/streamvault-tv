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
        .followRedirects(false)
        .followSslRedirects(false)
        .build()

    private fun isSafeExternalHttpsUrl(urlStr: String): Boolean {
        return runCatching {
            val uri = java.net.URI(urlStr.trim())
            if (!uri.scheme.equals("https", ignoreCase = true)) return false
            val host = uri.host?.takeIf { it.isNotBlank() } ?: return false
            val addrs = java.net.InetAddress.getAllByName(host)
            if (addrs.isEmpty()) return false
            addrs.none { addr ->
                val b = addr.address
                val isUla = b.size == 16 && (b[0].toInt() and 0xfe) == 0xfc
                addr.isAnyLocalAddress || addr.isLoopbackAddress || addr.isLinkLocalAddress ||
                    addr.isSiteLocalAddress || addr.isMulticastAddress || isUla
            }
        }.getOrDefault(false)
    }

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

    companion object {
        /** Lower-case letters and digits only, so "Spider-Man: Homecoming" and "spider man homecoming" compare equal. */
        fun normalizeTitle(t: String): String = t.lowercase(Locale.ROOT).replace(Regex("[^a-z0-9]+"), "")

        /**
         * Picks the TMDB id out of a search answer, but ONLY when it is certainly the same title:
         * the name must match exactly (ignoring punctuation/case) and, for movies, the year must match exactly.
         * Anything less sure returns 0 (no subtitles are better than another film's subtitles).
         */
        fun pickExactMatch(searchJson: String, title: String, year: Int, isSeries: Boolean): Int {
            val results = runCatching { JSONObject(searchJson).optJSONArray("results") }.getOrNull() ?: return 0
            val want = normalizeTitle(title)
            if (want.isEmpty()) return 0
            for (i in 0 until results.length()) {
                val o = results.optJSONObject(i) ?: continue
                val name = if (isSeries) o.optString("name") else o.optString("title")
                val original = if (isSeries) o.optString("original_name") else o.optString("original_title")
                if (normalizeTitle(name) != want && normalizeTitle(original) != want) continue
                if (!isSeries) {
                    val y = o.optString("release_date").take(4).toIntOrNull() ?: 0
                    if (year <= 1900 || y != year) continue
                }
                val id = o.optInt("id", 0)
                if (id > 0) return id
            }
            return 0
        }
    }

    /** For a title the app never found a TMDB/IMDb id for: asks TMDB (through the cloud) once, at play time, and accepts only an exact match. */
    suspend fun resolveTmdbIdByTitle(cloudBase: String, token: String, title: String, year: Int, isSeries: Boolean): Int = withContext(Dispatchers.IO) {
        if (!cloudBase.startsWith("https://", ignoreCase = true) || token.isBlank() || title.isBlank()) return@withContext 0
        runCatching {
            val type = if (isSeries) "tv" else "movie"
            val q = java.net.URLEncoder.encode(title, "UTF-8")
            val yearParam = if (!isSeries && year > 1900) "&year=$year" else ""
            val req = Request.Builder().url("$cloudBase/api/tmdb/search/$type?query=$q$yearParam")
                .header("Authorization", "Bearer $token").build()
            httpClient.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) 0 else pickExactMatch(resp.body?.string().orEmpty(), title, year, isSeries)
            }
        }.getOrDefault(0)
    }

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
                var currentUrl = track.downloadUrl
                var hop = 0
                var downloadedBytes: ByteArray? = null
                while (hop < 4) {
                    if (!isSafeExternalHttpsUrl(currentUrl)) return@withContext null
                    val req = Request.Builder().url(currentUrl).header("User-Agent", "StreamVaultTV/1.0").build()
                    val nextUrl = httpClient.newCall(req).execute().use { resp ->
                        if (resp.isRedirect) {
                            val loc = resp.header("Location") ?: return@withContext null
                            val resolved = java.net.URI(currentUrl).resolve(loc).toString()
                            return@use resolved
                        }
                        if (!resp.isSuccessful) return@withContext null
                        val body = resp.body ?: return@withContext null
                        val maxBytes = 2 * 1024 * 1024
                        if (body.contentLength() > maxBytes) return@withContext null
                        val baos = java.io.ByteArrayOutputStream()
                        body.byteStream().use { input ->
                            val buf = ByteArray(16 * 1024)
                            var total = 0
                            while (true) {
                                val n = input.read(buf)
                                if (n < 0) break
                                total += n
                                if (total > maxBytes) throw java.io.IOException("Subtitle exceeds 2 MB limit")
                                baos.write(buf, 0, n)
                            }
                        }
                        downloadedBytes = baos.toByteArray()
                        null
                    }
                    if (nextUrl != null) {
                        currentUrl = nextUrl
                        hop++
                    } else {
                        break
                    }
                }
                val bytes = downloadedBytes ?: return@withContext null
                val decoded = decodeSubtitleBytes(bytes)
                rawFile.writeText(decoded, Charsets.UTF_8)
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
