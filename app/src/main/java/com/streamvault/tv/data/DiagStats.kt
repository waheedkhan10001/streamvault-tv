package com.streamvault.tv.data

import java.util.concurrent.ConcurrentHashMap

/**
 * Numbers for the "Report a problem" screen: how long each kind of request takes (count, average, 95th percentile, slowest),
 * how long each Home row takes, how fast the details fill runs, and what the screen itself reports (long freezes, errors,
 * tab opening times). Kept in memory only; contains no passwords, tokens or stream addresses.
 */
object DiagStats {
    private class Series {
        var count = 0L; var total = 0L; var max = 0L
        val recent = LongArray(60); var pos = 0; var filled = 0
        @Synchronized fun add(ms: Long) {
            count++; total += ms; if (ms > max) max = ms
            recent[pos] = ms; pos = (pos + 1) % recent.size; if (filled < recent.size) filled++
        }
        @Synchronized fun line(name: String): String {
            val s = recent.take(filled).sorted()
            val p95 = if (s.isEmpty()) 0 else s[((s.size - 1) * 95) / 100]
            return "$name  n=$count  avg=${if (count > 0) total / count else 0}  p95=$p95  max=$max ms"
        }
    }

    private val endpoints = ConcurrentHashMap<String, Series>()
    private val homeRows = ConcurrentHashMap<String, Series>()
    private val jsEvents = java.util.ArrayDeque<String>()
    private val stamp = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US)

    @Volatile var fillTitlesDone = 0L
    @Volatile var fillMsTotal = 0L
    @Volatile var fillBatches = 0L
    @Volatile var fillWorstBatchMs = 0L
    @Volatile var fillPausedMs = 0L

    /** Groups ids out of the path so the same kind of request is counted together. */
    private fun normal(path: String): String = path.replace(Regex("/[0-9a-fA-F_:-]{6,}"), "/*").take(48)

    fun request(method: String, path: String, ms: Long) { endpoints.getOrPut("$method ${normal(path)}") { Series() }.add(ms) }
    fun homeRow(name: String, ms: Long) { homeRows.getOrPut(name) { Series() }.add(ms) }
    fun fillBatch(titles: Int, ms: Long) {
        fillTitlesDone += titles; fillMsTotal += ms; fillBatches++
        if (ms > fillWorstBatchMs) fillWorstBatchMs = ms
    }

    @Synchronized fun js(lines: List<String>) {
        for (l in lines) { jsEvents.addLast("${stamp.format(java.util.Date())} ${DiagLog.clean(l)}"); while (jsEvents.size > 80) jsEvents.removeFirst() }
    }
    @Synchronized fun jsRecent(n: Int): List<String> = jsEvents.toList().takeLast(n)

    fun endpointLines(): List<String> = endpoints.entries.sortedByDescending { it.value.max }.take(14).map { it.value.line(it.key) }
    fun homeRowLines(): List<String> = homeRows.entries.sortedBy { it.key }.map { it.value.line(it.key) }
    fun fillLine(): String =
        if (fillBatches == 0L) "Fill this session: not run yet"
        else "Fill this session: $fillTitlesDone titles in ${fillBatches} batches, avg ${fillMsTotal / fillBatches} ms/batch " +
            "(${if (fillTitlesDone > 0) fillMsTotal / fillTitlesDone else 0} ms/title), worst batch $fillWorstBatchMs ms, paused for you ${fillPausedMs / 1000} s"
}
