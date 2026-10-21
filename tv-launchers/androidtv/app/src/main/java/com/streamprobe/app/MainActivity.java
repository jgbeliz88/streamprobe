package com.streamprobe.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Thin wrapper: a full-screen WebView that opens StreamProbe from the dev
 * server on the LAN. Same idea as the webOS/Tizen launchers — the app carries
 * no UI of its own, so code changes need no repackaging, and playback happens
 * in the device's real media pipeline (ExoPlayer/MediaCodec behind the WebView).
 */
public class MainActivity extends Activity {

    private WebView web;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        // Keep the screen on: this is a video test harness.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        // Autoplay: without this the WebView blocks playback until a tap, which
        // a TV remote can't easily provide.
        s.setMediaPlaybackRequiresUserGesture(false);
        // The dev server is plain http:// on the LAN.
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        // Ignore the system font scale: on a TV it inflates all the text.
        s.setTextZoom(100);

        // Surface web console output in logcat, so `adb logcat` shows the
        // player's own logs while testing on the device.
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                android.util.Log.d("StreamProbe",
                        m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
                return true;
            }
        });
        // TVs report a high density (a 1080p panel is typically 320dpi, i.e.
        // devicePixelRatio 2), so `width=device-width` gives the page a 960px
        // viewport and the whole UI renders at 2x — huge, with the menus cut off.
        // A phone wants device-width, but on a TV you sit far away and want the
        // desktop layout, so re-point the viewport at the physical pixel width.
        // Mark the UA so the page knows it runs inside the TV wrapper and can size
        // its own viewport (a TV reports density 2, which would otherwise give the
        // page a half-width viewport rendered at 2x). Injecting the meta tag from
        // here doesn't hold: the page's own framework rewrites <head> afterwards.
        s.setUserAgentString(s.getUserAgentString() + " StreamProbeTV/1.0");

        // Android only raises the on-screen keyboard for a real user gesture, so
        // focusing a field from JS is not enough. The page holds its text fields
        // read-only (no keyboard while the D-pad passes over them) and calls in
        // here when the user presses OK on one.
        web.addJavascriptInterface(new KeyboardBridge(), "StreamProbeTV");

        web.setWebViewClient(new WebViewClient());

        web.setBackgroundColor(0xFF0B0E16);
        web.setSystemUiVisibility(View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);

        web.loadUrl(getString(R.string.dev_server_url));
    }

    /** Exposed to the page as `window.StreamProbeTV`. */
    private class KeyboardBridge {
        @android.webkit.JavascriptInterface
        public void showKeyboard() {
            runOnUiThread(() -> {
                InputMethodManager imm =
                        (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
                if (imm == null || web == null) return;
                web.requestFocus();
                // SHOW_IMPLICIT is routinely ignored on Android TV; toggling with
                // SHOW_FORCED reliably brings the (leanback) IME up, and it targets
                // the focused editable inside the WebView.
                boolean shown = imm.showSoftInput(web, InputMethodManager.SHOW_FORCED);
                if (!shown) {
                    imm.toggleSoftInput(InputMethodManager.SHOW_FORCED,
                            InputMethodManager.HIDE_IMPLICIT_ONLY);
                }
                android.util.Log.d("StreamProbe", "showKeyboard() shown=" + shown);
            });
        }

        @android.webkit.JavascriptInterface
        public void hideKeyboard() {
            runOnUiThread(() -> {
                InputMethodManager imm =
                        (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
                if (imm != null && web != null) {
                    imm.hideSoftInputFromWindow(web.getWindowToken(), 0);
                }
            });
        }
    }

    /** Let the remote's Back button navigate the page before leaving the app. */
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && web != null && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
