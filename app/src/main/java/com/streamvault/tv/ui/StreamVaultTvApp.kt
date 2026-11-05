package com.streamvault.tv.ui

import android.graphics.Bitmap
import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.streamvault.tv.data.*
import com.streamvault.tv.server.PhoneCompanionServer

enum class NavTab(val icon: String, val label: String) {
    HOME("🏠", "Home"),
    SEARCH("🔍", "Super-Filter"),
    MOVIES("🎬", "Movies"),
    SERIES("📺", "Series"),
    LIVE_TV("📡", "Live TV"),
    WATCHLIST("⭐", "My List"),
    SETTINGS("📱", "QR & Sync")
}

data class ActivePlaybackRequest(
    val title: String,
    val subtitleInfo: String,
    val streamUrl: String,
    val mediaItem: MediaItem? = null,
    val episode: SeriesEpisode? = null,
    val nextEpisode: SeriesEpisode? = null
)

@Composable
fun StreamVaultTvApp(
    db: StreamVaultDatabase,
    prefs: PreferencesManager,
    syncEngine: CatalogSyncEngine,
    subtitleService: SubtitleService,
    companionServer: PhoneCompanionServer,
    onLaunchVoiceSearch: ((String) -> Unit) -> Unit
) {
    val syncState by syncEngine.syncState.collectAsState()
    val creds by prefs.credentialsFlow.collectAsState()
    val remoteSearchCmd by prefs.remoteSearchCommand.collectAsState()

    var currentTab by remember { mutableStateOf(NavTab.HOME) }
    var selectedMediaDetail by remember { mutableStateOf<MediaItem?>(null) }
    var activePlayback by remember { mutableStateOf<ActivePlaybackRequest?>(null) }
    var catalogRefreshTick by remember { mutableStateOf(0) }
    var filterState by remember { mutableStateOf(SuperFilterState()) }

    LaunchedEffect(remoteSearchCmd) {
        val cmd = remoteSearchCmd
        if (!cmd.isNullOrBlank()) {
            filterState = filterState.copy(searchQuery = cmd)
            selectedMediaDetail = null
            currentTab = NavTab.SEARCH
            prefs.consumeRemoteSearchCommand()
        }
    }

    LaunchedEffect(Unit) {
        if (!creds.isConfigured) {
            syncEngine.seedSampleShowcaseCatalogIfEmpty()
            catalogRefreshTick++
        } else if (prefs.shouldRunAutoDeltaSync()) {
            syncEngine.triggerSync(isManual = false) { catalogRefreshTick++ }
        } else {
            syncEngine.startBackgroundTmdbEnrichment { catalogRefreshTick++ }
        }
    }

    fun buildVodStreamUrl(item: MediaItem, version: StreamVersion): String {
        if (!creds.isConfigured) {
            return "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4"
        }
        val ext = version.containerExtension.ifBlank { "mp4" }
        return "${creds.normalizedServerUrl}/movie/${creds.username}/${creds.password}/${version.streamId}.$ext"
    }

    fun buildEpisodeStreamUrl(ep: SeriesEpisode): String {
        if (!creds.isConfigured) {
            return "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4"
        }
        val ext = ep.containerExtension.ifBlank { "mp4" }
        return "${creds.normalizedServerUrl}/series/${creds.username}/${creds.password}/${ep.episodeId}.$ext"
    }

    fun buildLiveStreamUrl(channel: LiveChannel): String {
        if (!creds.isConfigured) {
            return "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"
        }
        return "${creds.normalizedServerUrl}/live/${creds.username}/${creds.password}/${channel.streamId}.m3u8"
    }

    val playback = activePlayback
    if (playback != null) {
        StreamVaultPlayerScreen(
            title = playback.title,
            subtitleInfo = playback.subtitleInfo,
            streamUrl = playback.streamUrl,
            mediaItem = playback.mediaItem,
            episode = playback.episode,
            nextEpisode = playback.nextEpisode,
            db = db,
            prefs = prefs,
            subtitleService = subtitleService,
            onPlayNextEpisode = { nextEp ->
                val item = playback.mediaItem
                activePlayback = ActivePlaybackRequest(
                    title = "${item?.cleanTitle ?: ""} — S${nextEp.seasonNumber}E${nextEp.episodeNumber}: ${nextEp.title}",
                    subtitleInfo = nextEp.plot,
                    streamUrl = buildEpisodeStreamUrl(nextEp),
                    mediaItem = item,
                    episode = nextEp,
                    nextEpisode = null
                )
            },
            onClosePlayer = {
                activePlayback = null
                catalogRefreshTick++
            }
        )
        return
    }

    val detailItem = selectedMediaDetail
    if (detailItem != null) {
        BackHandler { selectedMediaDetail = null }
        MediaDetailScreen(
            item = detailItem,
            db = db,
            syncEngine = syncEngine,
            onBack = { selectedMediaDetail = null },
            onPlayVersion = { version ->
                activePlayback = ActivePlaybackRequest(
                    title = "${detailItem.cleanTitle} (${detailItem.year})",
                    subtitleInfo = "${version.languageTag} • ${version.qualityTag} • ${detailItem.subtitleSummary}",
                    streamUrl = buildVodStreamUrl(detailItem, version),
                    mediaItem = detailItem
                )
            },
            onPlayEpisode = { ep, nextEp ->
                activePlayback = ActivePlaybackRequest(
                    title = "${detailItem.cleanTitle} — S${ep.seasonNumber}E${ep.episodeNumber}: ${ep.title}",
                    subtitleInfo = ep.plot,
                    streamUrl = buildEpisodeStreamUrl(ep),
                    mediaItem = detailItem,
                    episode = ep,
                    nextEpisode = nextEp
                )
            },
            onSelectRelatedMedia = { related -> selectedMediaDetail = related },
            onJumpToFilter = { newFilter ->
                filterState = newFilter
                selectedMediaDetail = null
                currentTab = NavTab.SEARCH
            }
        )
        return
    }

    Row(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF0B0C10))
    ) {
        Column(
            modifier = Modifier
                .width(195.dp)
                .fillMaxHeight()
                .background(Color(0xFF12141C))
                .padding(vertical = 20.dp, horizontal = 12.dp),
            verticalArrangement = Arrangement.SpaceBetween
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 10.dp)
                ) {
                    Box(
                        modifier = Modifier
                            .size(12.dp)
                            .background(Color(0xFFE50914), CircleShape)
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        "STREAMVAULT",
                        color = Color.White,
                        fontSize = 16.sp,
                        fontWeight = FontWeight.ExtraBold
                    )
                }

                NavTab.values().forEach { tab ->
                    val selected = currentTab == tab
                    var focused by remember { mutableStateOf(false) }
                    val bg = when {
                        focused -> Color(0xFFE50914)
                        selected -> Color(0xFF252836)
                        else -> Color.Transparent
                    }
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .onFocusChanged { focused = it.isFocused }
                            .focusable()
                            .clickable { currentTab = tab }
                            .background(bg, RoundedCornerShape(10.dp))
                            .border(
                                width = if (focused) 2.dp else 0.dp,
                                color = if (focused) Color.White else Color.Transparent,
                                shape = RoundedCornerShape(10.dp)
                            )
                            .padding(horizontal = 12.dp, vertical = 11.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(tab.icon, fontSize = 16.sp)
                        Spacer(modifier = Modifier.width(10.dp))
                        Text(
                            tab.label,
                            color = if (selected || focused) Color.White else Color(0xFF9CA3AF),
                            fontSize = 14.sp,
                            fontWeight = if (selected || focused) FontWeight.Bold else FontWeight.Medium
                        )
                    }
                }
            }

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(Color(0xFF1A1D29), RoundedCornerShape(10.dp))
                    .padding(10.dp)
            ) {
                Text(
                    if (creds.isConfigured) creds.playlistName else "Showcase Mode",
                    color = Color.White,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                Text(
                    syncState.phase,
                    color = Color(0xFF9CA3AF),
                    fontSize = 10.sp,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
                if (syncState.newlyAddedCount > 0) {
                    Text(
                        "+${syncState.newlyAddedCount} New Added!",
                        color = Color(0xFF34D399),
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Bold
                    )
                }
            }
        }

        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxHeight()
        ) {
            when (currentTab) {
                NavTab.HOME -> HomeScreen(
                    db = db,
                    creds = creds,
                    refreshTick = catalogRefreshTick,
                    onSelectMedia = { selectedMediaDetail = it },
                    onPlayImmediate = { item ->
                        val ver = item.versions.firstOrNull() ?: StreamVersion(
                            item.primaryStreamId, item.rawTitle, item.language, "HD", "", "mp4", "", "", 0L
                        )
                        activePlayback = ActivePlaybackRequest(
                            title = "${item.cleanTitle} (${item.year})",
                            subtitleInfo = "${ver.languageTag} • ${ver.qualityTag}",
                            streamUrl = buildVodStreamUrl(item, ver),
                            mediaItem = item
                        )
                    },
                    onOpenSmartRowInFilter = { smartFilter ->
                        filterState = smartFilter
                        currentTab = NavTab.SEARCH
                    }
                )

                NavTab.SEARCH -> SuperFilterScreen(
                    db = db,
                    prefs = prefs,
                    creds = creds,
                    filterState = filterState,
                    onUpdateFilter = { filterState = it },
                    onSelectMedia = { selectedMediaDetail = it },
                    onLaunchVoiceSearch = {
                        onLaunchVoiceSearch { spokenText ->
                            filterState = filterState.copy(searchQuery = spokenText)
                            prefs.addRecentSearch(spokenText)
                        }
                    },
                    portalUrl = companionServer.getLocalPortalUrl()
                )

                NavTab.MOVIES -> CatalogGridByTypeScreen(
                    title = "🎬 All Movies (Multi-Genre Enriched)",
                    mediaType = MediaType.MOVIE,
                    db = db,
                    creds = creds,
                    refreshTick = catalogRefreshTick,
                    onSelectMedia = { selectedMediaDetail = it },
                    onOpenSuperFilter = {
                        filterState = filterState.copy(mediaTypeFilter = MediaType.MOVIE)
                        currentTab = NavTab.SEARCH
                    }
                )

                NavTab.SERIES -> CatalogGridByTypeScreen(
                    title = "📺 TV Series (Multi-Genre Enriched)",
                    mediaType = MediaType.SERIES,
                    db = db,
                    creds = creds,
                    refreshTick = catalogRefreshTick,
                    onSelectMedia = { selectedMediaDetail = it },
                    onOpenSuperFilter = {
                        filterState = filterState.copy(mediaTypeFilter = MediaType.SERIES)
                        currentTab = NavTab.SEARCH
                    }
                )

                NavTab.LIVE_TV -> LiveTvBrowserScreen(
                    db = db,
                    refreshTick = catalogRefreshTick,
                    onPlayLiveChannel = { channel ->
                        activePlayback = ActivePlaybackRequest(
                            title = "📡 LIVE: ${channel.name}",
                            subtitleInfo = "${channel.categoryName} • ${channel.currentProgramTitle}",
                            streamUrl = buildLiveStreamUrl(channel)
                        )
                    }
                )

                NavTab.WATCHLIST -> WatchlistScreen(
                    db = db,
                    refreshTick = catalogRefreshTick,
                    onSelectMedia = { selectedMediaDetail = it }
                )

                NavTab.SETTINGS -> QrSetupAndSyncScreen(
                    prefs = prefs,
                    syncState = syncState,
                    portalUrl = companionServer.getLocalPortalUrl(),
                    onTriggerManualSync = {
                        syncEngine.triggerSync(isManual = true) { catalogRefreshTick++ }
                    }
                )
            }
        }
    }
}

@Composable
private fun HomeScreen(
    db: StreamVaultDatabase,
    creds: XtreamCredentials,
    refreshTick: Int,
    onSelectMedia: (MediaItem) -> Unit,
    onPlayImmediate: (MediaItem) -> Unit,
    onOpenSmartRowInFilter: (SuperFilterState) -> Unit
) {
    val continueWatching = remember(refreshTick) { db.getContinueWatchingList() }
    val watchlist = remember(refreshTick) { db.getWatchlist() }
    val pinnedSmartRows = remember(refreshTick) { db.getPinnedSmartRows() }
    val topRated = remember(refreshTick, creds.hiddenLanguages) {
        db.queryMedia(
            SuperFilterState(minRating = 7.5, sortBy = SortOption.RATING_DESC),
            hiddenLanguages = creds.hiddenLanguages,
            limit = 25
        )
    }
    val recentlyAdded = remember(refreshTick, creds.hiddenLanguages) {
        db.queryMedia(
            SuperFilterState(sortBy = SortOption.NEWLY_ADDED),
            hiddenLanguages = creds.hiddenLanguages,
            limit = 25
        )
    }
    val heroItem = topRated.firstOrNull() ?: recentlyAdded.firstOrNull()

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = 48.dp)
    ) {
        if (heroItem != null) {
            item {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(310.dp)
                ) {
                    AsyncImage(
                        model = heroItem.backdropUrl.ifBlank { heroItem.posterUrl },
                        contentDescription = heroItem.cleanTitle,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.fillMaxSize()
                    )
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .background(
                                Brush.horizontalGradient(
                                    listOf(Color(0xF50B0C10), Color(0xCC0B0C10), Color(0x330B0C10))
                                )
                            )
                    )
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .background(
                                Brush.verticalGradient(
                                    listOf(Color.Transparent, Color(0xFF0B0C10))
                                )
                            )
                    )

                    Column(
                        modifier = Modifier
                            .align(Alignment.BottomStart)
                            .padding(horizontal = 28.dp, vertical = 20.dp)
                            .widthIn(max = 620.dp)
                    ) {
                        Row(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            BadgePill("★ ${String.format("%.1f", heroItem.rating)}", Color(0xFFF59E0B))
                            if (heroItem.year > 0) BadgePill(heroItem.year.toString(), Color(0xFF374151))
                            BadgePill(heroItem.language, Color(0xFF2563EB))
                            heroItem.qualityBadges.take(2).forEach { q ->
                                BadgePill(q, Color(0xFF059669))
                            }
                            if (heroItem.versions.size > 1) {
                                BadgePill("${heroItem.versions.size} Versions", Color(0xFF7C3AED))
                            }
                        }
                        Spacer(modifier = Modifier.height(8.dp))
                        Text(
                            heroItem.cleanTitle,
                            color = Color.White,
                            fontSize = 30.sp,
                            fontWeight = FontWeight.ExtraBold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                        if (heroItem.genres.isNotEmpty()) {
                            Text(
                                heroItem.genres.joinToString(" • "),
                                color = Color(0xFFE50914),
                                fontSize = 13.sp,
                                fontWeight = FontWeight.Bold
                            )
                        }
                        Spacer(modifier = Modifier.height(6.dp))
                        Text(
                            heroItem.plot,
                            color = Color(0xFFD1D5DB),
                            fontSize = 13.sp,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis
                        )
                        Spacer(modifier = Modifier.height(14.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            TvOsdButton("▶ Play Now", isPrimary = true) { onPlayImmediate(heroItem) }
                            TvOsdButton("ℹ More Info & Versions") { onSelectMedia(heroItem) }
                        }
                    }
                }
            }
        }

        if (continueWatching.isNotEmpty()) {
            item {
                MediaHorizontalRow(
                    title = "⏯ Continue Watching",
                    items = continueWatching,
                    onSelectMedia = onSelectMedia
                )
            }
        }

        if (watchlist.isNotEmpty()) {
            item {
                MediaHorizontalRow(
                    title = "⭐ My List (Watchlist)",
                    items = watchlist,
                    onSelectMedia = onSelectMedia
                )
            }
        }

        items(pinnedSmartRows) { smartRow ->
            val rowItems = remember(smartRow, refreshTick, creds.hiddenLanguages) {
                db.queryMedia(smartRow.filterState, creds.hiddenLanguages, limit = 25)
            }
            if (rowItems.isNotEmpty()) {
                MediaHorizontalRow(
                    title = "📌 ${smartRow.title}",
                    subtitle = smartRow.filterState.toSummaryString(),
                    items = rowItems,
                    onSelectMedia = onSelectMedia,
                    onHeaderAction = { onOpenSmartRowInFilter(smartRow.filterState) }
                )
            }
        }

        if (recentlyAdded.isNotEmpty()) {
            item {
                MediaHorizontalRow(
                    title = "🔥 Recently Added to Your IPTV Server",
                    items = recentlyAdded,
                    onSelectMedia = onSelectMedia
                )
            }
        }

        if (topRated.isNotEmpty()) {
            item {
                MediaHorizontalRow(
                    title = "🏆 Critically Acclaimed (IMDb / TMDB 7.5+)",
                    items = topRated,
                    onSelectMedia = onSelectMedia
                )
            }
        }

        val coreGenres = listOf("Action", "Sci-Fi", "Thriller", "Comedy", "Crime", "Drama", "Adventure", "Horror")
        items(coreGenres) { genre ->
            val genreItems = remember(genre, refreshTick, creds.hiddenLanguages) {
                db.queryMedia(
                    SuperFilterState(includedGenres = setOf(genre), sortBy = SortOption.RATING_DESC),
                    creds.hiddenLanguages,
                    limit = 22
                )
            }
            if (genreItems.isNotEmpty()) {
                MediaHorizontalRow(
                    title = "$genre Movies & Series",
                    items = genreItems,
                    onSelectMedia = onSelectMedia
                )
            }
        }
    }
}

@Composable
private fun MediaHorizontalRow(
    title: String,
    subtitle: String? = null,
    items: List<MediaItem>,
    onSelectMedia: (MediaItem) -> Unit,
    onHeaderAction: (() -> Unit)? = null
) {
    Column(modifier = Modifier.fillMaxWidth().padding(top = 18.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column {
                Text(title, color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                if (!subtitle.isNullOrBlank()) {
                    Text(subtitle, color = Color(0xFF9CA3AF), fontSize = 11.sp)
                }
            }
            if (onHeaderAction != null) {
                TvOsdButton("Open in Super-Filter →") { onHeaderAction() }
            }
        }
        Spacer(modifier = Modifier.height(10.dp))
        LazyRow(
            contentPadding = PaddingValues(horizontal = 24.dp),
            horizontalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            items(items, key = { it.dedupKey }) { item ->
                NetflixPosterCard(item = item, onClick = { onSelectMedia(item) })
            }
        }
    }
}

@Composable
fun NetflixPosterCard(
    item: MediaItem,
    width: Dp = 148.dp,
    height: Dp = 220.dp,
    onClick: () -> Unit
) {
    var isFocused by remember { mutableStateOf(false) }
    val scale by animateFloatAsState(targetValue = if (isFocused) 1.07f else 1.0f, label = "card_scale")

    Column(
        modifier = Modifier
            .width(width)
            .scale(scale)
            .onFocusChanged { isFocused = it.isFocused }
            .focusable()
            .clickable { onClick() }
    ) {
        Box(
            modifier = Modifier
                .width(width)
                .height(height)
                .clip(RoundedCornerShape(10.dp))
                .background(Color(0xFF1A1D29))
                .border(
                    width = if (isFocused) 3.dp else 1.dp,
                    color = if (isFocused) Color(0xFFE50914) else Color(0xFF262A3B),
                    shape = RoundedCornerShape(10.dp)
                )
        ) {
            if (item.posterUrl.isNotBlank()) {
                AsyncImage(
                    model = item.posterUrl,
                    contentDescription = item.cleanTitle,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize()
                )
            } else {
                Box(modifier = Modifier.fillMaxSize().padding(12.dp), contentAlignment = Alignment.Center) {
                    Text(
                        item.cleanTitle,
                        color = Color.White,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Bold
                    )
                }
            }

            if (item.rating > 0) {
                Box(
                    modifier = Modifier
                        .align(Alignment.TopStart)
                        .padding(6.dp)
                        .background(Color(0xD9000000), RoundedCornerShape(6.dp))
                        .padding(horizontal = 6.dp, vertical = 2.dp)
                ) {
                    Text(
                        "★ ${String.format("%.1f", item.rating)}",
                        color = Color(0xFFFBBF24),
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold
                    )
                }
            }

            Row(
                modifier = Modifier.align(Alignment.TopEnd).padding(6.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                item.qualityBadges.firstOrNull()?.let { q ->
                    Box(
                        modifier = Modifier
                            .background(Color(0xD9059669), RoundedCornerShape(5.dp))
                            .padding(horizontal = 5.dp, vertical = 2.dp)
                    ) {
                        Text(q, color = Color.White, fontSize = 9.sp, fontWeight = FontWeight.Bold)
                    }
                }
                if (item.versions.size > 1) {
                    Box(
                        modifier = Modifier
                            .background(Color(0xD97C3AED), RoundedCornerShape(5.dp))
                            .padding(horizontal = 5.dp, vertical = 2.dp)
                    ) {
                        Text("${item.versions.size}x", color = Color.White, fontSize = 9.sp, fontWeight = FontWeight.Bold)
                    }
                }
            }

            Row(
                modifier = Modifier
                    .align(Alignment.BottomStart)
                    .fillMaxWidth()
                    .background(Color(0xCC0B0C10))
                    .padding(horizontal = 6.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    item.language,
                    color = Color(0xFF93C5FD),
                    fontSize = 9.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1
                )
                Text(
                    if (item.hasEmbeddedSubtitles) "CC✓" else "CC🌐",
                    color = Color(0xFF34D399),
                    fontSize = 9.sp,
                    fontWeight = FontWeight.Bold
                )
            }

            if (item.progressFraction > 0f) {
                LinearProgressIndicator(
                    progress = item.progressFraction,
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .fillMaxWidth()
                        .height(4.dp),
                    color = Color(0xFFE50914),
                    trackColor = Color(0x55FFFFFF)
                )
            }
        }

        Spacer(modifier = Modifier.height(6.dp))
        Text(
            item.cleanTitle,
            color = if (isFocused) Color.White else Color(0xFFE5E7EB),
            fontSize = 13.sp,
            fontWeight = if (isFocused) FontWeight.Bold else FontWeight.Medium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
        Text(
            buildString {
                if (item.year > 0) append("${item.year} • ")
                append(item.genres.take(2).joinToString(", ").ifBlank { item.categoryName })
            },
            color = Color(0xFF9CA3AF),
            fontSize = 10.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

@Composable
private fun SuperFilterScreen(
    db: StreamVaultDatabase,
    prefs: PreferencesManager,
    creds: XtreamCredentials,
    filterState: SuperFilterState,
    onUpdateFilter: (SuperFilterState) -> Unit,
    onSelectMedia: (MediaItem) -> Unit,
    onLaunchVoiceSearch: () -> Unit,
    portalUrl: String
) {
    val allGenres = remember { db.getAllDistinctGenres() }
    val allLanguages = remember { db.getAllDistinctLanguages() }
    val results = remember(filterState, creds.hiddenLanguages) {
        db.queryMedia(filterState, creds.hiddenLanguages, limit = 180)
    }
    val autocompleteChips = remember(filterState.searchQuery) {
        db.getAutocompleteSuggestions(filterState.searchQuery, limit = 8)
    }
    val recentSearches = remember(filterState.searchQuery) { prefs.getRecentSearches() }
    var showMiniKeyboard by remember { mutableStateOf(false) }
    var pinRowBanner by remember { mutableStateOf<String?>(null) }

    Row(modifier = Modifier.fillMaxSize().padding(18.dp), horizontalArrangement = Arrangement.spacedBy(18.dp)) {
        LazyColumn(
            modifier = Modifier
                .width(410.dp)
                .fillMaxHeight()
                .background(Color(0xFF141722), RoundedCornerShape(14.dp))
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            item {
                Text(
                    "🔍 Super-Filter & 4-Way Search",
                    color = Color.White,
                    fontSize = 18.sp,
                    fontWeight = FontWeight.ExtraBold
                )
                Text(
                    "Phone Keyboard URL: $portalUrl",
                    color = Color(0xFF60A5FA),
                    fontSize = 11.sp
                )
            }

            item {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    TvOsdButton(
                        if (filterState.searchQuery.isBlank()) "⌨️ Type Search..."
                        else "🔎 \"${filterState.searchQuery}\""
                    ) {
                        showMiniKeyboard = !showMiniKeyboard
                    }
                    TvOsdButton("🎤 Voice") { onLaunchVoiceSearch() }
                    if (filterState.searchQuery.isNotBlank()) {
                        TvOsdButton("✕") { onUpdateFilter(filterState.copy(searchQuery = "")) }
                    }
                }
            }

            if (showMiniKeyboard) {
                item {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(Color(0xFF1D2130), RoundedCornerShape(10.dp))
                            .padding(10.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp)
                    ) {
                        val keys = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".chunked(6)
                        keys.forEach { rowStr ->
                            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                rowStr.forEach { ch ->
                                    TvOsdButton(ch.toString()) {
                                        onUpdateFilter(filterState.copy(searchQuery = filterState.searchQuery + ch.lowercaseChar()))
                                    }
                                }
                            }
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            TvOsdButton("Space") {
                                onUpdateFilter(filterState.copy(searchQuery = filterState.searchQuery + " "))
                            }
                            TvOsdButton("⌫ Back") {
                                if (filterState.searchQuery.isNotEmpty()) {
                                    onUpdateFilter(filterState.copy(searchQuery = filterState.searchQuery.dropLast(1)))
                                }
                            }
                            TvOsdButton("Clear") {
                                onUpdateFilter(filterState.copy(searchQuery = ""))
                            }
                            TvOsdButton("Done ✓", isPrimary = true) {
                                prefs.addRecentSearch(filterState.searchQuery)
                                showMiniKeyboard = false
                            }
                        }
                    }
                }
            }

            if (autocompleteChips.isNotEmpty()) {
                item {
                    Text("⚡ Instant Matches (1-Click):", color = Color(0xFF34D399), fontSize = 12.sp, fontWeight = FontWeight.Bold)
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 4.dp)) {
                        items(autocompleteChips) { suggestion ->
                            TvOsdButton(suggestion) {
                                onUpdateFilter(filterState.copy(searchQuery = suggestion))
                                showMiniKeyboard = false
                            }
                        }
                    }
                }
            } else if (recentSearches.isNotEmpty() && filterState.searchQuery.isBlank()) {
                item {
                    Text("Recent Searches:", color = Color(0xFF9CA3AF), fontSize = 11.sp)
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(top = 4.dp)) {
                        items(recentSearches) { rec ->
                            TvOsdButton(rec) { onUpdateFilter(filterState.copy(searchQuery = rec)) }
                        }
                    }
                }
            }

            item {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TvOsdButton("📌 Pin Filter to Home", isPrimary = true) {
                        val title = filterState.toSummaryString().take(42)
                        db.savePinnedSmartRow(title, filterState)
                        pinRowBanner = "✓ Pinned \"$title\" to your Home Screen!"
                    }
                    if (filterState.activeFilterCount > 0) {
                        TvOsdButton("Reset All (${filterState.activeFilterCount})") {
                            onUpdateFilter(SuperFilterState())
                            pinRowBanner = null
                        }
                    }
                }
                if (pinRowBanner != null) {
                    Text(pinRowBanner ?: "", color = Color(0xFF34D399), fontSize = 12.sp, modifier = Modifier.padding(top = 4.dp))
                }
            }

            if (filterState.actorFilter != null || filterState.directorFilter != null) {
                item {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        filterState.actorFilter?.let { actor ->
                            TvOsdButton("🎭 Actor: $actor ✕") { onUpdateFilter(filterState.copy(actorFilter = null)) }
                        }
                        filterState.directorFilter?.let { dir ->
                            TvOsdButton("🎬 Director: $dir ✕") { onUpdateFilter(filterState.copy(directorFilter = null)) }
                        }
                    }
                }
            }

            item {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        "Genres (1st click = +Include, 2nd = -Exclude):",
                        color = Color.White,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Bold
                    )
                    TvOsdButton(if (filterState.matchAllIncludedGenres) "Mode: AND" else "Mode: OR") {
                        onUpdateFilter(filterState.copy(matchAllIncludedGenres = !filterState.matchAllIncludedGenres))
                    }
                }
                Spacer(modifier = Modifier.height(6.dp))
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    allGenres.chunked(3).forEach { rowGenres ->
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            rowGenres.forEach { g ->
                                val isInc = filterState.includedGenres.contains(g)
                                val isExc = filterState.excludedGenres.contains(g)
                                val label = when {
                                    isInc -> "+ $g"
                                    isExc -> "✕ NOT $g"
                                    else -> g
                                }
                                FilterChipPill(
                                    text = label,
                                    stateColor = when {
                                        isInc -> Color(0xFF059669)
                                        isExc -> Color(0xFFDC2626)
                                        else -> Color(0xFF252836)
                                    }
                                ) {
                                    when {
                                        !isInc && !isExc -> onUpdateFilter(
                                            filterState.copy(includedGenres = filterState.includedGenres + g)
                                        )
                                        isInc -> onUpdateFilter(
                                            filterState.copy(
                                                includedGenres = filterState.includedGenres - g,
                                                excludedGenres = filterState.excludedGenres + g
                                            )
                                        )
                                        else -> onUpdateFilter(
                                            filterState.copy(excludedGenres = filterState.excludedGenres - g)
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }

            item {
                Text("💬 Subtitles Filter:", color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                Spacer(modifier = Modifier.height(6.dp))
                LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    items(SubtitleFilterMode.values().toList()) { mode ->
                        val active = filterState.subtitleFilterMode == mode
                        FilterChipPill(
                            text = mode.label,
                            stateColor = if (active) Color(0xFF2563EB) else Color(0xFF252836)
                        ) {
                            onUpdateFilter(filterState.copy(subtitleFilterMode = mode))
                        }
                    }
                }
            }

            item {
                Text("🌐 Language Filter:", color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                Spacer(modifier = Modifier.height(6.dp))
                LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    items(allLanguages) { lang ->
                        val active = filterState.selectedLanguages.contains(lang)
                        FilterChipPill(
                            text = lang,
                            stateColor = if (active) Color(0xFF2563EB) else Color(0xFF252836)
                        ) {
                            val next = if (active) filterState.selectedLanguages - lang else filterState.selectedLanguages + lang
                            onUpdateFilter(filterState.copy(selectedLanguages = next))
                        }
                    }
                }
            }

            item {
                Text("★ Minimum Rating & Decade:", color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                Spacer(modifier = Modifier.height(6.dp))
                LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    items(listOf(0.0 to "Any ★", 6.0 to "6.0+", 7.0 to "7.0+", 7.5 to "7.5+", 8.0 to "8.0+")) { (r, lbl) ->
                        FilterChipPill(
                            text = lbl,
                            stateColor = if (filterState.minRating == r) Color(0xFFD97706) else Color(0xFF252836)
                        ) {
                            onUpdateFilter(filterState.copy(minRating = r))
                        }
                    }
                }
                Spacer(modifier = Modifier.height(6.dp))
                LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    items(listOf(null to "All Years", 2020 to "2020s", 2010 to "2010s", 2000 to "2000s", 1990 to "1990s")) { (dec, lbl) ->
                        FilterChipPill(
                            text = lbl,
                            stateColor = if (filterState.decade == dec) Color(0xFF7C3AED) else Color(0xFF252836)
                        ) {
                            onUpdateFilter(filterState.copy(decade = dec))
                        }
                    }
                }
            }

            item {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf(null to "All Qualities", "4K" to "4K UHD", "1080p" to "1080p", "HEVC" to "HEVC").forEach { (q, lbl) ->
                        FilterChipPill(
                            text = lbl,
                            stateColor = if (filterState.qualityFilter == q) Color(0xFF059669) else Color(0xFF252836)
                        ) {
                            onUpdateFilter(filterState.copy(qualityFilter = q))
                        }
                    }
                }
                Spacer(modifier = Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChipPill(
                        text = if (filterState.hideWatched) "✓ Hiding Watched" else "Hide Already Watched",
                        stateColor = if (filterState.hideWatched) Color(0xFF059669) else Color(0xFF252836)
                    ) {
                        onUpdateFilter(filterState.copy(hideWatched = !filterState.hideWatched))
                    }
                    FilterChipPill(
                        text = "🎲 Surprise Me!",
                        stateColor = if (filterState.sortBy == SortOption.RANDOM) Color(0xFFE50914) else Color(0xFF252836)
                    ) {
                        onUpdateFilter(filterState.copy(sortBy = SortOption.RANDOM))
                    }
                }
            }
        }

        Column(modifier = Modifier.weight(1f).fillMaxHeight()) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(bottom = 12.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column {
                    Text(
                        "${results.size} Matching Titles",
                        color = Color.White,
                        fontSize = 20.sp,
                        fontWeight = FontWeight.Bold
                    )
                    Text(
                        filterState.toSummaryString(),
                        color = Color(0xFF9CA3AF),
                        fontSize = 12.sp
                    )
                }
                LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    items(SortOption.values().toList()) { sortOpt ->
                        FilterChipPill(
                            text = sortOpt.label,
                            stateColor = if (filterState.sortBy == sortOpt) Color(0xFFE50914) else Color(0xFF252836)
                        ) {
                            onUpdateFilter(filterState.copy(sortBy = sortOpt))
                        }
                    }
                }
            }

            LazyVerticalGrid(
                columns = GridCells.Adaptive(minSize = 148.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
                horizontalArrangement = Arrangement.spacedBy(14.dp),
                modifier = Modifier.fillMaxSize()
            ) {
                items(results, key = { it.dedupKey }) { item ->
                    NetflixPosterCard(item = item, onClick = { onSelectMedia(item) })
                }
            }
        }
    }
}

@Composable
private fun MediaDetailScreen(
    item: MediaItem,
    db: StreamVaultDatabase,
    syncEngine: CatalogSyncEngine,
    onBack: () -> Unit,
    onPlayVersion: (StreamVersion) -> Unit,
    onPlayEpisode: (SeriesEpisode, SeriesEpisode?) -> Unit,
    onSelectRelatedMedia: (MediaItem) -> Unit,
    onJumpToFilter: (SuperFilterState) -> Unit
) {
    var inWatchlist by remember(item) { mutableStateOf(item.inWatchlist) }
    var isWatched by remember(item) { mutableStateOf(item.isWatched) }
    var episodes by remember(item) { mutableStateOf<List<SeriesEpisode>>(emptyList()) }
    var selectedSeason by remember(item) { mutableStateOf(1) }
    val moreLikeThis = remember(item) { db.getMoreLikeThis(item) }

    LaunchedEffect(item) {
        if (item.mediaType == MediaType.SERIES) {
            episodes = syncEngine.fetchSeriesEpisodesOnDemand(item)
            episodes.firstOrNull()?.seasonNumber?.let { selectedSeason = it }
        }
    }

    Box(modifier = Modifier.fillMaxSize().background(Color(0xFF0B0C10))) {
        if (item.backdropUrl.isNotBlank() || item.posterUrl.isNotBlank()) {
            AsyncImage(
                model = item.backdropUrl.ifBlank { item.posterUrl },
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize()
            )
        }
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(
                    Brush.horizontalGradient(
                        listOf(Color(0xF80B0C10), Color(0xE60B0C10), Color(0xBB0B0C10))
                    )
                )
        )

        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(32.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp)
        ) {
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                    AsyncImage(
                        model = item.posterUrl,
                        contentDescription = item.cleanTitle,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier
                            .width(190.dp)
                            .height(280.dp)
                            .clip(RoundedCornerShape(12.dp))
                            .border(1.dp, Color(0xFF374151), RoundedCornerShape(12.dp))
                    )

                    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            TvOsdButton("← Back") { onBack() }
                            BadgePill("★ ${String.format("%.1f", item.rating)}", Color(0xFFF59E0B))
                            if (item.year > 0) BadgePill(item.year.toString(), Color(0xFF374151))
                            if (item.runtimeMins > 0) BadgePill("${item.runtimeMins} mins", Color(0xFF374151))
                            BadgePill(item.availableLanguagesSummary, Color(0xFF2563EB))
                        }

                        Text(
                            item.cleanTitle,
                            color = Color.White,
                            fontSize = 32.sp,
                            fontWeight = FontWeight.ExtraBold
                        )

                        Text(
                            "💬 Subtitles: ${item.subtitleSummary}",
                            color = Color(0xFF34D399),
                            fontSize = 13.sp,
                            fontWeight = FontWeight.SemiBold
                        )

                        Text(
                            item.plot.ifBlank { "Full plot synopsis ready." },
                            color = Color(0xFFE5E7EB),
                            fontSize = 14.sp,
                            lineHeight = 20.sp
                        )

                        if (item.genres.isNotEmpty()) {
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text("Genres:", color = Color(0xFF9CA3AF), fontSize = 12.sp)
                                item.genres.forEach { g ->
                                    FilterChipPill(g, Color(0xFF1F2937)) {
                                        onJumpToFilter(SuperFilterState(includedGenres = setOf(g)))
                                    }
                                }
                            }
                        }

                        if (item.director.isNotBlank() || item.cast.isNotEmpty()) {
                            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                                if (item.director.isNotBlank()) {
                                    item {
                                        FilterChipPill("🎬 Dir: ${item.director}", Color(0xFF312E81)) {
                                            onJumpToFilter(SuperFilterState(directorFilter = item.director))
                                        }
                                    }
                                }
                                items(item.cast) { actor ->
                                    FilterChipPill("🎭 $actor", Color(0xFF1E293B)) {
                                        onJumpToFilter(SuperFilterState(actorFilter = actor))
                                    }
                                }
                            }
                        }

                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            if (item.mediaType == MediaType.MOVIE) {
                                val primaryVer = item.versions.firstOrNull() ?: StreamVersion(
                                    item.primaryStreamId, item.rawTitle, item.language, "HD", "", "mp4", "", "", 0L
                                )
                                val playLabel = if (item.resumePositionMs > 15_000L) {
                                    "▶ Resume (${item.resumePositionMs / 60000}m)"
                                } else {
                                    "▶ Play (${primaryVer.languageTag} • ${primaryVer.qualityTag})"
                                }
                                TvOsdButton(playLabel, isPrimary = true) { onPlayVersion(primaryVer) }
                            }
                            TvOsdButton(if (inWatchlist) "★ In My List" else "+ Add to My List") {
                                inWatchlist = db.toggleWatchlist(item.dedupKey)
                            }
                            TvOsdButton(if (isWatched) "✓ Watched" else "Mark as Watched") {
                                isWatched = db.toggleWatched(item.dedupKey)
                            }
                        }
                    }
                }
            }

            if (item.mediaType == MediaType.MOVIE && item.versions.size > 1) {
                item {
                    Text(
                        "🎞️ Available Stream Versions (${item.versions.size} Copies Merged):",
                        color = Color.White,
                        fontSize = 17.sp,
                        fontWeight = FontWeight.Bold
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        items(item.versions) { ver ->
                            TvOsdButton("▶ ${ver.languageTag} • ${ver.qualityTag} (${ver.containerExtension.uppercase()})") {
                                onPlayVersion(ver)
                            }
                        }
                    }
                }
            }

            if (item.mediaType == MediaType.SERIES) {
                val seasons = episodes.map { it.seasonNumber }.distinct().sorted()
                item {
                    Text("📺 Seasons & Episodes:", color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                    Spacer(modifier = Modifier.height(8.dp))
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(seasons) { sNum ->
                            FilterChipPill(
                                text = "Season $sNum",
                                stateColor = if (selectedSeason == sNum) Color(0xFFE50914) else Color(0xFF252836)
                            ) {
                                selectedSeason = sNum
                            }
                        }
                    }
                }
                val seasonEps = episodes.filter { it.seasonNumber == selectedSeason }
                items(seasonEps.size) { idx ->
                    val ep = seasonEps[idx]
                    val nextEp = seasonEps.getOrNull(idx + 1)
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(Color(0xFF161821), RoundedCornerShape(10.dp))
                            .padding(14.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                "S${ep.seasonNumber}E${ep.episodeNumber} — ${ep.title}",
                                color = Color.White,
                                fontSize = 15.sp,
                                fontWeight = FontWeight.Bold
                            )
                            if (ep.plot.isNotBlank()) {
                                Text(ep.plot, color = Color(0xFF9CA3AF), fontSize = 12.sp, maxLines = 2)
                            }
                        }
                        TvOsdButton("▶ Play Episode", isPrimary = true) { onPlayEpisode(ep, nextEp) }
                    }
                }
            }

            if (moreLikeThis.isNotEmpty()) {
                item {
                    MediaHorizontalRow(
                        title = "✨ More Like ${item.cleanTitle}",
                        items = moreLikeThis,
                        onSelectMedia = onSelectRelatedMedia
                    )
                }
            }
        }
    }
}

@Composable
private fun CatalogGridByTypeScreen(
    title: String,
    mediaType: MediaType,
    db: StreamVaultDatabase,
    creds: XtreamCredentials,
    refreshTick: Int,
    onSelectMedia: (MediaItem) -> Unit,
    onOpenSuperFilter: () -> Unit
) {
    val genres = remember { listOf("All") + db.getAllDistinctGenres() }
    var selectedGenre by remember { mutableStateOf("All") }

    val items = remember(selectedGenre, mediaType, refreshTick, creds.hiddenLanguages) {
        val inc = if (selectedGenre == "All") emptySet() else setOf(selectedGenre)
        db.queryMedia(
            SuperFilterState(mediaTypeFilter = mediaType, includedGenres = inc, sortBy = SortOption.RATING_DESC),
            creds.hiddenLanguages,
            limit = 200
        )
    }

    Column(modifier = Modifier.fillMaxSize().padding(24.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(title, color = Color.White, fontSize = 24.sp, fontWeight = FontWeight.ExtraBold)
            TvOsdButton("🔍 Open Multi-Attribute Super-Filter", isPrimary = true) { onOpenSuperFilter() }
        }
        Spacer(modifier = Modifier.height(12.dp))
        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            items(genres) { g ->
                FilterChipPill(
                    text = g,
                    stateColor = if (selectedGenre == g) Color(0xFFE50914) else Color(0xFF252836)
                ) {
                    selectedGenre = g
                }
            }
        }
        Spacer(modifier = Modifier.height(16.dp))
        LazyVerticalGrid(
            columns = GridCells.Adaptive(minSize = 148.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
            horizontalArrangement = Arrangement.spacedBy(14.dp),
            modifier = Modifier.fillMaxSize()
        ) {
            items(items, key = { it.dedupKey }) { item ->
                NetflixPosterCard(item = item, onClick = { onSelectMedia(item) })
            }
        }
    }
}

@Composable
private fun LiveTvBrowserScreen(
    db: StreamVaultDatabase,
    refreshTick: Int,
    onPlayLiveChannel: (LiveChannel) -> Unit
) {
    var favTick by remember { mutableStateOf(0) }
    val categories = remember(refreshTick, favTick) { db.getLiveCategories() }
    var selectedCategory by remember { mutableStateOf("All Channels") }
    var searchQuery by remember { mutableStateOf("") }
    val channels = remember(selectedCategory, searchQuery, refreshTick, favTick) {
        db.getLiveChannels(selectedCategory, searchQuery)
    }

    Row(modifier = Modifier.fillMaxSize().padding(20.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        LazyColumn(
            modifier = Modifier
                .width(230.dp)
                .fillMaxHeight()
                .background(Color(0xFF141722), RoundedCornerShape(12.dp))
                .padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            item {
                Text("📡 Categories", color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                Spacer(modifier = Modifier.height(6.dp))
            }
            items(categories) { cat ->
                FilterChipPill(
                    text = cat,
                    stateColor = if (selectedCategory == cat) Color(0xFFE50914) else Color(0xFF252836)
                ) {
                    selectedCategory = cat
                }
            }
        }

        Column(
            modifier = Modifier
                .weight(1f)
                .fillMaxHeight()
                .background(Color(0xFF141722), RoundedCornerShape(12.dp))
                .padding(16.dp)
        ) {
            Text(
                "$selectedCategory (${channels.size} Channels)",
                color = Color.White,
                fontSize = 20.sp,
                fontWeight = FontWeight.Bold
            )
            Spacer(modifier = Modifier.height(12.dp))
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(channels, key = { it.streamId }) { ch ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(Color(0xFF1D2130), RoundedCornerShape(10.dp))
                            .padding(12.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                "${if (ch.isFavorite) "★ " else ""}${ch.name}",
                                color = Color.White,
                                fontSize = 16.sp,
                                fontWeight = FontWeight.Bold
                            )
                            Text(
                                buildString {
                                    append(ch.categoryName)
                                    if (ch.currentProgramTitle.isNotBlank()) {
                                        append(" • Now: ${ch.currentProgramTitle}")
                                    }
                                    if (ch.nextProgramTitle.isNotBlank()) {
                                        append(" | Next: ${ch.nextProgramTitle}")
                                    }
                                },
                                color = Color(0xFF9CA3AF),
                                fontSize = 12.sp
                            )
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            TvOsdButton("▶ Watch Live", isPrimary = true) { onPlayLiveChannel(ch) }
                            TvOsdButton(if (ch.isFavorite) "★ Unfavorite" else "☆ Favorite") {
                                db.toggleFavoriteChannel(ch.streamId)
                                favTick++
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun WatchlistScreen(
    db: StreamVaultDatabase,
    refreshTick: Int,
    onSelectMedia: (MediaItem) -> Unit
) {
    val watchlist = remember(refreshTick) { db.getWatchlist() }
    val continueWatching = remember(refreshTick) { db.getContinueWatchingList() }

    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp)
    ) {
        item {
            Text("⭐ My List & Continue Watching", color = Color.White, fontSize = 24.sp, fontWeight = FontWeight.ExtraBold)
        }
        if (continueWatching.isNotEmpty()) {
            item {
                MediaHorizontalRow("⏯ Continue Watching", items = continueWatching, onSelectMedia = onSelectMedia)
            }
        }
        if (watchlist.isNotEmpty()) {
            item {
                MediaHorizontalRow("⭐ Saved in My List", items = watchlist, onSelectMedia = onSelectMedia)
            }
        } else {
            item {
                Text(
                    "Your Watchlist is empty. Open any Movie or Series and click '+ Add to My List'.",
                    color = Color(0xFF9CA3AF),
                    fontSize = 15.sp
                )
            }
        }
    }
}

@Composable
private fun QrSetupAndSyncScreen(
    prefs: PreferencesManager,
    syncState: SyncProgressState,
    portalUrl: String,
    onTriggerManualSync: () -> Unit
) {
    val creds by prefs.credentialsFlow.collectAsState()
    var serverUrl by remember(creds) { mutableStateOf(creds.serverUrl) }
    var username by remember(creds) { mutableStateOf(creds.username) }
    var password by remember(creds) { mutableStateOf(creds.password) }
    var playlistName by remember(creds) { mutableStateOf(creds.playlistName) }
    val qrBitmap: Bitmap? = remember(portalUrl) { PhoneCompanionServer.generateQrBitmap(portalUrl, 260) }

    val allLangs = listOf("English", "Hindi", "Urdu", "Arabic", "Turkish", "Korean", "Spanish", "French", "German", "Polish", "Russian")

    Row(
        modifier = Modifier.fillMaxSize().padding(28.dp),
        horizontalArrangement = Arrangement.spacedBy(28.dp)
    ) {
        Column(
            modifier = Modifier
                .width(380.dp)
                .fillMaxHeight()
                .background(Color(0xFF141722), RoundedCornerShape(16.dp))
                .padding(22.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Text("📱 Scan to Setup or Search from Phone", color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.Bold)
            Text(
                "Scan with your phone camera or open this URL on your phone/PC to paste your IPTV login & beam searches to your TV:",
                color = Color(0xFF9CA3AF),
                fontSize = 12.sp
            )
            if (qrBitmap != null) {
                Image(
                    bitmap = qrBitmap.asImageBitmap(),
                    contentDescription = "Wi-Fi Setup QR Code",
                    modifier = Modifier
                        .size(210.dp)
                        .clip(RoundedCornerShape(12.dp))
                        .background(Color.White)
                        .padding(8.dp)
                )
            }
            Text(
                portalUrl,
                color = Color(0xFF34D399),
                fontSize = 16.sp,
                fontWeight = FontWeight.ExtraBold
            )
            TvOsdButton("🔄 Sync IPTV Catalog Now", isPrimary = true) { onTriggerManualSync() }
            Text(syncState.phase, color = Color(0xFF9CA3AF), fontSize = 12.sp)
        }

        LazyColumn(
            modifier = Modifier
                .weight(1f)
                .fillMaxHeight()
                .background(Color(0xFF141722), RoundedCornerShape(16.dp))
                .padding(22.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            item {
                Text("⚙️ Xtream Codes IPTV Credentials", color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.Bold)
            }
            item {
                OutlinedTextField(
                    value = playlistName,
                    onValueChange = { playlistName = it },
                    label = { Text("Playlist Name") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
            }
            item {
                OutlinedTextField(
                    value = serverUrl,
                    onValueChange = { serverUrl = it },
                    label = { Text("Server URL (e.g. http://your-vendor.com:8080)") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
            }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    OutlinedTextField(
                        value = username,
                        onValueChange = { username = it },
                        label = { Text("Username") },
                        singleLine = true,
                        modifier = Modifier.weight(1f)
                    )
                    OutlinedTextField(
                        value = password,
                        onValueChange = { password = it },
                        label = { Text("Password") },
                        singleLine = true,
                        modifier = Modifier.weight(1f)
                    )
                }
            }
            item {
                TvOsdButton("💾 Save Credentials & Start Sync", isPrimary = true) {
                    prefs.saveCredentials(
                        creds.copy(
                            playlistName = playlistName,
                            serverUrl = serverUrl,
                            username = username,
                            password = password
                        )
                    )
                    onTriggerManualSync()
                }
            }

            item {
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    "🌐 Auto-Hide Unwanted Languages Globally (Click to Hide/Show):",
                    color = Color.White,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Bold
                )
                Spacer(modifier = Modifier.height(6.dp))
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(allLangs) { lang ->
                        val isHidden = creds.hiddenLanguages.contains(lang)
                        FilterChipPill(
                            text = if (isHidden) "🚫 Hidden: $lang" else "✓ Show: $lang",
                            stateColor = if (isHidden) Color(0xFFDC2626) else Color(0xFF059669)
                        ) {
                            val next = if (isHidden) creds.hiddenLanguages - lang else creds.hiddenLanguages + lang
                            prefs.saveCredentials(creds.copy(hiddenLanguages = next))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun BadgePill(text: String, bgColor: Color) {
    Box(
        modifier = Modifier
            .background(bgColor, RoundedCornerShape(6.dp))
            .padding(horizontal = 8.dp, vertical = 3.dp)
    ) {
        Text(text, color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun FilterChipPill(
    text: String,
    stateColor: Color,
    onClick: () -> Unit
) {
    var focused by remember { mutableStateOf(false) }
    Box(
        modifier = Modifier
            .onFocusChanged { focused = it.isFocused }
            .focusable()
            .clickable { onClick() }
            .background(if (focused) Color(0xFFE50914) else stateColor, RoundedCornerShape(8.dp))
            .border(
                width = if (focused) 2.dp else 1.dp,
                color = if (focused) Color.White else Color(0xFF374151),
                shape = RoundedCornerShape(8.dp)
            )
            .padding(horizontal = 10.dp, vertical = 6.dp)
    ) {
        Text(text, color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
    }
}
