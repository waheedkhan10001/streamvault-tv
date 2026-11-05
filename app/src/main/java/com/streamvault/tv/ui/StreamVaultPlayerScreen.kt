package com.streamvault.tv.ui

import android.net.Uri
import android.util.TypedValue
import android.view.KeyEvent
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.activity.compose.BackHandler
import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.C
import androidx.media3.common.MediaItem as ExoMediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import com.streamvault.tv.data.MediaItem
import com.streamvault.tv.data.PreferencesManager
import com.streamvault.tv.data.SeriesEpisode
import com.streamvault.tv.data.StreamVaultDatabase
import com.streamvault.tv.data.SubtitleService
import com.streamvault.tv.data.SubtitleTrackItem
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.Locale

@OptIn(UnstableApi::class)
@Composable
fun StreamVaultPlayerScreen(
    title: String,
    subtitleInfo: String,
    streamUrl: String,
    mediaItem: MediaItem?,
    episode: SeriesEpisode?,
    nextEpisode: SeriesEpisode?,
    db: StreamVaultDatabase,
    prefs: PreferencesManager,
    subtitleService: SubtitleService,
    onPlayNextEpisode: (SeriesEpisode) -> Unit,
    onClosePlayer: () -> Unit
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var isPlaying by remember { mutableStateOf(true) }
    var currentPosMs by remember { mutableStateOf(episode?.resumePositionMs ?: mediaItem?.resumePositionMs ?: 0L) }
    var durationMs by remember { mutableStateOf(mediaItem?.durationMs ?: 0L) }
    var showOsd by remember { mutableStateOf(true) }
    var activeModal by remember { mutableStateOf<String?>(null) } // "SUBTITLES", "AUDIO"
    var statusBanner by remember { mutableStateOf<String?>(null) }
    var reconnectCount by remember { mutableStateOf(0) }

    // Subtitle & Aspect Ratio states
    var onlineSubtitles by remember { mutableStateOf<List<SubtitleTrackItem>>(emptyList()) }
    var isSearchingOnlineSubs by remember { mutableStateOf(false) }
    var selectedOnlineSub by remember { mutableStateOf<SubtitleTrackItem?>(null) }
    var subtitleOffsetMs by remember { mutableStateOf(0L) }
    var subtitleFontScale by remember { mutableStateOf(1.0f) }
    var resizeMode by remember { mutableStateOf(AspectRatioFrameLayout.RESIZE_MODE_FIT) }

    // Embedded tracks discovered inside the stream
    var embeddedAudioTracks by remember { mutableStateOf<List<Pair<String, TrackSelectionOverride>>>(emptyList()) }
    var embeddedSubTracks by remember { mutableStateOf<List<Pair<String, TrackSelectionOverride>>>(emptyList()) }

    // Build ExoPlayer with 30-second anti-freeze IPTV RAM buffer + software decoder fallback
    val exoPlayer = remember(streamUrl) {
        prefs.isPlaybackActive.set(true)
        val loadControl = DefaultLoadControl.Builder()
            .setBufferDurationsMs(
                15_000, // Min buffer 15s
                45_000, // Max buffer 45s
                2_500,  // Buffer for playback start
                5_000   // Buffer after rebuffer
            )
            .build()

        val renderersFactory = DefaultRenderersFactory(context)
            .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_PREFER)
            .setEnableDecoderFallback(true)

        ExoPlayer.Builder(context, renderersFactory)
            .setLoadControl(loadControl)
            .build().apply {
                val exoItem = ExoMediaItem.fromUri(streamUrl)
                setMediaItem(exoItem)
                val startPos = episode?.resumePositionMs ?: mediaItem?.resumePositionMs ?: 0L
                if (startPos > 5_000L) {
                    seekTo(startPos)
                }
                prepare()
                playWhenReady = true
            }
    }

    // Fetch available online subtitles automatically in the background when player starts
    LaunchedEffect(mediaItem?.tmdbId, mediaItem?.imdbId, episode?.episodeId) {
        if (mediaItem != null && (mediaItem.tmdbId > 0 || mediaItem.imdbId.isNotBlank())) {
            isSearchingOnlineSubs = true
            val subs = subtitleService.searchOnlineSubtitles(
                tmdbId = mediaItem.tmdbId,
                imdbId = mediaItem.imdbId,
                season = episode?.seasonNumber,
                episode = episode?.episodeNumber,
                preferredLangs = prefs.loadCredentials().preferredSubtitleLanguages
            )
            onlineSubtitles = subs
            isSearchingOnlineSubs = false
        }
    }

    // Helper to attach a downloaded .srt file to ExoPlayer at the current playback position
    fun applyOnlineSubtitleToPlayer(track: SubtitleTrackItem, offsetMs: Long) {
        scope.launch {
            statusBanner = "Downloading ${track.languageName} Subtitles..."
            val srtFile = subtitleService.downloadAndPrepareSubtitleFile(track, offsetMs)
            if (srtFile != null) {
                val savedPos = exoPlayer.currentPosition
                val subConfig = ExoMediaItem.SubtitleConfiguration.Builder(Uri.fromFile(srtFile))
                    .setMimeType(MimeTypes.APPLICATION_SUBRIP)
                    .setLanguage(track.languageCode)
                    .setLabel(track.label)
                    .setSelectionFlags(C.SELECTION_FLAG_DEFAULT)
                    .build()
                val newItem = ExoMediaItem.Builder()
                    .setUri(streamUrl)
                    .setSubtitleConfigurations(listOf(subConfig))
                    .build()
                exoPlayer.setMediaItem(newItem, savedPos)
                exoPlayer.prepare()
                exoPlayer.playWhenReady = true
                selectedOnlineSub = track
                statusBanner = "✓ Loaded ${track.languageName} Subtitles (Offset: ${offsetMs / 1000.0}s)"
                delay(3500)
                statusBanner = null
            } else {
                statusBanner = "⚠️ Could not download subtitle file."
                delay(3000)
                statusBanner = null
            }
        }
    }

    // Listen to ExoPlayer events (Embedded Tracks Discovery + Auto-Reconnect on IPTV Drop)
    DisposableEffect(exoPlayer) {
        val listener = object : Player.Listener {
            override fun onIsPlayingChanged(playing: Boolean) {
                isPlaying = playing
            }

            override fun onTracksChanged(tracks: Tracks) {
                val audList = mutableListOf<Pair<String, TrackSelectionOverride>>()
                val subList = mutableListOf<Pair<String, TrackSelectionOverride>>()
                val discoveredSubLangs = mutableListOf<String>()
                val discoveredAudLangs = mutableListOf<String>()

                for (group in tracks.groups) {
                    if (group.type == C.TRACK_TYPE_AUDIO) {
                        for (i in 0 until group.length) {
                            val fmt = group.getTrackFormat(i)
                            val lang = fmt.language?.let { Locale(it).displayLanguage } ?: "Track ${i + 1}"
                            val channels = if (fmt.channelCount > 0) "${fmt.channelCount}ch" else ""
                            val label = "$lang ${fmt.sampleMimeType?.substringAfter("/")?.uppercase() ?: ""} $channels".trim()
                            audList.add(label to TrackSelectionOverride(group.mediaTrackGroup, i))
                            if (lang.isNotBlank()) discoveredAudLangs.add(lang)
                        }
                    } else if (group.type == C.TRACK_TYPE_TEXT) {
                        for (i in 0 until group.length) {
                            val fmt = group.getTrackFormat(i)
                            val lang = fmt.language?.let { Locale(it).displayLanguage } ?: fmt.label ?: "Subtitle ${i + 1}"
                            subList.add("📦 Embedded: $lang" to TrackSelectionOverride(group.mediaTrackGroup, i))
                            if (lang.isNotBlank()) discoveredSubLangs.add(lang)
                        }
                    }
                }
                embeddedAudioTracks = audList
                embeddedSubTracks = subList

                if (mediaItem != null && (discoveredSubLangs.isNotEmpty() || discoveredAudLangs.isNotEmpty())) {
                    db.recordDiscoveredStreamTracks(mediaItem.dedupKey, discoveredSubLangs, discoveredAudLangs)
                }
            }

            override fun onPlayerError(error: PlaybackException) {
                if (reconnectCount < 3) {
                    reconnectCount++
                    val resumeAt = exoPlayer.currentPosition
                    statusBanner = "Stream hiccup detected — Auto-Reconnecting ($reconnectCount/3)..."
                    scope.launch {
                        delay(1500)
                        if (resumeAt > 0) exoPlayer.seekTo(resumeAt)
                        exoPlayer.prepare()
                        exoPlayer.playWhenReady = true
                        delay(2500)
                        statusBanner = null
                    }
                } else {
                    statusBanner = "Stream Error (${error.errorCodeName}). Try switching Version/Quality."
                }
            }
        }
        exoPlayer.addListener(listener)

        onDispose {
            val finalPos = exoPlayer.currentPosition
            val finalDur = exoPlayer.duration.coerceAtLeast(0L)
            if (episode != null) {
                db.saveEpisodeProgress(episode.episodeId, finalPos, finalDur)
            } else if (mediaItem != null) {
                db.savePlaybackProgress(mediaItem.dedupKey, finalPos, finalDur)
            }
            exoPlayer.removeListener(listener)
            exoPlayer.release()
            prefs.isPlaybackActive.set(false)
        }
    }

    // Periodic progress saver & OSD auto-hide timer
    LaunchedEffect(exoPlayer) {
        while (true) {
            currentPosMs = exoPlayer.currentPosition.coerceAtLeast(0L)
            val d = exoPlayer.duration
            if (d > 0) durationMs = d
            delay(1000)
        }
    }

    BackHandler {
        if (activeModal != null) {
            activeModal = null
        } else if (showOsd) {
            showOsd = false
        } else {
            onClosePlayer()
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black)
            .onKeyEvent { event ->
                if (event.nativeKeyEvent.action == KeyEvent.ACTION_DOWN) {
                    when (event.nativeKeyEvent.keyCode) {
                        KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> {
                            if (!showOsd && activeModal == null) {
                                showOsd = true
                                true
                            } else false
                        }
                        KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> {
                            if (exoPlayer.isPlaying) exoPlayer.pause() else exoPlayer.play()
                            showOsd = true
                            true
                        }
                        KeyEvent.KEYCODE_DPAD_LEFT -> {
                            if (!showOsd && activeModal == null) {
                                exoPlayer.seekTo((exoPlayer.currentPosition - 15_000L).coerceAtLeast(0L))
                                showOsd = true
                                true
                            } else false
                        }
                        KeyEvent.KEYCODE_DPAD_RIGHT -> {
                            if (!showOsd && activeModal == null) {
                                exoPlayer.seekTo(exoPlayer.currentPosition + 30_000L)
                                showOsd = true
                                true
                            } else false
                        }
                        else -> false
                    }
                } else false
            }
    ) {
        // ExoPlayer Hardware Video Surface
        AndroidView(
            factory = { ctx ->
                PlayerView(ctx).apply {
                    useController = false
                    layoutParams = FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT
                    )
                    player = exoPlayer
                }
            },
            update = { view ->
                view.player = exoPlayer
                view.resizeMode = resizeMode
                view.subtitleView?.setFixedTextSize(TypedValue.COMPLEX_UNIT_SP, 22f * subtitleFontScale)
            },
            modifier = Modifier
                .fillMaxSize()
                .clickable { showOsd = !showOsd }
        )

        // Status / Auto-Reconnect / Subtitle Download Banner
        if (statusBanner != null) {
            Box(
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .padding(top = 28.dp)
                    .background(Color(0xDD161821), RoundedCornerShape(10.dp))
                    .border(1.dp, Color(0xFFE50914), RoundedCornerShape(10.dp))
                    .padding(horizontal = 20.dp, vertical = 10.dp)
            ) {
                Text(statusBanner ?: "", color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
            }
        }

        // Custom Netflix-Grade TV OSD Overlay
        if (showOsd && activeModal == null) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(
                        Brush.verticalGradient(
                            listOf(Color(0xCC000000), Color.Transparent, Color(0xEE000000))
                        )
                    )
                    .padding(32.dp)
            ) {
                // Top Bar: Title + Metadata
                Row(
                    modifier = Modifier.fillMaxWidth().align(Alignment.TopStart),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column {
                        Text(title, color = Color.White, fontSize = 24.sp, fontWeight = FontWeight.Bold)
                        if (subtitleInfo.isNotBlank()) {
                            Text(subtitleInfo, color = Color(0xFF9CA3AF), fontSize = 14.sp)
                        }
                    }
                    TvOsdButton("✕ Close Player") { onClosePlayer() }
                }

                // Bottom Controls Bar
                Column(modifier = Modifier.fillMaxWidth().align(Alignment.BottomCenter)) {
                    // Progress Bar & Timestamps
                    if (durationMs > 0) {
                        val progress = (currentPosMs.toFloat() / durationMs.toFloat()).coerceIn(0f, 1f)
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(formatDurationMs(currentPosMs), color = Color.White, fontSize = 13.sp)
                            LinearProgressIndicator(
                                progress = progress,
                                modifier = Modifier
                                    .weight(1f)
                                    .padding(horizontal = 14.dp)
                                    .height(6.dp),
                                color = Color(0xFFE50914),
                                trackColor = Color(0x55FFFFFF)
                            )
                            Text(formatDurationMs(durationMs), color = Color.White, fontSize = 13.sp)
                        }
                        Spacer(modifier = Modifier.height(14.dp))
                    }

                    // Action Buttons Row
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        TvOsdButton(if (isPlaying) "⏸ Pause" else "▶ Play", isPrimary = true) {
                            if (exoPlayer.isPlaying) exoPlayer.pause() else exoPlayer.play()
                        }
                        TvOsdButton("⏪ -15s") {
                            exoPlayer.seekTo((exoPlayer.currentPosition - 15_000L).coerceAtLeast(0L))
                        }
                        TvOsdButton("⏩ +30s") {
                            exoPlayer.seekTo(exoPlayer.currentPosition + 30_000L)
                        }
                        TvOsdButton(
                            "💬 Subtitles (${embeddedSubTracks.size + onlineSubtitles.size})"
                        ) {
                            activeModal = "SUBTITLES"
                        }
                        TvOsdButton("🔊 Audio (${embeddedAudioTracks.size.coerceAtLeast(1)})") {
                            activeModal = "AUDIO"
                        }
                        TvOsdButton(
                            when (resizeMode) {
                                AspectRatioFrameLayout.RESIZE_MODE_FILL -> "📐 Fill"
                                AspectRatioFrameLayout.RESIZE_MODE_ZOOM -> "📐 Zoom"
                                else -> "📐 Fit"
                            }
                        ) {
                            resizeMode = when (resizeMode) {
                                AspectRatioFrameLayout.RESIZE_MODE_FIT -> AspectRatioFrameLayout.RESIZE_MODE_FILL
                                AspectRatioFrameLayout.RESIZE_MODE_FILL -> AspectRatioFrameLayout.RESIZE_MODE_ZOOM
                                else -> AspectRatioFrameLayout.RESIZE_MODE_FIT
                            }
                        }
                        if (nextEpisode != null) {
                            TvOsdButton("⏭ Next: S${nextEpisode.seasonNumber}E${nextEpisode.episodeNumber}") {
                                onPlayNextEpisode(nextEpisode)
                            }
                        }
                    }
                }
            }
        }

        // SUBTITLES MODAL (Embedded Tracks + Online Subtitle Downloader + Timing Sync Offset)
        if (activeModal == "SUBTITLES") {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color(0xCC000000)),
                contentAlignment = Alignment.Center
            ) {
                Column(
                    modifier = Modifier
                        .width(680.dp)
                        .heightIn(max = 520.dp)
                        .background(Color(0xFF161821), RoundedCornerShape(16.dp))
                        .border(1.dp, Color(0xFF2E3446), RoundedCornerShape(16.dp))
                        .padding(24.dp)
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            "💬 Subtitles (Embedded & Online Auto-Downloader)",
                            color = Color.White,
                            fontSize = 20.sp,
                            fontWeight = FontWeight.Bold
                        )
                        TvOsdButton("Done") { activeModal = null }
                    }

                    Spacer(modifier = Modifier.height(12.dp))

                    // Timing Offset & Font Size Bar
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            "Sync Delay: ${subtitleOffsetMs / 1000.0}s",
                            color = Color(0xFF34D399),
                            fontSize = 14.sp,
                            fontWeight = FontWeight.SemiBold
                        )
                        TvOsdButton("-0.5s") {
                            subtitleOffsetMs -= 500L
                            selectedOnlineSub?.let { applyOnlineSubtitleToPlayer(it, subtitleOffsetMs) }
                        }
                        TvOsdButton("+0.5s") {
                            subtitleOffsetMs += 500L
                            selectedOnlineSub?.let { applyOnlineSubtitleToPlayer(it, subtitleOffsetMs) }
                        }
                        TvOsdButton("Reset 0s") {
                            subtitleOffsetMs = 0L
                            selectedOnlineSub?.let { applyOnlineSubtitleToPlayer(it, 0L) }
                        }
                        TvOsdButton("Font: ${(subtitleFontScale * 100).toInt()}%") {
                            subtitleFontScale = when (subtitleFontScale) {
                                1.0f -> 1.25f
                                1.25f -> 1.5f
                                else -> 1.0f
                            }
                        }
                    }

                    Spacer(modifier = Modifier.height(14.dp))

                    LazyColumn(
                        modifier = Modifier.weight(1f),
                        verticalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        item {
                            TvOsdButton("🚫 Turn Off Subtitles") {
                                exoPlayer.trackSelectionParameters = exoPlayer.trackSelectionParameters
                                    .buildUpon()
                                    .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
                                    .build()
                                activeModal = null
                            }
                        }

                        // Embedded Subtitles inside the IPTV stream
                        if (embeddedSubTracks.isNotEmpty()) {
                            item {
                                Text(
                                    "Embedded in Video Stream:",
                                    color = Color(0xFF9CA3AF),
                                    fontSize = 13.sp,
                                    modifier = Modifier.padding(top = 6.dp)
                                )
                            }
                            items(embeddedSubTracks) { (label, override) ->
                                TvOsdButton(label) {
                                    exoPlayer.trackSelectionParameters = exoPlayer.trackSelectionParameters
                                        .buildUpon()
                                        .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                                        .setOverrideForType(override)
                                        .build()
                                    activeModal = null
                                }
                            }
                        }

                        // Online Subtitles (Wyzie / OpenSubtitles)
                        item {
                            Text(
                                if (isSearchingOnlineSubs) "🌐 Searching Online Subtitles..."
                                else "🌐 Online Multi-Language Subtitles (${onlineSubtitles.size} found):",
                                color = Color(0xFF60A5FA),
                                fontSize = 13.sp,
                                modifier = Modifier.padding(top = 10.dp)
                            )
                        }

                        items(onlineSubtitles) { subTrack ->
                            TvOsdButton(subTrack.label) {
                                activeModal = null
                                applyOnlineSubtitleToPlayer(subTrack, subtitleOffsetMs)
                            }
                        }
                    }
                }
            }
        }

        // AUDIO TRACKS MODAL
        if (activeModal == "AUDIO") {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color(0xCC000000)),
                contentAlignment = Alignment.Center
            ) {
                Column(
                    modifier = Modifier
                        .width(520.dp)
                        .background(Color(0xFF161821), RoundedCornerShape(16.dp))
                        .border(1.dp, Color(0xFF2E3446), RoundedCornerShape(16.dp))
                        .padding(24.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text("🔊 Select Audio Track", color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                        TvOsdButton("Close") { activeModal = null }
                    }
                    if (embeddedAudioTracks.isEmpty()) {
                        Text("Default Stereo Track Active", color = Color(0xFF9CA3AF), fontSize = 14.sp)
                    } else {
                        embeddedAudioTracks.forEach { (label, override) ->
                            TvOsdButton(label) {
                                exoPlayer.trackSelectionParameters = exoPlayer.trackSelectionParameters
                                    .buildUpon()
                                    .setOverrideForType(override)
                                    .build()
                                activeModal = null
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun TvOsdButton(
    text: String,
    isPrimary: Boolean = false,
    onClick: () -> Unit
) {
    var isFocused by remember { mutableStateOf(false) }
    val bg = when {
        isFocused -> Color(0xFFE50914)
        isPrimary -> Color(0xFFB91C1C)
        else -> Color(0xFF252836)
    }
    val borderCol = if (isFocused) Color.White else Color(0xFF3F445A)

    Box(
        modifier = Modifier
            .onFocusChanged { isFocused = it.isFocused }
            .focusable()
            .clickable { onClick() }
            .background(bg, RoundedCornerShape(8.dp))
            .border(if (isFocused) 2.dp else 1.dp, borderCol, RoundedCornerShape(8.dp))
            .padding(horizontal = 16.dp, vertical = 10.dp)
    ) {
        Text(
            text = text,
            color = Color.White,
            fontSize = 14.sp,
            fontWeight = if (isFocused || isPrimary) FontWeight.Bold else FontWeight.Medium
        )
    }
}

private fun formatDurationMs(ms: Long): String {
    val totalSecs = (ms / 1000L).coerceAtLeast(0L)
    val hrs = totalSecs / 3600
    val mins = (totalSecs % 3600) / 60
    val secs = totalSecs % 60
    return if (hrs > 0) {
        String.format(Locale.US, "%d:%02d:%02d", hrs, mins, secs)
    } else {
        String.format(Locale.US, "%02d:%02d", mins, secs)
    }
}
