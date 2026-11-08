package com.streamvault.tv.server

import android.graphics.Bitmap
import android.graphics.Color
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import com.streamvault.tv.data.PreferencesManager
import com.streamvault.tv.data.StreamVaultDatabase
import com.streamvault.tv.data.XtreamCredentials
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.Inet4Address
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import kotlin.concurrent.thread

/**
 * Lightweight embedded Wi-Fi HTTP Server running on port 8765 on the TCL TV.
 * Enables:
 * 1. Scanning a QR code on the TV to paste Xtream Server URL, Username, Password & TMDB Key from Phone/PC.
 * 2. Typing search queries on the Phone's keyboard and beaming them live to the TV screen!
 * 3. 1-Click Export / Import Backup of Watchlist, Watch Progress, and Pinned Smart Rows.
 */
class PhoneCompanionServer(
    private val prefs: PreferencesManager,
    private val db: StreamVaultDatabase,
    private val onCredentialsSaved: () -> Unit,
    private val onRemoteSearchReceived: (String) -> Unit
) {
    private var serverSocket: ServerSocket? = null
    @Volatile
    private var isRunning = false
    val port = 8765

    fun start() {
        if (isRunning) return
        isRunning = true
        thread(start = true, isDaemon = true, name = "StreamVault-CompanionServer") {
            try {
                serverSocket = ServerSocket(port)
                while (isRunning) {
                    val client = serverSocket?.accept() ?: break
                    thread(start = true, isDaemon = true) {
                        handleClient(client)
                    }
                }
            } catch (_: Exception) {
                isRunning = false
            }
        }
    }

    fun stop() {
        isRunning = false
        runCatching { serverSocket?.close() }
    }

    fun getLocalPortalUrl(): String {
        val ip = getLocalWifiIpAddress() ?: "127.0.0.1"
        return "http://$ip:$port"
    }

    private fun handleClient(socket: Socket) {
        socket.use { s ->
            s.soTimeout = 10_000
            val reader = BufferedReader(InputStreamReader(s.getInputStream(), Charsets.UTF_8))
            val requestLine = reader.readLine() ?: return
            val parts = requestLine.split(" ")
            val method = parts.getOrNull(0) ?: "GET"
            val path = parts.getOrNull(1) ?: "/"

            var contentLength = 0
            while (true) {
                val line = reader.readLine() ?: break
                if (line.isEmpty()) break
                if (line.lowercase().startsWith("content-length:")) {
                    contentLength = line.substringAfter(":").trim().toIntOrNull() ?: 0
                }
            }

            val bodyChars = CharArray(contentLength)
            var readTotal = 0
            while (readTotal < contentLength) {
                val r = reader.read(bodyChars, readTotal, contentLength - readTotal)
                if (r == -1) break
                readTotal += r
            }
            val body = String(bodyChars, 0, readTotal)

            when {
                method == "POST" && path == "/api/search" -> {
                    val params = parseFormBody(body)
                    val q = params["query"]?.trim() ?: ""
                    prefs.pushRemoteSearchFromPhone(q)
                    onRemoteSearchReceived(q)
                    sendJsonResponse(s, """{"ok":true,"query":${JSONObject.quote(q)}}""")
                }

                method == "POST" && path == "/api/save-credentials" -> {
                    val params = parseFormBody(body)
                    val current = prefs.loadCredentials()
                    val updated = current.copy(
                        playlistName = params["playlistName"]?.ifBlank { "My IPTV" } ?: current.playlistName,
                        serverUrl = params["serverUrl"] ?: current.serverUrl,
                        username = params["username"] ?: current.username,
                        password = params["password"] ?: current.password,
                        tmdbApiKey = params["tmdbApiKey"]?.ifBlank { XtreamCredentials.DEFAULT_TMDB_KEY }
                            ?: current.tmdbApiKey
                    )
                    prefs.saveCredentials(updated)
                    onCredentialsSaved()
                    sendHtmlResponse(s, buildPortalHtml(message = "✅ Credentials Saved! Your TV is now syncing your catalog."))
                }

                method == "GET" && path == "/api/export-backup" -> {
                    val json = db.exportUserDataJson()
                    val writer = OutputStreamWriter(s.getOutputStream(), Charsets.UTF_8)
                    writer.write("HTTP/1.1 200 OK\r\n")
                    writer.write("Content-Type: application/json; charset=utf-8\r\n")
                    writer.write("Content-Disposition: attachment; filename=\"streamvault-backup.json\"\r\n")
                    writer.write("Connection: close\r\n\r\n")
                    writer.write(json)
                    writer.flush()
                }

                method == "POST" && path == "/api/import-backup" -> {
                    val params = parseFormBody(body)
                    val backupJson = params["backupJson"] ?: ""
                    val ok = runCatching { db.importUserDataJson(backupJson) }.isSuccess
                    val msg = if (ok) "✅ Watchlist, Progress & Smart Rows Restored!" else "⚠️ Invalid Backup JSON."
                    sendHtmlResponse(s, buildPortalHtml(message = msg))
                }

                else -> {
                    sendHtmlResponse(s, buildPortalHtml())
                }
            }
        }
    }

    private fun parseFormBody(body: String): Map<String, String> {
        val map = mutableMapOf<String, String>()
        body.split("&").forEach { pair ->
            val idx = pair.indexOf('=')
            if (idx > 0) {
                val k = URLDecoder.decode(pair.substring(0, idx), "UTF-8")
                val v = URLDecoder.decode(pair.substring(idx + 1), "UTF-8")
                map[k] = v
            }
        }
        return map
    }

    private fun sendJsonResponse(socket: Socket, json: String) {
        val writer = OutputStreamWriter(socket.getOutputStream(), Charsets.UTF_8)
        writer.write("HTTP/1.1 200 OK\r\n")
        writer.write("Content-Type: application/json; charset=utf-8\r\n")
        writer.write("Connection: close\r\n\r\n")
        writer.write(json)
        writer.flush()
    }

    private fun sendHtmlResponse(socket: Socket, html: String) {
        val writer = OutputStreamWriter(socket.getOutputStream(), Charsets.UTF_8)
        writer.write("HTTP/1.1 200 OK\r\n")
        writer.write("Content-Type: text/html; charset=utf-8\r\n")
        writer.write("Connection: close\r\n\r\n")
        writer.write(html)
        writer.flush()
    }

    private fun buildPortalHtml(message: String? = null): String {
        val creds = prefs.loadCredentials()
        val alertBanner = if (message != null) {
            """<div style="background:#14532d;border:1px solid #22c55e;color:#fff;padding:14px;border-radius:10px;margin-bottom:18px;font-weight:600;">$message</div>"""
        } else ""

        return """
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="utf-8"/>
            <meta name="viewport" content="width=device-width,initial-scale=1"/>
            <title>StreamVault TV — Phone Remote & Setup</title>
            <style>
                body { background:#0B0C10; color:#F3F4F6; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; margin:0; padding:20px; }
                .container { max-width:540px; margin:0 auto; }
                .card { background:#161821; border:1px solid #2A2E3D; border-radius:14px; padding:20px; margin-bottom:20px; box-shadow:0 10px 30px rgba(0,0,0,0.4); }
                h1 { color:#E50914; margin:0 0 6px 0; font-size:24px; }
                h2 { margin:0 0 12px 0; font-size:18px; color:#fff; }
                label { display:block; font-size:13px; color:#9CA3AF; margin:12px 0 5px; font-weight:600; }
                input, textarea { width:100%; box-sizing:border-box; padding:12px; border-radius:8px; border:1px solid #374151; background:#0B0C10; color:#fff; font-size:15px; }
                button { width:100%; margin-top:14px; padding:13px; border:none; border-radius:8px; background:#E50914; color:#fff; font-size:16px; font-weight:700; cursor:pointer; }
                button.secondary { background:#2563EB; }
                .sub { color:#9CA3AF; font-size:13px; margin-bottom:18px; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>StreamVault TV</h1>
                <div class="sub">Phone Keyboard Remote & Easy Credential Setup (TCL 55P635)</div>
                $alertBanner

                <div class="card">
                    <h2>📱 Instant Phone-to-TV Search</h2>
                    <div class="sub">Type on your phone keyboard (or use phone voice dictation) to search Movies, Plot words, Actors, or Directors live on your TV screen!</div>
                    <input type="text" id="phoneSearchInput" placeholder="e.g. Christopher Nolan, Sci-Fi, Gladiator..." oninput="beamSearchLive(this.value)" />
                    <button class="secondary" onclick="beamSearchLive(document.getElementById('phoneSearchInput').value)">🔍 Show Results on TV Now</button>
                    <div id="searchStatus" style="font-size:12px;color:#34D399;margin-top:8px;"></div>
                </div>

                <div class="card">
                    <h2>⚡ IPTV Subscription Setup (Xtream Codes)</h2>
                    <form method="POST" action="/api/save-credentials">
                        <label>Playlist Name</label>
                        <input type="text" name="playlistName" value="${creds.playlistName}" placeholder="My IPTV" />
                        <label>Server URL (from your IPTV vendor)</label>
                        <input type="text" name="serverUrl" value="${creds.serverUrl}" placeholder="http://example-iptv.com:8080" required />
                        <label>Username</label>
                        <input type="text" name="username" value="${creds.username}" placeholder="Your username" required />
                        <label>Password</label>
                        <input type="password" name="password" value="${creds.password}" placeholder="Your password" required />
                        <label>TMDB API Key (Pre-filled free key, or paste your own)</label>
                        <input type="text" name="tmdbApiKey" value="${creds.tmdbApiKey}" />
                        <button type="submit">💾 Save & Sync TV Catalog</button>
                    </form>
                </div>

                <div class="card">
                    <h2>🛡️ 1-Click Backup & Restore</h2>
                    <a href="/api/export-backup" style="display:block;text-align:center;padding:12px;background:#374151;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;margin-bottom:12px;">⬇️ Download My Watchlist & Smart Rows (.json)</a>
                    <form method="POST" action="/api/import-backup">
                        <label>Paste Backup JSON to Restore</label>
                        <textarea name="backupJson" rows="3" placeholder='{"watchlist":...}'></textarea>
                        <button type="submit" style="background:#4B5563;">⬆️ Restore Backup to TV</button>
                    </form>
                </div>
            </div>
            <script>
                let timer = null;
                function beamSearchLive(val) {
                    clearTimeout(timer);
                    timer = setTimeout(() => {
                        fetch('/api/search', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                            body: 'query=' + encodeURIComponent(val)
                        }).then(() => {
                            document.getElementById('searchStatus').innerText = '✓ Beamed to TV: "' + val + '"';
                        });
                    }, 220);
                }
            </script>
        </body>
        </html>
        """.trimIndent()
    }

    companion object {
        fun getLocalWifiIpAddress(): String? {
            return try {
                val interfaces = NetworkInterface.getNetworkInterfaces()
                while (interfaces.hasMoreElements()) {
                    val intf = interfaces.nextElement()
                    if (intf.isLoopback || !intf.isUp) continue
                    val addrs = intf.inetAddresses
                    while (addrs.hasMoreElements()) {
                        val addr = addrs.nextElement()
                        if (addr is Inet4Address && !addr.isLoopbackAddress) {
                            return addr.hostAddress
                        }
                    }
                }
                null
            } catch (_: Exception) {
                null
            }
        }

        fun generateQrBitmap(content: String, sizePx: Int = 320): Bitmap? {
            return try {
                val matrix = QRCodeWriter().encode(content, BarcodeFormat.QR_CODE, sizePx, sizePx)
                val bmp = Bitmap.createBitmap(sizePx, sizePx, Bitmap.Config.RGB_565)
                for (x in 0 until sizePx) {
                    for (y in 0 until sizePx) {
                        bmp.setPixel(x, y, if (matrix.get(x, y)) Color.BLACK else Color.WHITE)
                    }
                }
                bmp
            } catch (_: Exception) {
                null
            }
        }
    }
}
