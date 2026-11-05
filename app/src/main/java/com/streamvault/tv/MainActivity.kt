package com.streamvault.tv

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.speech.RecognizerIntent
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.lifecycleScope
import com.streamvault.tv.data.CatalogSyncEngine
import com.streamvault.tv.data.PreferencesManager
import com.streamvault.tv.data.StreamVaultDatabase
import com.streamvault.tv.data.SubtitleService
import com.streamvault.tv.server.PhoneCompanionServer
import com.streamvault.tv.ui.StreamVaultTvApp

class MainActivity : ComponentActivity() {

    private lateinit var db: StreamVaultDatabase
    private lateinit var prefs: PreferencesManager
    private lateinit var syncEngine: CatalogSyncEngine
    private lateinit var subtitleService: SubtitleService
    private lateinit var companionServer: PhoneCompanionServer

    private var pendingVoiceCallback: ((String) -> Unit)? = null

    private val voiceSearchLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            val matches = result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
            val spoken = matches?.firstOrNull()
            if (!spoken.isNullOrBlank()) {
                pendingVoiceCallback?.invoke(spoken)
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        db = StreamVaultDatabase.getInstance(this)
        prefs = PreferencesManager(this)
        syncEngine = CatalogSyncEngine(db, prefs, lifecycleScope)
        subtitleService = SubtitleService(this)

        companionServer = PhoneCompanionServer(
            prefs = prefs,
            db = db,
            onCredentialsSaved = {
                syncEngine.triggerSync(isManual = true)
            },
            onRemoteSearchReceived = { query ->
                prefs.pushRemoteSearchFromPhone(query)
            }
        )
        companionServer.start()

        setContent {
            StreamVaultTvApp(
                db = db,
                prefs = prefs,
                syncEngine = syncEngine,
                subtitleService = subtitleService,
                companionServer = companionServer,
                onLaunchVoiceSearch = { callback ->
                    pendingVoiceCallback = callback
                    runCatching {
                        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                            putExtra(
                                RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                                RecognizerIntent.LANGUAGE_MODEL_FREE_FORM
                            )
                            putExtra(RecognizerIntent.EXTRA_PROMPT, "Speak Movie, Actor, Director, or Genre...")
                        }
                        voiceSearchLauncher.launch(intent)
                    }
                }
            )
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        if (::companionServer.isInitialized) {
            companionServer.stop()
        }
    }
}
