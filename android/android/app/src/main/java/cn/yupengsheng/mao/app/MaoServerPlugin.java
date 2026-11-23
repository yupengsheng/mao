package cn.yupengsheng.mao.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 服务器地址插件（与 iOS MaoServerPlugin 同名同接口）：
 * - get()  返回当前服务器地址与是否已配置
 * - open() 弹出原生地址输入框；保存后壳会用新地址重建 WebView
 *
 * 为什么由 Web 触发：远程页面自己不知道壳里配的是哪台服务器，登录页展示地址、提供「更换」
 * 入口都得问原生；改地址会整壳重建，只能由原生完成。
 */
@CapacitorPlugin(name = "MaoServer")
public class MaoServerPlugin extends Plugin {

    @PluginMethod
    public void get(PluginCall call) {
        String saved = MaoServerAddress.get(getContext());
        JSObject result = new JSObject();
        result.put("url", saved != null ? saved : MaoServerAddress.DEFAULT_URL);
        result.put("configured", saved != null);
        call.resolve(result);
    }

    @PluginMethod
    public void open(PluginCall call) {
        if (!(getActivity() instanceof MainActivity)) {
            call.reject("当前环境不支持修改服务器地址");
            return;
        }
        MainActivity activity = (MainActivity) getActivity();
        activity.runOnUiThread(() -> activity.promptServerChange(() -> call.resolve()));
    }
}