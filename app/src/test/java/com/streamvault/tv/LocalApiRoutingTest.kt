package com.streamvault.tv

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Plain JVM test (no Android needed): which page requests are answered on the TV vs sent to the internet. */
class LocalApiRoutingTest {

    @Test
    fun cloudWorkerCallsAreNotIntercepted() {
        val base = "https://streamvault-sync.streamvault-app.workers.dev"
        assertFalse(isLocalApiRequest("https", "$base/api/auth/request-code"))
        assertFalse(isLocalApiRequest("https", "$base/api/auth/signup"))
        assertFalse(isLocalApiRequest("https", "$base/api/auth/login"))
        assertFalse(isLocalApiRequest("https", "$base/api/auth/poll-code?code=SV-AB12"))
        assertFalse(isLocalApiRequest("https", "$base/api/sync/push"))
        assertFalse(isLocalApiRequest("https", "$base/api/tmdb/search?q=matrix"))
    }

    @Test
    fun plainHttpAndOtherSchemesAreNotIntercepted() {
        assertFalse(isLocalApiRequest("http", "http://iptv.example.com:8080/api/anything"))
        assertFalse(isLocalApiRequest(null, "/api/state"))
    }

    @Test
    fun localPageRequestsAreStillAnsweredOnTheTv() {
        assertTrue(isLocalApiRequest("file", "file:///api/state"))
        assertTrue(isLocalApiRequest("FILE", "file:///api/playlists?x=1"))
    }

    @Test
    fun localPageNonApiRequestsAreNotIntercepted() {
        assertFalse(isLocalApiRequest("file", "file:///android_asset/tv-ui.html"))
    }
}
