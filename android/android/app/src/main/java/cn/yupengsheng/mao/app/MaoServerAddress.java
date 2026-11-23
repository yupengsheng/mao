package cn.yupengsheng.mao.app;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;

import com.getcapacitor.CapConfig;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 服务器地址：存储、规范化、连通性校验，以及用「覆盖了 server.url 的 CapConfig」启动 Capacitor。
 *
 * 为什么不用打包时的固定地址：这个壳是远程加载的 WebView，登录页本身也由远端提供，所以地址只能
 * 在原生侧、WebView 加载前确定。默认值仍是 https://mao.yupengsheng.cn，用户可改成自建实例。
 *
 * 只接受 https（不放开明文流量）；进入前请求一次 /api/v1/health，地址写错当场报错而不是白屏。
 */
final class MaoServerAddress {
    /** 未配置时使用的默认服务器 */
    static final String DEFAULT_URL = "https://mao.yupengsheng.cn";
    private static final String PREFS = "mao_server";
    private static final String KEY_URL = "server_url";
    private static final int HEALTH_TIMEOUT_MS = 5_000;

    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final ExecutorService IO = Executors.newSingleThreadExecutor();

    private MaoServerAddress() {}

    /** 已保存的地址；未配置（首次启动）返回 null */
    static String get(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String url = prefs.getString(KEY_URL, null);
        return url == null || url.isEmpty() ? null : url;
    }

    static void save(Context context, String url) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_URL, url).apply();
    }

    /**
     * 规范化用户输入：缺协议自动补 https，去掉尾部 / 与查询串；非 https、无主机、带账号信息、
     * 带路径一律判非法。
     *
     * <p>只接受 origin（scheme + host + port）：Capacitor 把 server.url 同时当作 appUrl 与允许来源，
     * 带路径时路由和 /api 前缀都会跟着变形，很难保证正确，不如让用户填根地址。
     *
     * @return 可用的地址；非法返回 null
     */
    static String normalize(String raw) {
        if (raw == null) return null;
        String input = raw.trim();
        if (input.isEmpty()) return null;
        if (!input.contains("://")) input = "https://" + input;
        Uri uri = Uri.parse(input);
        String scheme = uri.getScheme();
        if (scheme == null || !scheme.equalsIgnoreCase("https")) return null;
        String host = uri.getHost();
        if (host == null || host.isEmpty()) return null;
        // 带 user:pass@ 的地址既不该出现在这里，也会让 WebView 的 origin 判定出错
        if (uri.getUserInfo() != null) return null;
        int port = uri.getPort();
        String path = uri.getPath() == null ? "" : uri.getPath();
        while (path.endsWith("/")) path = path.substring(0, path.length() - 1);
        if (!path.isEmpty()) return null;
        return "https://" + host.toLowerCase() + (port == -1 ? "" : ":" + port);
    }

    /** 探活回调：true = 该地址确实是一台 Mao 服务端 */
    interface Result {
        void onResult(boolean ok);
    }

    /**
     * 请求 <url>/api/v1/health，2xx 且响应体 code=0 才视为可用（后端返回 Result{code:0,...}）；
     * 网络异常/超时/不是 Mao 服务端一律失败。回调在主线程。
     */
    static void validate(String url, Result callback) {
        IO.execute(() -> {
            boolean ok = false;
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(url + "/api/v1/health").openConnection();
                connection.setConnectTimeout(HEALTH_TIMEOUT_MS);
                connection.setReadTimeout(HEALTH_TIMEOUT_MS);
                connection.setRequestMethod("GET");
                connection.setInstanceFollowRedirects(true);
                connection.setUseCaches(false);
                connection.setRequestProperty("Accept", "application/json");
                connection.setRequestProperty("Cache-Control", "no-cache");
                int status = connection.getResponseCode();
                if (status >= 200 && status < 300) {
                    ok = isMaoHealth(readBody(connection.getInputStream()));
                }
            } catch (Exception ignored) {
                // 域名解析失败、证书不匹配、超时都按不可用处理
            } finally {
                if (connection != null) connection.disconnect();
            }
            final boolean result = ok;
            MAIN.post(() -> callback.onResult(result));
        });
    }

    /** 只有后端统一 Result 包装且 code==0 才算真服务端，避免把任意静态站点当成服务器。 */
    private static boolean isMaoHealth(String body) {
        try {
            return new JSONObject(body).optInt("code", -1) == 0;
        } catch (Exception e) {
            return false;
        }
    }

    /** 用 UTF-8 流式读响应体；上限 64KB，避免把静态站点整页读进来。 */
    private static String readBody(InputStream input) throws IOException {
        StringBuilder text = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            char[] buffer = new char[4096];
            int read;
            while ((read = reader.read(buffer)) > 0 && text.length() < 64 * 1024) {
                text.append(buffer, 0, read);
            }
        }
        return text.toString();
    }

    /**
     * 用打包的 capacitor.config.json 复制一份配置，只把 server.url 换成用户选的地址。
     *
     * Bridge 从 CapConfig 读 server.url 作为初始加载地址与允许来源；直接改 assets 里的文件不现实
     * （只读），所以走 CapConfig 的 JSON 构造函数。
     */
    @SuppressWarnings("deprecation")
    static CapConfig buildConfig(Activity activity, String serverUrl) {
        try (InputStream input = activity.getAssets().open("capacitor.config.json");
             BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            StringBuilder text = new StringBuilder();
            char[] buffer = new char[4096];
            int read;
            while ((read = reader.read(buffer)) > 0) {
                text.append(buffer, 0, read);
            }
            JSONObject json = new JSONObject(text.toString());
            JSONObject server = json.optJSONObject("server");
            if (server == null) {
                server = new JSONObject();
                json.put("server", server);
            }
            server.put("url", serverUrl);
            // CapConfig 的 JSON 构造走的是 isDebug=false 分支，调试包要显式打开 WebView 远程检查
            if (BuildConfig.DEBUG) {
                JSONObject android = json.optJSONObject("android");
                if (android == null) {
                    android = new JSONObject();
                    json.put("android", android);
                }
                if (!android.has("webContentsDebuggingEnabled")) {
                    android.put("webContentsDebuggingEnabled", true);
                }
            }
            return new CapConfig(activity.getAssets(), json);
        } catch (Exception e) {
            // 配置读不出来时退回打包默认值，至少还能用官方地址
            return CapConfig.loadDefault(activity);
        }
    }
}