/**
 * 启动阶段异常的兜底渲染。
 *
 * 原生壳（iOS / 安卓 WKWebView）没有地址栏和 DevTools 入口，bootstrap 抛错时
 * 用户只会看到纯白页面，无法判断是网络、缓存还是存储问题。这里把错误直接画在
 * 页面上并提供重试，同时保留 console 输出供连接 Safari / Chrome 调试。
 */
export function renderBootFailure(error: unknown): void {
  console.error('[mao] 启动失败', error)

  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)

  const container = document.createElement('div')
  container.setAttribute('role', 'alert')
  container.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:100000',
    'display:flex',
    'flex-direction:column',
    'align-items:center',
    'justify-content:center',
    'gap:16px',
    'padding:32px',
    'box-sizing:border-box',
    'background:#f5f5f7',
    'color:#1d1d1f',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
    'text-align:center',
  ].join(';')

  const title = document.createElement('h1')
  title.textContent = '加载失败'
  title.style.cssText = 'margin:0;font-size:20px;font-weight:600'

  const hint = document.createElement('p')
  hint.textContent = '网络异常、版本刚更新或本地存储不可用都可能导致启动失败，请重试。'
  hint.style.cssText = 'margin:0;max-width:420px;font-size:14px;line-height:1.6;color:#6e6e73'

  const detail = document.createElement('pre')
  detail.textContent = message
  detail.style.cssText = [
    'margin:0',
    'max-width:520px',
    'max-height:180px',
    'overflow:auto',
    'padding:12px',
    'border-radius:8px',
    'background:#ffffff',
    'color:#b3261e',
    'font-size:12px',
    'text-align:left',
    'white-space:pre-wrap',
    'word-break:break-all',
  ].join(';')

  const retry = document.createElement('button')
  retry.type = 'button'
  retry.textContent = '重新加载'
  retry.style.cssText = [
    'min-width:128px',
    'min-height:40px',
    'padding:0 20px',
    'border:0',
    'border-radius:10px',
    'background:#0066cc',
    'color:#ffffff',
    'font-size:15px',
    'cursor:pointer',
  ].join(';')
  retry.addEventListener('click', () => window.location.reload())

  container.append(title, hint, detail, retry)

  document.getElementById('splash')?.remove()
  const app = document.getElementById('app')
  if (app) {
    app.replaceChildren(container)
  } else {
    document.body.appendChild(container)
  }
}