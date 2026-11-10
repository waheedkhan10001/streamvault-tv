package com.streamvault.tv

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.media.ToneGenerator
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.*
import android.widget.*
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Tracks
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.TrackSelectionParameters
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import androidx.media3.ui.CaptionStyleCompat
import android.util.TypedValue
import java.net.URLEncoder
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import kotlin.concurrent.thread

@OptIn(UnstableApi::class)
class MainActivity : Activity() {

    private lateinit var rootLayout: FrameLayout
    private lateinit var webView: WebView

    // Track structure for multi-audio and subtitles
    data class StreamTrack(
        val groupIndex: Int,
        val trackIndex: Int,
        val label: String,
        val isSelected: Boolean,
        val isOff: Boolean = false
    )

    // Native ExoPlayer Overlay for 4K MKV/TS Hardware Accelerated Playback
    private var playerView: PlayerView? = null
    private var exoPlayer: ExoPlayer? = null
    private var playerOverlay: FrameLayout? = null // Timeline Scrubber & Title OSD
    private var hudOverlay: FrameLayout? = null // Always-responsive HUD (indicators + drawer)
    private var playerTitleView: TextView? = null
    private var playerTimeView: TextView? = null
    private var playerDurationView: TextView? = null
    private var playerProgressBar: ProgressBar? = null

    // Left and Right HUD indicators for seek
    private var playerLeftIndicator: TextView? = null
    private var playerRightIndicator: TextView? = null
    private var playerCenterIndicator: TextView? = null

    // Audio & Subtitles Drawer
    private var audioSubDrawer: LinearLayout? = null
    private var isAudioSubDrawerOpen: Boolean = false
    private var audioSubActiveColumn: Int = 0 // 0 = Audio, 1 = Subtitles
    private var audioCursorIdx: Int = 0
    private var subCursorIdx: Int = 0
    private var audioTracksList: List<StreamTrack> = emptyList()
    private var subtitleTracksList: List<StreamTrack> = emptyList()
    private var audioColumnLayout: LinearLayout? = null
    private var subtitleColumnLayout: LinearLayout? = null

    private var isPlayingVideo = false
    private var currentDedupKey: String = ""
    private var currentExpectedDurationMs: Long = 0L
    private val localAssetUrl = "file:///android_asset/tv-ui.html"
    private var resolveStreamThread: Thread? = null

    lateinit var db: com.streamvault.tv.data.StreamVaultDatabase
    lateinit var prefs: com.streamvault.tv.data.PreferencesManager
    lateinit var syncEngine: com.streamvault.tv.data.CatalogSyncEngine
    lateinit var apiRouter: com.streamvault.tv.data.AppApiRouter

    private var toneGen: ToneGenerator? = null
    private var lastBackPressTime: Long = 0L
    private var exitToast: Toast? = null

    private val osdHandler = Handler(Looper.getMainLooper())
    private val progressHandler = Handler(Looper.getMainLooper())
    private val indicatorHandler = Handler(Looper.getMainLooper())

    private val hideOsdRunnable = Runnable {
        playerOverlay?.animate()?.alpha(0f)?.setDuration(220)?.withEndAction {
            playerOverlay?.visibility = View.GONE
        }?.start()
    }

    private val hideIndicatorRunnable = Runnable {
        playerLeftIndicator?.visibility = View.GONE
        playerRightIndicator?.visibility = View.GONE
        if (exoPlayer?.isPlaying == true) {
            playerCenterIndicator?.visibility = View.GONE
        }
    }

    private var autosaveTickCounter = 0
    private val updateProgressRunnable = object : Runnable {
        override fun run() {
            if (isPlayingVideo && exoPlayer != null) {
                updateOsdTime()
                autosaveTickCounter++
                if (autosaveTickCounter >= 10) {
                    autosaveTickCounter = 0
                    val pos = exoPlayer?.currentPosition ?: 0L
                    val dur = if ((exoPlayer?.duration ?: 0L) > 0L) exoPlayer!!.duration else currentExpectedDurationMs
                    if (pos > 5000L && currentDedupKey.isNotEmpty()) {
                        val js = "if(window.recordPlaybackProgress){ window.recordPlaybackProgress('$currentDedupKey', $pos, $dur); }"
                        webView.evaluateJavascript(js, null)
                    }
                }
                progressHandler.postDelayed(this, 1000)
            }
        }
    }

    class WebAppInterface(private val activity: MainActivity) {
        @JavascriptInterface
        fun playStream(streamUrl: String, title: String, startMs: Long, dedupKey: String, expectedDurationMs: Long, containerExt: String) {
            activity.runOnUiThread {
                activity.startNativeExoPlayer(streamUrl, title, startMs, dedupKey, expectedDurationMs, containerExt)
            }
        }

        @JavascriptInterface
        fun playStream(streamUrl: String, title: String, startMs: Long, dedupKey: String, expectedDurationMs: Long) {
            playStream(streamUrl, title, startMs, dedupKey, expectedDurationMs, "")
        }

        @JavascriptInterface
        fun playStream(streamUrl: String, title: String, startMs: Long, dedupKey: String) {
            playStream(streamUrl, title, startMs, dedupKey, 0L, "")
        }

        @JavascriptInterface
        fun playNavTick() {
            activity.runOnUiThread {
                activity.playAcousticTick()
            }
        }

        @JavascriptInterface
        fun startVoiceInput() {
            activity.runOnUiThread {
                activity.launchVoiceSearch()
            }
        }

        @JavascriptInterface
        fun isNative(): Boolean = true

        @JavascriptInterface
        fun getAppVersion(): String = "2.6.0-standalone"

        @JavascriptInterface
        fun handleApiRequest(method: String, path: String, body: String): String {
            return activity.apiRouter.handle(method, path, body)
        }
    }

    private val VOICE_SEARCH_REQUEST_CODE = 1001
    private val RECORD_AUDIO_PERMISSION_CODE = 1002

    fun launchVoiceSearch() {
        if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(android.Manifest.permission.RECORD_AUDIO), RECORD_AUDIO_PERMISSION_CODE)
            return
        }
        try {
            val intent = android.content.Intent(android.speech.RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE_MODEL, android.speech.RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(android.speech.RecognizerIntent.EXTRA_PROMPT, "Speak a movie, series, actor, or genre...")
            }
            startActivityForResult(intent, VOICE_SEARCH_REQUEST_CODE)
        } catch (e: Exception) {
            Log.e("StreamVault", "Voice search not available: ${e.message}")
            runOnUiThread {
                webView.evaluateJavascript("if(window.onVoiceSearchError){ window.onVoiceSearchError('Voice search not available on this remote'); }", null)
            }
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == RECORD_AUDIO_PERMISSION_CODE && grantResults.isNotEmpty() && grantResults[0] == android.content.pm.PackageManager.PERMISSION_GRANTED) {
            launchVoiceSearch()
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: android.content.Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == VOICE_SEARCH_REQUEST_CODE && resultCode == Activity.RESULT_OK && data != null) {
            val results = data.getStringArrayListExtra(android.speech.RecognizerIntent.EXTRA_RESULTS)
            val query = results?.firstOrNull() ?: ""
            if (query.isNotEmpty()) {
                val safeQuery = query.replace("\\", "\\\\").replace("'", "\\'")
                webView.evaluateJavascript("if(window.onVoiceSearchResult){ window.onVoiceSearchResult('$safeQuery'); }", null)
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        try {
            val isDebuggable = (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
            WebView.setWebContentsDebuggingEnabled(isDebuggable)
        } catch (_: Exception) {}

        initAcousticClick()

        db = com.streamvault.tv.data.StreamVaultDatabase.getInstance(this)
        prefs = com.streamvault.tv.data.PreferencesManager(this)
        syncEngine = com.streamvault.tv.data.CatalogSyncEngine(
            db,
            prefs,
            kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.IO)
        )
        apiRouter = com.streamvault.tv.data.AppApiRouter(this, db, prefs, syncEngine)

        try {
            toneGen = ToneGenerator(AudioManager.STREAM_MUSIC, 65)
        } catch (_: Exception) {}

        // Immersive TV mode
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            or View.SYSTEM_UI_FLAG_FULLSCREEN
            or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        )

        // Obsidian Background (#090714)
        rootLayout = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#090714"))
        }

        webView = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#090714"))
            setLayerType(View.LAYER_TYPE_HARDWARE, null)
            isFocusable = true
            isFocusableInTouchMode = true
            requestFocus()

            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                mediaPlaybackRequiresUserGesture = false
                allowFileAccess = true
                allowContentAccess = true
                allowFileAccessFromFileURLs = false
                allowUniversalAccessFromFileURLs = false
                loadsImagesAutomatically = true
                mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                useWideViewPort = true
                loadWithOverviewMode = true
                cacheMode = WebSettings.LOAD_DEFAULT
            }

            addJavascriptInterface(WebAppInterface(this@MainActivity), "AndroidApp")

            webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(consoleMessage: ConsoleMessage?): Boolean {
                    Log.d("StreamVaultWeb", "${consoleMessage?.message()} -- From line ${consoleMessage?.lineNumber()}")
                    return super.onConsoleMessage(consoleMessage)
                }
            }

            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView?,
                    request: WebResourceRequest?
                ): WebResourceResponse? {
                    val url = request?.url ?: return null
                    val urlStr = url.toString()
                    if (urlStr.contains("/api/")) {
                        val path = url.path ?: ""
                        val query = url.query ?: ""
                        val fullPath = if (query.isNotEmpty()) "$path?$query" else path
                        val method = request.method ?: "GET"
                        val responseJson = apiRouter.handle(method, fullPath, "")
                        return WebResourceResponse(
                            "application/json",
                            "UTF-8",
                            java.io.ByteArrayInputStream(responseJson.toByteArray(Charsets.UTF_8))
                        )
                    }
                    return super.shouldInterceptRequest(view, request)
                }

                override fun onReceivedError(
                    view: WebView?,
                    request: WebResourceRequest?,
                    error: WebResourceError?
                ) {
                    Log.e("StreamVaultWeb", "Web error: ${error?.description}")
                    if (request?.isForMainFrame == true && view?.url?.startsWith("file:") != true) {
                        view?.post {
                            view.loadUrl(localAssetUrl)
                        }
                    }
                    super.onReceivedError(view, request, error)
                }
            }
        }

        rootLayout.addView(
            webView,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        )

        setContentView(rootLayout)

        Log.i("StreamVault", "Booting StreamVault TV Standalone: $localAssetUrl")
        webView.loadUrl(localAssetUrl)
    }

    private var clickPcmData: ByteArray? = null

    private fun initAcousticClick() {
        try {
            val sampleRate = 44100
            val numSamples = (sampleRate * 0.020).toInt() // 20ms
            val buffer = ShortArray(numSamples)
            for (i in 0 until numSamples) {
                val t = i.toDouble() / sampleRate
                val progress = i.toDouble() / numSamples
                val freq = 420.0 * Math.exp(-progress * 2.5)
                val decay = Math.exp(-progress * 5.0)
                val sample = (Math.sin(2.0 * Math.PI * freq * t) * decay * 11000.0).toInt()
                buffer[i] = sample.toShort()
            }
            val byteBuf = ByteArray(numSamples * 2)
            for (i in 0 until numSamples) {
                byteBuf[i * 2] = (buffer[i].toInt() and 0xFF).toByte()
                byteBuf[i * 2 + 1] = ((buffer[i].toInt() shr 8) and 0xFF).toByte()
            }
            clickPcmData = byteBuf
        } catch (_: Exception) {}
    }

    fun playAcousticTick() {
        val data = clickPcmData ?: return
        try {
            val track = AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build()
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(44100)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build()
                )
                .setBufferSizeInBytes(data.size)
                .setTransferMode(AudioTrack.MODE_STATIC)
                .build()
            track.write(data, 0, data.size)
            track.play()
        } catch (_: Exception) {
            try {
                val audioManager = getSystemService(Context.AUDIO_SERVICE) as? AudioManager
                audioManager?.playSoundEffect(android.view.SoundEffectConstants.NAVIGATION_RIGHT, 0.45f)
            } catch (_: Exception) {}
        }
    }

    private fun setupPlayerView() {
        val density = resources.displayMetrics.density

        playerView = PlayerView(this).apply {
            useController = false // Custom Netflix-standard OSD
            setBackgroundColor(Color.BLACK)
            subtitleView?.apply {
                val style = CaptionStyleCompat(
                    Color.WHITE,
                    Color.TRANSPARENT,
                    Color.TRANSPARENT,
                    CaptionStyleCompat.EDGE_TYPE_DROP_SHADOW,
                    Color.BLACK,
                    Typeface.DEFAULT_BOLD
                )
                setStyle(style)
                setFixedTextSize(TypedValue.COMPLEX_UNIT_SP, 22f)
                setApplyEmbeddedStyles(true)
                setApplyEmbeddedFontSizes(false)
            }
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }

        // Timeline & Title OSD (Auto-fades with alpha animation)
        playerOverlay = FrameLayout(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }

        // Always-responsive HUD overlay (Indicators & Audio/Sub drawer)
        hudOverlay = FrameLayout(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }

        // Top Title Header
        val topGradient = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val grad = GradientDrawable(
                GradientDrawable.Orientation.TOP_BOTTOM,
                intArrayOf(Color.parseColor("#E6090714"), Color.TRANSPARENT)
            )
            background = grad
            setPadding((44 * density).toInt(), (32 * density).toInt(), (44 * density).toInt(), (36 * density).toInt())
            layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                gravity = Gravity.TOP
            }
        }

        playerTitleView = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 24f
            typeface = Typeface.DEFAULT_BOLD
            setShadowLayer(8f, 0f, 2f, Color.BLACK)
        }
        topGradient.addView(playerTitleView)
        playerOverlay?.addView(topGradient)

        // Left HUD Indicator (Rewind -10s ⟲)
        playerLeftIndicator = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 15f
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            val circle = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.parseColor("#D9120E24"))
                setStroke((2f * density).toInt(), Color.parseColor("#8B5CF6"))
            }
            background = circle
            visibility = View.GONE
            val size = (68 * density).toInt()
            val lp = FrameLayout.LayoutParams(size, size).apply {
                gravity = Gravity.START or Gravity.CENTER_VERTICAL
                marginStart = (64 * density).toInt()
            }
            layoutParams = lp
        }
        hudOverlay?.addView(playerLeftIndicator)

        // Right HUD Indicator (Forward +10s ⟳)
        playerRightIndicator = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 15f
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            val circle = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.parseColor("#D9120E24"))
                setStroke((2f * density).toInt(), Color.parseColor("#8B5CF6"))
            }
            background = circle
            visibility = View.GONE
            val size = (68 * density).toInt()
            val lp = FrameLayout.LayoutParams(size, size).apply {
                gravity = Gravity.END or Gravity.CENTER_VERTICAL
                marginEnd = (64 * density).toInt()
            }
            layoutParams = lp
        }
        hudOverlay?.addView(playerRightIndicator)

        // Center HUD Indicator (❚❚ Paused / ▶ Playing)
        playerCenterIndicator = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 22f
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            val pill = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                setColor(Color.parseColor("#F2120E24"))
                setStroke((2f * density).toInt(), Color.parseColor("#7C3AED"))
                cornerRadius = 16 * density
            }
            background = pill
            setPadding((32 * density).toInt(), (16 * density).toInt(), (32 * density).toInt(), (16 * density).toInt())
            visibility = View.GONE
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                gravity = Gravity.CENTER
            }
        }
        hudOverlay?.addView(playerCenterIndicator)

        // Setup In-Player Audio & Subtitles Drawer
        setupAudioSubDrawer(density)

        // Bottom Timeline Only
        val bottomGradient = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            val grad = GradientDrawable(
                GradientDrawable.Orientation.BOTTOM_TOP,
                intArrayOf(Color.parseColor("#F2090714"), Color.TRANSPARENT)
            )
            background = grad
            setPadding((44 * density).toInt(), (36 * density).toInt(), (44 * density).toInt(), (32 * density).toInt())
            layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                gravity = Gravity.BOTTOM
            }
        }

        playerTimeView = TextView(this).apply {
            text = "00:00:00"
            setTextColor(Color.parseColor("#E5E7EB"))
            textSize = 14f
            typeface = Typeface.DEFAULT_BOLD
        }
        bottomGradient.addView(playerTimeView)

        playerProgressBar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            isIndeterminate = false
            max = 1000
            progress = 0
            val pLp = LinearLayout.LayoutParams(0, (6 * density).toInt(), 1f).apply {
                marginStart = (16 * density).toInt()
                marginEnd = (16 * density).toInt()
            }
            layoutParams = pLp
        }
        bottomGradient.addView(playerProgressBar)

        playerDurationView = TextView(this).apply {
            text = "00:00:00"
            setTextColor(Color.parseColor("#9CA3AF"))
            textSize = 14f
            typeface = Typeface.DEFAULT_BOLD
        }
        bottomGradient.addView(playerDurationView)

        playerOverlay?.addView(bottomGradient)

        rootLayout.addView(playerView)
        rootLayout.addView(playerOverlay)
        rootLayout.addView(hudOverlay)
    }

    private fun setupAudioSubDrawer(density: Float) {
        audioSubDrawer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val bg = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                setColor(Color.parseColor("#F5100C1F"))
                setStroke((2f * density).toInt(), Color.parseColor("#7C3AED"))
                cornerRadius = 16 * density
            }
            background = bg
            setPadding((24 * density).toInt(), (20 * density).toInt(), (24 * density).toInt(), (20 * density).toInt())
            visibility = View.GONE
            val lp = FrameLayout.LayoutParams(
                (640 * density).toInt(),
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                gravity = Gravity.CENTER_HORIZONTAL or Gravity.BOTTOM
                bottomMargin = (40 * density).toInt()
            }
            layoutParams = lp
        }

        val headerTitle = TextView(this).apply {
            text = "Audio & Subtitles"
            setTextColor(Color.WHITE)
            textSize = 18f
            typeface = Typeface.DEFAULT_BOLD
            setPadding(0, 0, 0, (4 * density).toInt())
        }
        audioSubDrawer?.addView(headerTitle)

        val headerHint = TextView(this).apply {
            text = "◀ ▶ Switch column  •  ▲ ▼ Navigate  •  OK Select  •  Back Close"
            setTextColor(Color.parseColor("#A78BFA"))
            textSize = 11f
            typeface = Typeface.DEFAULT_BOLD
            setPadding(0, 0, 0, (14 * density).toInt())
        }
        audioSubDrawer?.addView(headerHint)

        val columnsRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }

        // Left Column: Audio
        val leftWrapper = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                marginEnd = (12 * density).toInt()
            }
        }
        val audioTitle = TextView(this).apply {
            text = "AUDIO TRACKS"
            setTextColor(Color.parseColor("#9CA3AF"))
            textSize = 12f
            typeface = Typeface.DEFAULT_BOLD
            setPadding(0, 0, 0, (8 * density).toInt())
        }
        leftWrapper.addView(audioTitle)
        audioColumnLayout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        leftWrapper.addView(audioColumnLayout)
        columnsRow.addView(leftWrapper)

        // Right Column: Subtitles
        val rightWrapper = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                marginStart = (12 * density).toInt()
            }
        }
        val subTitle = TextView(this).apply {
            text = "SUBTITLES"
            setTextColor(Color.parseColor("#9CA3AF"))
            textSize = 12f
            typeface = Typeface.DEFAULT_BOLD
            setPadding(0, 0, 0, (8 * density).toInt())
        }
        rightWrapper.addView(subTitle)
        subtitleColumnLayout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        rightWrapper.addView(subtitleColumnLayout)
        columnsRow.addView(rightWrapper)

        audioSubDrawer?.addView(columnsRow)
        hudOverlay?.addView(audioSubDrawer)
    }

    private fun refreshTracks() {
        val player = exoPlayer ?: return
        val tracks = player.currentTracks
        val aList = mutableListOf<StreamTrack>()
        val sList = mutableListOf<StreamTrack>()

        var anySubSelected = false
        var aIdx = 0
        var sIdx = 0

        for (gIdx in 0 until tracks.groups.size) {
            val group = tracks.groups[gIdx]
            if (group.type == C.TRACK_TYPE_AUDIO) {
                for (tIdx in 0 until group.length) {
                    val format = group.getTrackFormat(tIdx)
                    val isSel = group.isTrackSelected(tIdx)
                    val lang = format.language?.uppercase() ?: "AUDIO"
                    val channels = when (format.channelCount) {
                        6 -> "5.1 Surround"
                        8 -> "7.1 Surround"
                        2 -> "Stereo"
                        1 -> "Mono"
                        else -> "${format.channelCount}ch"
                    }
                    val codec = format.sampleMimeType?.substringAfterLast("/")?.uppercase() ?: ""
                    val extra = listOf(codec, channels).filter { it.isNotBlank() }.joinToString(" • ")
                    val label = if (format.label.isNullOrBlank()) "$lang ($extra)" else "${format.label} ($extra)"

                    aList.add(StreamTrack(gIdx, tIdx, label, isSel))
                    if (isSel) audioCursorIdx = aIdx
                    aIdx++
                }
            } else if (group.type == C.TRACK_TYPE_TEXT) {
                for (tIdx in 0 until group.length) {
                    val format = group.getTrackFormat(tIdx)
                    val isSel = group.isTrackSelected(tIdx)
                    if (isSel) anySubSelected = true
                    val lang = format.language?.uppercase() ?: "SUB ${sIdx + 1}"
                    val label = if (format.label.isNullOrBlank()) lang else "${format.label} ($lang)"

                    sList.add(StreamTrack(gIdx, tIdx, label, isSel))
                    if (isSel) subCursorIdx = sIdx + 1
                    sIdx++
                }
            }
        }

        sList.add(0, StreamTrack(-1, -1, "Off (Disable)", !anySubSelected, isOff = true))
        if (!anySubSelected) subCursorIdx = 0

        if (aList.isEmpty()) {
            aList.add(StreamTrack(-1, -1, "Default Audio Track", true))
        }

        audioTracksList = aList
        subtitleTracksList = sList
    }

    private fun renderAudioSubDrawer() {
        val density = resources.displayMetrics.density
        audioColumnLayout?.removeAllViews()
        subtitleColumnLayout?.removeAllViews()

        for (i in audioTracksList.indices) {
            val track = audioTracksList[i]
            val isFocused = (audioSubActiveColumn == 0 && audioCursorIdx == i)
            val row = buildTrackRow(track.label, track.isSelected, isFocused, density)
            audioColumnLayout?.addView(row)
        }

        for (i in subtitleTracksList.indices) {
            val track = subtitleTracksList[i]
            val isFocused = (audioSubActiveColumn == 1 && subCursorIdx == i)
            val row = buildTrackRow(track.label, track.isSelected, isFocused, density)
            subtitleColumnLayout?.addView(row)
        }
    }

    private fun buildTrackRow(label: String, isSelected: Boolean, isFocused: Boolean, density: Float): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            val bg = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                if (isFocused) {
                    setColor(Color.parseColor("#7C3AED"))
                    setStroke((1.5f * density).toInt(), Color.WHITE)
                } else if (isSelected) {
                    setColor(Color.parseColor("#251C42"))
                } else {
                    setColor(Color.parseColor("#141124"))
                }
                cornerRadius = 8 * density
            }
            background = bg
            setPadding((12 * density).toInt(), (8 * density).toInt(), (12 * density).toInt(), (8 * density).toInt())
            val lp = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                bottomMargin = (6 * density).toInt()
            }
            layoutParams = lp

            val tv = TextView(this@MainActivity).apply {
                text = label
                setTextColor(if (isFocused || isSelected) Color.WHITE else Color.parseColor("#D1D5DB"))
                textSize = 12f
                typeface = if (isSelected) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            addView(tv)

            if (isSelected) {
                val check = TextView(this@MainActivity).apply {
                    text = "✓"
                    setTextColor(Color.parseColor("#10B981"))
                    textSize = 14f
                    typeface = Typeface.DEFAULT_BOLD
                }
                addView(check)
            }
        }
    }

    private fun openAudioSubDrawer() {
        refreshTracks()
        renderAudioSubDrawer()
        isAudioSubDrawerOpen = true
        audioSubDrawer?.visibility = View.VISIBLE
        hudOverlay?.visibility = View.VISIBLE
        hideOsdImmediately()
    }

    private fun closeAudioSubDrawer() {
        isAudioSubDrawerOpen = false
        audioSubDrawer?.visibility = View.GONE
        showOsd()
    }

    private fun applySelectedTrack() {
        val player = exoPlayer ?: return
        val tracks = player.currentTracks

        if (audioSubActiveColumn == 0 && audioCursorIdx in audioTracksList.indices) {
            val item = audioTracksList[audioCursorIdx]
            if (item.groupIndex in 0 until tracks.groups.size) {
                val group = tracks.groups[item.groupIndex]
                player.trackSelectionParameters = player.trackSelectionParameters
                    .buildUpon()
                    .setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, item.trackIndex))
                    .build()
                flashCenterIndicator("Audio: ${item.label.substringBefore(" (")}")
            }
        } else if (audioSubActiveColumn == 1 && subCursorIdx in subtitleTracksList.indices) {
            val item = subtitleTracksList[subCursorIdx]
            if (item.isOff) {
                player.trackSelectionParameters = player.trackSelectionParameters
                    .buildUpon()
                    .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
                    .build()
                flashCenterIndicator("Subtitles: Off")
            } else if (item.groupIndex in 0 until tracks.groups.size) {
                val group = tracks.groups[item.groupIndex]
                player.trackSelectionParameters = player.trackSelectionParameters
                    .buildUpon()
                    .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                    .setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, item.trackIndex))
                    .build()
                flashCenterIndicator("Subtitles: ${item.label.substringBefore(" (")}")
            }
        }
        refreshTracks()
        renderAudioSubDrawer()
    }

    private fun startNativeExoPlayer(url: String, title: String, startMs: Long, dedupKey: String, expectedDurationMs: Long = 0L, containerExt: String = "") {
        isPlayingVideo = true
        currentDedupKey = dedupKey
        currentExpectedDurationMs = expectedDurationMs

        if (playerView == null) {
            setupPlayerView()
        }

        playerView?.visibility = View.VISIBLE
        playerView?.requestFocus()
        webView.visibility = View.GONE

        playerTitleView?.text = title

        // Release prior player
        exoPlayer?.stop()
        exoPlayer?.release()
        exoPlayer = null

        showOsd()

        val isMkv = containerExt.equals("mkv", ignoreCase = true) || url.contains(".mkv")
        val isMp4 = containerExt.equals("mp4", ignoreCase = true) || url.contains(".mp4")
        val isHls = containerExt.equals("m3u8", ignoreCase = true) || url.contains(".m3u8")

        // Resolve IPTV 302 redirect on background thread with VLC User-Agent to prevent 509 header loss
        thread {
            var finalPlayUrl = url
            try {
                val client = OkHttpClient.Builder()
                    .followRedirects(false)
                    .connectTimeout(8, TimeUnit.SECONDS)
                    .readTimeout(8, TimeUnit.SECONDS)
                    .build()
                val req = Request.Builder()
                    .url(url)
                    .header("User-Agent", "VLC/3.0.18 LibVLC/3.0.18")
                    .header("Accept", "*/*")
                    .build()
                val resp = client.newCall(req).execute()
                if (resp.isRedirect) {
                    val loc = resp.header("Location")
                    if (!loc.isNullOrBlank()) {
                        finalPlayUrl = loc
                        Log.i("StreamVault", "Resolved 302 redirect directly to media server: $finalPlayUrl")
                    }
                }
                resp.close()
            } catch (e: Exception) {
                Log.w("StreamVault", "Redirect resolution notice: ${e.message}")
            }

            runOnUiThread {
                if (!isPlayingVideo) return@runOnUiThread

                val httpDataSourceFactory = DefaultHttpDataSource.Factory()
                    .setUserAgent("VLC/3.0.18 LibVLC/3.0.18")
                    .setAllowCrossProtocolRedirects(true)
                    .setConnectTimeoutMs(25000)
                    .setReadTimeoutMs(25000)
                    .setDefaultRequestProperties(mapOf(
                        "User-Agent" to "VLC/3.0.18 LibVLC/3.0.18",
                        "Accept" to "*/*"
                    ))

                val extractorsFactory = DefaultExtractorsFactory()
                    .setConstantBitrateSeekingEnabled(true)

                val mediaSourceFactory = DefaultMediaSourceFactory(this, extractorsFactory)
                    .setDataSourceFactory(httpDataSourceFactory)

                val mediaItemBuilder = MediaItem.Builder()
                    .setUri(Uri.parse(finalPlayUrl))

                if (isMkv) {
                    mediaItemBuilder.setMimeType(MimeTypes.APPLICATION_MATROSKA)
                } else if (isMp4) {
                    mediaItemBuilder.setMimeType(MimeTypes.APPLICATION_MP4)
                } else if (isHls) {
                    mediaItemBuilder.setMimeType(MimeTypes.APPLICATION_M3U8)
                }

                val player = ExoPlayer.Builder(this@MainActivity)
                    .setMediaSourceFactory(mediaSourceFactory)
                    .build()

                player.trackSelectionParameters = player.trackSelectionParameters
                    .buildUpon()
                    .setPreferredTextLanguage("en")
                    .setSelectUndeterminedTextLanguage(true)
                    .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                    .build()

                playerView?.player = player
                player.setMediaItem(mediaItemBuilder.build())
                player.addListener(object : Player.Listener {
                    override fun onTracksChanged(tracks: Tracks) {
                        var hasSelectedSub = false
                        var firstSubGroup: Tracks.Group? = null
                        var firstSubTrackIdx = -1

                        for (group in tracks.groups) {
                            if (group.type == C.TRACK_TYPE_TEXT) {
                                for (tIdx in 0 until group.length) {
                                    if (group.isTrackSelected(tIdx)) {
                                        hasSelectedSub = true
                                    }
                                    if (firstSubGroup == null) {
                                        firstSubGroup = group
                                        firstSubTrackIdx = tIdx
                                    }
                                }
                            }
                        }

                        if (!hasSelectedSub && firstSubGroup != null && firstSubTrackIdx >= 0) {
                            player.trackSelectionParameters = player.trackSelectionParameters
                                .buildUpon()
                                .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                                .setOverrideForType(TrackSelectionOverride(firstSubGroup.mediaTrackGroup, firstSubTrackIdx))
                                .build()
                            Log.i("StreamVault", "Auto-selected subtitle track on initial demux")
                        }
                    }

                    override fun onPlaybackStateChanged(playbackState: Int) {
                        if (playbackState == Player.STATE_READY) {
                            updateOsdTime()
                        }
                    }

                    override fun onPlayerError(error: PlaybackException) {
                        Log.e("StreamVault", "Direct Player Error: ${error.message} (Code: ${error.errorCodeName})", error)
                        flashCenterIndicator("Stream unavailable (${error.errorCodeName})")
                    }
                })

                player.prepare()
                if (startMs > 0) player.seekTo(startMs)
                player.playWhenReady = true
                exoPlayer = player

                progressHandler.post(updateProgressRunnable)
            }
        }
    }

    private fun updateOsdTime() {
        val player = exoPlayer ?: return
        val cur = player.currentPosition
        val dur = if (player.duration > 0) player.duration else currentExpectedDurationMs
        playerTimeView?.text = formatTimeMs(cur)
        if (dur > 0) {
            playerDurationView?.text = formatTimeMs(dur)
            val pct = ((cur.toDouble() / dur.toDouble()) * 1000.0).toInt()
            playerProgressBar?.progress = Math.max(0, Math.min(1000, pct))
        }
    }

    private fun isOsdVisible(): Boolean {
        return playerOverlay != null && playerOverlay?.visibility == View.VISIBLE && playerOverlay?.alpha ?: 0f > 0.5f
    }

    private fun showOsd() {
        playerOverlay?.visibility = View.VISIBLE
        playerOverlay?.alpha = 1f
        osdHandler.removeCallbacks(hideOsdRunnable)
        osdHandler.postDelayed(hideOsdRunnable, 3500)
    }

    private fun hideOsdImmediately() {
        osdHandler.removeCallbacks(hideOsdRunnable)
        playerOverlay?.visibility = View.GONE
        playerOverlay?.alpha = 0f
    }

    private fun flashLeftIndicator(text: String) {
        playerLeftIndicator?.text = text
        playerLeftIndicator?.visibility = View.VISIBLE
        hudOverlay?.visibility = View.VISIBLE
        indicatorHandler.removeCallbacks(hideIndicatorRunnable)
        indicatorHandler.postDelayed(hideIndicatorRunnable, 850)
    }

    private fun flashRightIndicator(text: String) {
        playerRightIndicator?.text = text
        playerRightIndicator?.visibility = View.VISIBLE
        hudOverlay?.visibility = View.VISIBLE
        indicatorHandler.removeCallbacks(hideIndicatorRunnable)
        indicatorHandler.postDelayed(hideIndicatorRunnable, 850)
    }

    private fun flashCenterIndicator(text: String) {
        playerCenterIndicator?.text = text
        playerCenterIndicator?.visibility = View.VISIBLE
        hudOverlay?.visibility = View.VISIBLE
        indicatorHandler.removeCallbacks(hideIndicatorRunnable)
        indicatorHandler.postDelayed(hideIndicatorRunnable, 1100)
    }

    private fun togglePlayPause() {
        val player = exoPlayer ?: return
        if (player.isPlaying) {
            player.pause()
            showPausedState()
        } else {
            player.play()
            showPlayingState()
        }
    }

    private fun showPausedState() {
        playerCenterIndicator?.text = "❚❚ Paused"
        playerCenterIndicator?.visibility = View.VISIBLE
        hudOverlay?.visibility = View.VISIBLE
        indicatorHandler.removeCallbacks(hideIndicatorRunnable)
        // Keep timeline visible while paused so user has full progress awareness
        playerOverlay?.visibility = View.VISIBLE
        playerOverlay?.alpha = 1f
        osdHandler.removeCallbacks(hideOsdRunnable)
        updateOsdTime()
    }

    private fun showPlayingState() {
        playerCenterIndicator?.text = "▶ Playing"
        playerCenterIndicator?.visibility = View.VISIBLE
        hudOverlay?.visibility = View.VISIBLE
        indicatorHandler.removeCallbacks(hideIndicatorRunnable)
        indicatorHandler.postDelayed(hideIndicatorRunnable, 800)
        showOsd()
        updateOsdTime()
    }

    private fun formatTimeMs(ms: Long): String {
        val totalSec = Math.max(0L, ms / 1000L)
        val s = totalSec % 60
        val m = (totalSec / 60) % 60
        val h = totalSec / 3600
        return String.format("%02d:%02d:%02d", h, m, s)
    }

    private fun exitNativePlayer() {
        resolveStreamThread?.interrupt()
        resolveStreamThread = null

        val pos = exoPlayer?.currentPosition ?: 0L
        val dur = if ((exoPlayer?.duration ?: 0L) > 0) exoPlayer?.duration ?: 0L else currentExpectedDurationMs

        if (isAudioSubDrawerOpen) {
            closeAudioSubDrawer()
        }

        progressHandler.removeCallbacks(updateProgressRunnable)
        osdHandler.removeCallbacks(hideOsdRunnable)
        indicatorHandler.removeCallbacks(hideIndicatorRunnable)

        exoPlayer?.stop()
        exoPlayer?.release()
        exoPlayer = null
        playerView?.player = null

        playerView?.visibility = View.GONE
        playerOverlay?.visibility = View.GONE
        hudOverlay?.visibility = View.GONE
        webView.visibility = View.VISIBLE
        webView.requestFocus()
        isPlayingVideo = false

        // Inform WebView of watch progress to update "Resume" button & save to server
        val js = "if(window.onPlaybackExited){ window.onPlaybackExited('$currentDedupKey', $pos, $dur); }"
        webView.evaluateJavascript(js, null)
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_DOWN) {
            val keyCode = event.keyCode

            // 1. If native ExoPlayer mode is active (resolving or streaming)
            if (isPlayingVideo) {
                // F3: Back button always exits, even during stream resolution when exoPlayer is still preparing
                if (keyCode == KeyEvent.KEYCODE_BACK) {
                    if (isAudioSubDrawerOpen) {
                        closeAudioSubDrawer()
                        playAcousticTick()
                        return true
                    }
                    if (isOsdVisible()) {
                        hideOsdImmediately()
                    } else {
                        exitNativePlayer()
                    }
                    return true
                }

                // F5: Hardware Media Keys
                when (keyCode) {
                    KeyEvent.KEYCODE_MEDIA_PLAY -> {
                        if (exoPlayer?.isPlaying == false) togglePlayPause()
                        return true
                    }
                    KeyEvent.KEYCODE_MEDIA_PAUSE -> {
                        if (exoPlayer?.isPlaying == true) togglePlayPause()
                        return true
                    }
                    KeyEvent.KEYCODE_MEDIA_STOP -> {
                        exitNativePlayer()
                        return true
                    }
                }

                if (exoPlayer != null) {
                    val player = exoPlayer!!

                    // A. Handle Audio & Subtitles Drawer Navigation
                    if (isAudioSubDrawerOpen) {
                    when (keyCode) {
                        KeyEvent.KEYCODE_DPAD_LEFT -> {
                            audioSubActiveColumn = 0
                            renderAudioSubDrawer()
                            playAcousticTick()
                            return true
                        }
                        KeyEvent.KEYCODE_DPAD_RIGHT -> {
                            audioSubActiveColumn = 1
                            renderAudioSubDrawer()
                            playAcousticTick()
                            return true
                        }
                        KeyEvent.KEYCODE_DPAD_UP -> {
                            if (audioSubActiveColumn == 0) {
                                if (audioCursorIdx > 0) audioCursorIdx--
                            } else {
                                if (subCursorIdx > 0) subCursorIdx--
                            }
                            renderAudioSubDrawer()
                            playAcousticTick()
                            return true
                        }
                        KeyEvent.KEYCODE_DPAD_DOWN -> {
                            if (audioSubActiveColumn == 0) {
                                if (audioCursorIdx < audioTracksList.size - 1) audioCursorIdx++
                            } else {
                                if (subCursorIdx < subtitleTracksList.size - 1) subCursorIdx++
                            }
                            renderAudioSubDrawer()
                            playAcousticTick()
                            return true
                        }
                        KeyEvent.KEYCODE_DPAD_CENTER,
                        KeyEvent.KEYCODE_ENTER -> {
                            applySelectedTrack()
                            playAcousticTick()
                            return true
                        }
                        KeyEvent.KEYCODE_BACK -> {
                            closeAudioSubDrawer()
                            playAcousticTick()
                            return true
                        }
                    }
                    return true
                }

                // B. Standard In-Player Controls
                when (keyCode) {
                    KeyEvent.KEYCODE_DPAD_CENTER,
                    KeyEvent.KEYCODE_ENTER,
                    KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> {
                        togglePlayPause()
                        return true
                    }
                    KeyEvent.KEYCODE_DPAD_RIGHT -> {
                        // Quick forward +10 seconds per industry standard
                        val maxDur = if (player.duration > 0) player.duration else Long.MAX_VALUE
                        val target = Math.min(maxDur, player.currentPosition + 10000L)
                        player.seekTo(target)
                        flashRightIndicator("⟳\n10s")
                        updateOsdTime()
                        showOsd()
                        return true
                    }
                    KeyEvent.KEYCODE_DPAD_LEFT -> {
                        // Quick rewind -10 seconds per industry standard
                        val target = Math.max(0L, player.currentPosition - 10000L)
                        player.seekTo(target)
                        flashLeftIndicator("⟲\n10s")
                        updateOsdTime()
                        showOsd()
                        return true
                    }
                    KeyEvent.KEYCODE_DPAD_UP -> {
                        // Per user request: Open In-Player Quick Audio & Subtitles Drawer
                        openAudioSubDrawer()
                        return true
                    }
                    KeyEvent.KEYCODE_DPAD_DOWN -> {
                        if (isOsdVisible()) {
                            hideOsdImmediately()
                        } else {
                            showOsd()
                        }
                        return true
                    }
                    KeyEvent.KEYCODE_BACK -> {
                        if (isOsdVisible()) {
                            hideOsdImmediately()
                        } else {
                            exitNativePlayer()
                        }
                        return true
                    }
                }
            }
            return true
        }

        // 2. Normal WebView Navigation & Standard App Exit
            when (keyCode) {
                KeyEvent.KEYCODE_DPAD_CENTER,
                KeyEvent.KEYCODE_ENTER -> {
                    if (event.repeatCount == 0) {
                        playAcousticTick()
                        webView.evaluateJavascript(
                            "window.handleTvKeyEvent && window.handleTvKeyEvent('Enter', 13)",
                            null
                        )
                    } else if (event.repeatCount == 5) {
                        playAcousticTick()
                        webView.evaluateJavascript(
                            "window.handleTvKeyLongPress && window.handleTvKeyLongPress('Enter', 13)",
                            null
                        )
                    }
                    return true
                }
                KeyEvent.KEYCODE_DPAD_UP,
                KeyEvent.KEYCODE_DPAD_DOWN,
                KeyEvent.KEYCODE_DPAD_LEFT,
                KeyEvent.KEYCODE_DPAD_RIGHT -> {
                    val jsKey = when (keyCode) {
                        KeyEvent.KEYCODE_DPAD_UP -> "ArrowUp"
                        KeyEvent.KEYCODE_DPAD_DOWN -> "ArrowDown"
                        KeyEvent.KEYCODE_DPAD_LEFT -> "ArrowLeft"
                        KeyEvent.KEYCODE_DPAD_RIGHT -> "ArrowRight"
                        else -> null
                    }
                    if (jsKey != null) {
                        val codeInt = when (jsKey) {
                            "ArrowUp" -> 38
                            "ArrowDown" -> 40
                            "ArrowLeft" -> 37
                            "ArrowRight" -> 39
                            else -> 0
                        }
                        playAcousticTick()
                        webView.evaluateJavascript(
                            "window.handleTvKeyEvent && window.handleTvKeyEvent('$jsKey', $codeInt)",
                            null
                        )
                        return true
                    }
                }
                KeyEvent.KEYCODE_BACK -> {
                    // Check if web app handles back (e.g. modals, search, returning to sidebar)
                    webView.evaluateJavascript(
                        "(function(){ " +
                        "if(window.handleAppBackKey){ return window.handleAppBackKey(); } " +
                        "return false; " +
                        "})()",
                        { result ->
                            if (result != "true") {
                                // User is on Home tab in the sidebar: standard 2-press back with toast
                                val now = System.currentTimeMillis()
                                if (now - lastBackPressTime < 2000L) {
                                    exitToast?.cancel()
                                    finish()
                                } else {
                                    lastBackPressTime = now
                                    exitToast?.cancel()
                                    exitToast = Toast.makeText(this, "Press BACK again to exit", Toast.LENGTH_SHORT)
                                    exitToast?.show()
                                }
                            }
                        }
                    )
                    return true
                }
            }
        }
        return super.dispatchKeyEvent(event)
    }

    override fun onPause() {
        super.onPause()
        if (isPlayingVideo && exoPlayer != null) {
            // F4: Pause playback immediately on background / TV Home
            exoPlayer?.pause()
            val pos = exoPlayer?.currentPosition ?: 0L
            val dur = if ((exoPlayer?.duration ?: 0L) > 0L) exoPlayer!!.duration else currentExpectedDurationMs
            if (pos > 5000L && currentDedupKey.isNotEmpty()) {
                db.savePlaybackProgress(currentDedupKey, pos, dur)
                val js = "if(window.recordPlaybackProgress){ window.recordPlaybackProgress('$currentDedupKey', $pos, $dur); }"
                webView.evaluateJavascript(js, null)
            }
        }
        // Auto-lock adult content on TV standby / background
        prefs.setAdultVaultUnlocked(false)
        val lockJs = "if(window.lockParentalControls){ window.lockParentalControls(); }"
        webView.evaluateJavascript(lockJs, null)
    }

    override fun onStop() {
        super.onStop()
        if (isPlayingVideo && exoPlayer != null) {
            exoPlayer?.pause()
            val pos = exoPlayer?.currentPosition ?: 0L
            val dur = if ((exoPlayer?.duration ?: 0L) > 0L) exoPlayer!!.duration else currentExpectedDurationMs
            if (pos > 5000L && currentDedupKey.isNotEmpty()) {
                db.savePlaybackProgress(currentDedupKey, pos, dur)
                val js = "if(window.recordPlaybackProgress){ window.recordPlaybackProgress('$currentDedupKey', $pos, $dur); }"
                webView.evaluateJavascript(js, null)
            }
        }
    }

    override fun onDestroy() {
        toneGen?.release()
        toneGen = null
        exitToast?.cancel()
        progressHandler.removeCallbacks(updateProgressRunnable)
        osdHandler.removeCallbacks(hideOsdRunnable)
        indicatorHandler.removeCallbacks(hideIndicatorRunnable)
        exoPlayer?.release()
        exoPlayer = null
        playerView?.player = null
        webView.destroy()
        super.onDestroy()
    }
}
