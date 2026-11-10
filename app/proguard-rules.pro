# WebView JavaScript Interface
-keepattributes JavascriptInterface
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# StreamVault TV Application code & data models
-keep class com.streamvault.tv.** { *; }
-keepclassmembers class com.streamvault.tv.** { *; }

# OkHttp & Okio warnings
-dontwarn okhttp3.**
-dontwarn okio.**

# Media3 / ExoPlayer
-keep class androidx.media3.** { *; }
-dontwarn androidx.media3.**

# ZXing Core
-keep class com.google.zxing.** { *; }
-dontwarn com.google.zxing.**
