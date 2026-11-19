package com.streamvault.tv.data

import android.content.Context
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import java.util.zip.GZIPInputStream

/**
 * Downloads, checks and unpacks the StreamVault enrichments pack (ONE file, see tools/enrichments-test/pack-format.cjs).
 *
 *  pack = [4096-byte header][gzip SQLite database][posters, JPEGs back to back]
 *
 * Files live in filesDir/pack/:
 *   streamvault-pack.svpack.part   download in progress (resumes with an HTTP Range request)
 *   streamvault-pack.svpack        finished, checked pack (posters are read straight from this file by position)
 *   enrich.db                      the unpacked database
 *   installed.json                 manifest of the installed pack (only written when everything is checked)
 *
 * The pack is only marked installed after the whole-file checksum and the database checksum both match.
 * An interrupted or failed run never damages an installed pack: the new one is built next to it and swapped in last.
 */
class PackManager(private val context: Context, private val prefs: PreferencesManager) {

    enum class Phase { IDLE, CHECKING, DOWNLOADING, VERIFYING, UNPACKING, READY, ERROR }

    data class Status(
        val phase: Phase = Phase.IDLE,
        val bytesDone: Long = 0,
        val bytesTotal: Long = 0,
        val version: String = "",
        val message: String = ""
    ) {
        fun toJson(): JSONObject = JSONObject()
            .put("phase", phase.name)
            .put("bytesDone", bytesDone)
            .put("bytesTotal", bytesTotal)
            .put("version", version)
            .put("message", message)
    }

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .followRedirects(true)
        .followSslRedirects(false)
        .build()

    private val dir: File get() = File(context.filesDir, "pack").also { it.mkdirs() }
    val packFile: File get() = File(dir, "streamvault-pack.svpack")
    val dbFile: File get() = File(dir, "enrich.db")
    private val partFile: File get() = File(dir, "streamvault-pack.svpack.part")
    private val partInfoFile: File get() = File(dir, "download.json") // which version the .part file belongs to
    private val installedFile: File get() = File(dir, "installed.json")

    private val status = AtomicReference(Status())
    @Volatile private var cancelled = false

    fun currentStatus(): Status = status.get()

    fun installedVersion(): String? = runCatching {
        if (!packFile.exists() || !dbFile.exists()) null
        else JSONObject(installedFile.readText()).optString("version").takeIf { it.isNotBlank() }
    }.getOrNull()

    fun isReady(): Boolean = installedVersion() != null

    fun cancel() { cancelled = true }

    private fun set(phase: Phase, done: Long = 0, total: Long = 0, version: String = "", message: String = "") {
        status.set(Status(phase, done, total, version, message))
    }

    private fun get(url: String, token: String, range: String? = null): okhttp3.Response {
        val b = Request.Builder().url(url).header("Authorization", "Bearer $token")
        if (range != null) b.header("Range", range)
        return httpClient.newCall(b.build()).execute()
    }

    /** Returns the manifest of the newest pack in the cloud, or null if it cannot be read. */
    fun fetchLatestManifest(): JSONObject? {
        val token = prefs.getAuthToken() ?: return null
        val base = prefs.getCloudSyncBaseUrl().takeIf { it.startsWith("https://", ignoreCase = true) } ?: return null
        return runCatching {
            get("$base/api/pack/latest", token).use { r ->
                if (!r.isSuccessful) return null
                JSONObject(r.body?.string() ?: return null).optJSONObject("pack")
            }
        }.getOrNull()
    }

    /**
     * Full run: check what is in the cloud, download (resuming if possible), verify, unpack.
     * Blocking: call from a background thread. Safe to call again after any failure; it resumes.
     * Returns true when a pack is installed and ready (this one or the one already installed).
     */
    fun downloadAndInstall(): Boolean {
        postersBase = -1L
        cancelled = false
        val token = prefs.getAuthToken()
        if (token == null) { set(Phase.ERROR, message = "Sign in first"); return isReady() }
        try {
            set(Phase.CHECKING, message = "Checking for the content pack")
            val manifest = fetchLatestManifest()
            if (manifest == null) {
                set(Phase.ERROR, message = "Could not reach the server. Try again.")
                return isReady()
            }
            val version = manifest.optString("version")
            val size = manifest.optLong("size")
            val sha = manifest.optString("sha256")
            if (version.isBlank() || size <= 0 || sha.length != 64) {
                set(Phase.ERROR, message = "The server's pack information is incomplete")
                return isReady()
            }
            if (installedVersion() == version) { set(Phase.READY, size, size, version); return true }

            // ---- download (resume only if the partial file belongs to this same version)
            val part = partFile
            val info = runCatching { JSONObject(partInfoFile.readText()) }.getOrNull()
            if (info == null || info.optString("version") != version || info.optString("sha256") != sha) {
                part.delete()
                partInfoFile.writeText(JSONObject().put("version", version).put("sha256", sha).toString())
            }
            if (part.exists() && part.length() > size) part.delete()
            var have = if (part.exists()) part.length() else 0L

            var stalls = 0
            while (have < size) {
                if (cancelled) { set(Phase.ERROR, have, size, version, "Download paused"); return isReady() }
                set(Phase.DOWNLOADING, have, size, version)
                var progressed = false
                try {
                    get("${prefs.getCloudSyncBaseUrl()}/api/pack/file", token, "bytes=$have-").use { r ->
                        if (r.code == 416) { part.delete(); have = 0; return@use }
                        if (r.code != 206 && r.code != 200) throw java.io.IOException("Server answered ${r.code}")
                        val body = r.body ?: throw java.io.IOException("Empty answer")
                        // 200 means the server ignored Range: start the file again
                        if (r.code == 200 && have > 0) { part.delete(); have = 0 }
                        FileOutputStream(part, true).use { out ->
                            val buf = ByteArray(256 * 1024)
                            body.byteStream().use { input ->
                                var lastPublish = 0L
                                while (true) {
                                    if (cancelled) break
                                    val n = input.read(buf)
                                    if (n < 0) break
                                    out.write(buf, 0, n)
                                    have += n
                                    progressed = true
                                    val now = System.currentTimeMillis()
                                    if (now - lastPublish > 400) { lastPublish = now; set(Phase.DOWNLOADING, have, size, version) }
                                }
                            }
                        }
                    }
                } catch (e: Exception) {
                    // connection dropped: keep what we have and try again from there
                }
                have = if (part.exists()) part.length() else 0L
                if (progressed) stalls = 0 else stalls++
                if (stalls >= 5) {
                    set(Phase.ERROR, have, size, version, "Download interrupted. It will continue from where it stopped.")
                    return isReady()
                }
                if (have < size) Thread.sleep(1500L * (stalls + 1))
            }

            // ---- verify whole file
            set(Phase.VERIFYING, size, size, version, "Checking the download")
            if (part.length() != size || sha256(part) != sha) {
                part.delete(); partInfoFile.delete()
                set(Phase.ERROR, 0, size, version, "The download was damaged. Starting again will fix it.")
                return isReady()
            }

            // ---- unpack the database next to the old one, then swap
            set(Phase.UNPACKING, size, size, version, "Preparing the content")
            val header = readHeader(part)
            val dbOffset = header.optLong("dbOffset", -1L)
            val dbGzLength = header.optLong("dbGzLength", -1L)
            val dbRawLength = header.optLong("dbRawLength", -1L)
            val maxDbRaw = 256L * 1024L * 1024L
            if (dbOffset < 4096L || dbGzLength <= 0L || dbOffset + dbGzLength > part.length() || dbRawLength !in 1L..maxDbRaw) {
                throw java.io.IOException("Invalid pack database bounds")
            }
            if (dir.usableSpace in 1L until (dbRawLength + 32L * 1024L * 1024L)) {
                throw java.io.IOException("Not enough free space to unpack content database")
            }
            val dbTmp = File(dir, "enrich.db.new")
            dbTmp.delete()
            RandomAccessFile(part, "r").use { raf ->
                raf.seek(dbOffset)
                val limited = java.io.BufferedInputStream(LimitedStream(java.nio.channels.Channels.newInputStream(raf.channel), dbGzLength))
                GZIPInputStream(limited, 64 * 1024).use { gz ->
                    FileOutputStream(dbTmp).use { out ->
                        val buf = ByteArray(256 * 1024)
                        var written = 0L
                        while (true) {
                            val n = gz.read(buf)
                            if (n < 0) break
                            written += n
                            if (written > dbRawLength) {
                                throw java.io.IOException("Decompressed pack database exceeds declared size")
                            }
                            out.write(buf, 0, n)
                        }
                    }
                }
            }
            if (dbTmp.length() != header.optLong("dbRawLength") || sha256(dbTmp) != header.optString("dbSha256")) {
                dbTmp.delete()
                set(Phase.ERROR, 0, size, version, "The content database did not check out")
                return isReady()
            }
            // swap: new pack + db in, old ones out
            val packNew = File(dir, "streamvault-pack.svpack.new")
            packNew.delete()
            if (!part.renameTo(packNew)) throw java.io.IOException("Could not store the pack")
            installedFile.delete() // while swapping, the pack counts as not installed
            packFile.delete(); dbFile.delete()
            if (!packNew.renameTo(packFile) || !dbTmp.renameTo(dbFile)) throw java.io.IOException("Could not store the pack")
            installedFile.writeText(manifest.toString())
            partInfoFile.delete()
            set(Phase.READY, size, size, version)
            return true
        } catch (e: Exception) {
            set(Phase.ERROR, message = "Something went wrong: ${e.message ?: e.javaClass.simpleName}")
            return isReady()
        }
    }

    /** Poster bytes for a title row (poster_off / poster_len from the database), read straight from the pack file. */
    @Volatile private var postersBase = -1L
    fun readPoster(posterOff: Long, posterLen: Int): ByteArray? {
        if (posterOff < 0L || posterLen !in 1..(2 * 1024 * 1024) || !packFile.exists()) return null
        return runCatching {
            if (postersBase < 0L) postersBase = readHeader(packFile).optLong("postersOffset", -1L)
            val base = postersBase
            if (base < 4096L) return null
            RandomAccessFile(packFile, "r").use { raf ->
                val fileLen = raf.length()
                if (posterOff > fileLen || base + posterOff + posterLen > fileLen) return null
                raf.seek(base + posterOff)
                ByteArray(posterLen).also { raf.readFully(it) }
            }
        }.getOrNull()
    }

    internal fun readHeader(f: File): JSONObject {
        RandomAccessFile(f, "r").use { raf ->
            val hb = ByteArray(4096)
            raf.readFully(hb)
            if (String(hb, 0, 8, Charsets.US_ASCII) != "SVPACK01") throw java.io.IOException("Not a StreamVault pack")
            val len = (hb[8].toInt() and 0xff) or ((hb[9].toInt() and 0xff) shl 8) or ((hb[10].toInt() and 0xff) shl 16) or ((hb[11].toInt() and 0xff) shl 24)
            if (len !in 2..4084) throw java.io.IOException("Invalid pack header length: $len")
            return JSONObject(String(hb, 12, len, Charsets.UTF_8))
        }
    }

    private fun sha256(f: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        f.inputStream().use { input ->
            val buf = ByteArray(512 * 1024)
            while (true) { val n = input.read(buf); if (n < 0) break; md.update(buf, 0, n) }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    /** Reads at most [limit] bytes of the wrapped stream (so gzip stops at the end of the database section). */
    private class LimitedStream(private val src: java.io.InputStream, private var left: Long) : java.io.InputStream() {
        override fun read(): Int { if (left <= 0) return -1; val b = src.read(); if (b >= 0) left--; return b }
        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (left <= 0) return -1
            val n = src.read(b, off, minOf(len.toLong(), left).toInt())
            if (n > 0) left -= n
            return n
        }
    }
}
