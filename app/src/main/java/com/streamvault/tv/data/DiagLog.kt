package com.streamvault.tv.data

import android.content.Context
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * A small notebook of what the app did (sync, cloud refusals, playback errors, subtitles), kept on the TV.
 * The "Report a problem" screen shows its last lines so a photo of the screen is enough to see what went wrong.
 * Never stores passwords, tokens or stream addresses.
 */
object DiagLog {
    private const val MAX_BYTES = 48 * 1024
    private val lock = Any()
    @Volatile private var file: File? = null
    private val stamp = SimpleDateFormat("MM-dd HH:mm:ss", Locale.US)

    fun init(context: Context) {
        if (file == null) file = File(context.filesDir, "diag.log")
    }

    fun add(message: String) {
        val f = file ?: return
        runCatching {
            synchronized(lock) {
                if (f.exists() && f.length() > MAX_BYTES) {
                    // keep the newest half
                    val keep = f.readLines().takeLast(120)
                    f.writeText(keep.joinToString("\n") + "\n")
                }
                f.appendText("${stamp.format(Date())}  ${clean(message)}\n")
            }
        }
    }

    fun recent(n: Int = 40): List<String> {
        val f = file ?: return emptyList()
        return runCatching { synchronized(lock) { if (f.exists()) f.readLines().takeLast(n) else emptyList() } }.getOrDefault(emptyList())
    }

    /** One line, no web addresses (stream URLs contain the account name and password). */
    fun clean(message: String): String =
        message.replace(Regex("https?://\\S+"), "<url>").replace('\n', ' ').take(220)
}
