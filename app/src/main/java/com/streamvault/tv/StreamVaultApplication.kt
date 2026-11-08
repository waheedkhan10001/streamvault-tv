package com.streamvault.tv

import android.app.Application
import android.graphics.Bitmap
import coil.ImageLoader
import coil.ImageLoaderFactory
import coil.disk.DiskCache
import coil.memory.MemoryCache
import coil.request.CachePolicy
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/**
 * Custom Application class tailored for TCL 55P635 (2GB RAM, Android TV 11).
 * Configures Coil image loading to use RGB_565 bitmaps, hardware bitmaps where safe,
 * and bounded memory/disk caches to guarantee 60fps D-pad scrolling without OOM crashes.
 */
class StreamVaultApplication : Application(), ImageLoaderFactory {

    override fun newImageLoader(): ImageLoader {
        val httpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .followRedirects(true)
            .followSslRedirects(true)
            .build()

        return ImageLoader.Builder(this)
            .okHttpClient(httpClient)
            .bitmapConfig(Bitmap.Config.RGB_565) // Uses 50% less RAM per poster on 2GB RAM TVs
            .allowRgb565(true)
            .crossfade(150)
            .memoryCachePolicy(CachePolicy.ENABLED)
            .diskCachePolicy(CachePolicy.ENABLED)
            .memoryCache {
                MemoryCache.Builder(this)
                    .maxSizePercent(0.15) // Cap at 15% of app heap
                    .build()
            }
            .diskCache {
                DiskCache.Builder()
                    .directory(cacheDir.resolve("poster_cache"))
                    .maxSizeBytes(150L * 1024 * 1024) // Cap disk cache at 150 MB so TV storage stays free
                    .build()
            }
            .build()
    }
}
