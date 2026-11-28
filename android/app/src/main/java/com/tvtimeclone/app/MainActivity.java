package com.tvtimeclone.app;

import android.os.Bundle;
import android.webkit.CookieManager;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugin (daily background episode check) - must be registered before
        // super.onCreate() creates the bridge.
        registerPlugin(WatchlogBackgroundPlugin.class);
        super.onCreate(savedInstanceState);
        // The bot check before email codes (Cloudflare Turnstile) runs in a frame from
        // watchlogtracker.com (public/turnstile.html), which is third-party to the app's
        // https://localhost pages; Cloudflare asks for third-party cookies in Android WebViews.
        CookieManager.getInstance().setAcceptThirdPartyCookies(getBridge().getWebView(), true);
    }

    // Capacitor's Bridge doesn't wire the hardware/gesture back button to WebView history by
    // default — without this override, Android's default behavior just closes the Activity.
    // The app is a real multi-page site (no SPA router), so WebView back-history is exactly
    // "the previous page", matching what the in-app back arrows already do.
    @Override
    public void onBackPressed() {
        if (getBridge().getWebView().canGoBack()) {
            getBridge().getWebView().goBack();
        } else {
            super.onBackPressed();
        }
    }
}
