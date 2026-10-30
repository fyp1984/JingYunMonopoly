package com.sevensmile.jingyunmonopoly;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.pm.ActivityInfo;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.Display;
import android.view.Surface;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URLConnection;
import java.util.HashMap;
import java.util.Map;

/**
 * 京韵大富翁 · 胡同漫游记 —— 触屏终端本地外壳。
 *
 * 三件事：
 *   ① 把 APK 内置的 assets 通过一个「本地虚拟域名」暴露给 WebView，
 *      让页面拿到 https 源，从而使原生 ES Module 与 fetch 正常工作。
 *      这样游戏完全离线运行，不依赖终端上的浏览器，也不依赖网络。
 *   ② 通过 window.JYMNative 暴露一个极简键值读写，把前端的存档 / 设置
 *      额外镜像一份到 App 私有目录（WebView 的 localStorage 在清数据 /
 *      换包时可能丢，私有目录里的副本用来兜底）。
 *      Web 版没有这个桥，前端 store.js 会自动降级为只用 localStorage。
 *   ③ 把屏幕姿态恒定钉在 180°（见 FIXED_ORIENTATION），避免画面相对机身颠倒 ——
 *      本机 DC-JAV-FLIP 的面板由厂商按 180° 补偿安装，姿态必须固定，不能听传感器。
 */
public class MainActivity extends Activity {

    /** 本地虚拟域名：请求不会真的出网，全部由 shouldInterceptRequest 就地应答。 */
    private static final String BASE_URL = "https://appassets.androidplatform.net/";

    /** JS 侧看到的桥名，必须与 public/src/ui/store.js 里的 window.JYMNative 一致。 */
    private static final String NATIVE_BRIDGE = "JYMNative";

    private static final String TAG = "JYM";

    /**
     * 屏幕姿态：恒定 180°（REVERSE_LANDSCAPE) —— 本机 DC-JAV-FLIP 专用，勿随意改。
     *
     * 厂商固件把面板按「自然横向 + 180° 补偿」安装：
     *   persist.fanc.cus.default.rotation=0 / persist.fanc.cus.offset.rotation=2
     * 故整机正确姿态恒为 ROTATION_180，系统桌面就停在这个角度。
     * 必须与 AndroidManifest.xml 里 android:screenOrientation="reverseLandscape" 保持一致。
     */
    private static final int FIXED_ORIENTATION = ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE;

    private WebView webView;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        applyFixedOrientation();

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // 调试辅助：允许通过 adb（localabstract:webview_devtools_remote_<pid>）
        // 连上真机 WebView 的 DevTools，用于在不同分辨率设备上核对排版与字号。
        // 仅对 debug 包有意义，不影响发布包的正常使用。
        WebView.setWebContentsDebuggingEnabled(true);

        webView = new WebView(this);
        webView.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        webView.setBackgroundColor(Color.BLACK);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);

        // 关键：Android WebView 的「最小字号」默认值就是 8px，凡是 CSS 里小于 8px 的
        // 字号（棋盘内文字按 --u 等比缩放，整机大屏上只有约 5.16px）都会被强行顶到 8px，
        // 于是格子/中心区装不下 → 布局错乱。棋盘内文字必须能小于 8px，故把地板降到 1px，
        // 并锁定 textZoom=100 防止系统字体缩放叠加。这样排版就完全由 CSS 的等比变量决定。
        settings.setMinimumFontSize(1);
        settings.setMinimumLogicalFontSize(1);
        settings.setTextZoom(100);

        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return serveFromAssets(request.getUrl());
            }
        });

        setContentView(webView);

        // 存档 / 设置的原生镜像（Web 版没有这一段，前端自动降级）。
        webView.addJavascriptInterface(new NativeStore(getFilesDir()), NATIVE_BRIDGE);

        if (savedInstanceState == null) {
            webView.loadUrl(BASE_URL + "index.html");
        } else {
            webView.restoreState(savedInstanceState);
        }
    }

    /**
     * 姿态自检：每次启动 / 回到前台都执行一次 —— 无论系统此刻处在哪个旋转角，
     * 一律强制回到 {@link #FIXED_ORIENTATION}（180°），保证「每次都检测、绝不带颠倒上屏」。
     *
     * 之所以还要在这里再压一次：清单里的 screenOrientation 只在 Activity 启动时生效，
     * 若运行期间被其它因素（传感器、分屏、外部控制）改动过姿态，回前台时这里会把姿态纠回来。
     */
    private void applyFixedOrientation() {
        Display display = getWindowManager().getDefaultDisplay();
        int current = display != null ? display.getRotation() : -1;
        if (getRequestedOrientation() != FIXED_ORIENTATION) {
            setRequestedOrientation(FIXED_ORIENTATION);
        }
        if (current != Surface.ROTATION_180) {
            // 留一条日志，便于日后在 adb logcat 里核对是否发生过姿态漂移。
            Log.i(TAG, "强制屏幕姿态 180°，当前系统姿态=" + current);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        applyFixedOrientation();
    }

    /**
     * 极简键值镜像：一个键 = 私有目录下的一个小文件。
     *
     * 只服务前端的存档 / 设置（体积都是几 KB），所以同步读写即可；
     * 任何异常一律吞掉 —— 镜像失败绝不能影响棋局本身。
     */
    public static class NativeStore {

        private final File dir;

        NativeStore(File base) {
            this.dir = new File(base, "jym-kv");
        }

        @JavascriptInterface
        public String read(String key) {
            File f = fileFor(key);
            if (f == null || !f.isFile()) return null;
            try (InputStream in = new FileInputStream(f)) {
                StringBuilder sb = new StringBuilder();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) sb.append(new String(buf, 0, n, "UTF-8"));
                return sb.toString();
            } catch (IOException e) {
                return null;
            }
        }

        @JavascriptInterface
        public void write(String key, String value) {
            File f = fileFor(key);
            if (f == null) return;
            try (OutputStream out = new FileOutputStream(f)) {
                out.write(String.valueOf(value).getBytes("UTF-8"));
            } catch (IOException e) {
                // 丢弃：镜像写失败不影响内存里的棋局
            }
        }

        @JavascriptInterface
        public void remove(String key) {
            File f = fileFor(key);
            if (f != null && f.isFile()) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
        }

        /** 键名只允许 [A-Za-z0-9._-]（与前端用法一致），映射成同名文件；非法键一律忽略。 */
        private File fileFor(String key) {
            if (key == null || key.isEmpty() || key.length() > 64) return null;
            if (key.equals(".") || key.equals("..")) return null;
            for (int i = 0; i < key.length(); i++) {
                char c = key.charAt(i);
                boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                        || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
                if (!ok) return null;
            }
            if (!dir.isDirectory() && !dir.mkdirs()) return null;
            return new File(dir, key);
        }
    }

    /** 把虚拟域名下的请求映射到 APK 内的 assets 目录；非本地域名的请求交给系统处理。 */
    private WebResourceResponse serveFromAssets(Uri uri) {
        if (uri == null || !BASE_URL.startsWith(uri.getScheme() + "://" + uri.getHost() + "/")) {
            return null;
        }
        String path = uri.getPath();
        if (path == null) {
            return null;
        }
        if (path.startsWith("/")) {
            path = path.substring(1);
        }
        if (path.isEmpty()) {
            path = "index.html";
        }
        if (path.contains("..")) {
            return notFound();
        }
        try {
            InputStream in = getAssets().open(path);
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-cache");
            return new WebResourceResponse(guessMime(path), "UTF-8", 200, "OK", headers, in);
        } catch (IOException e) {
            return notFound();
        }
    }

    private WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found",
                new HashMap<String, String>(), null);
    }

    /** WebView 对 ES Module 的 MIME 校验很严格，.js 必须回 text/javascript。 */
    private String guessMime(String path) {
        String lower = path.toLowerCase();
        if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "text/javascript";
        if (lower.endsWith(".css")) return "text/css";
        if (lower.endsWith(".json")) return "application/json";
        if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".gif")) return "image/gif";
        if (lower.endsWith(".woff2")) return "font/woff2";
        if (lower.endsWith(".woff")) return "font/woff";
        if (lower.endsWith(".ttf")) return "font/ttf";
        String guessed = URLConnection.guessContentTypeFromName(path);
        return guessed != null ? guessed : "application/octet-stream";
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
