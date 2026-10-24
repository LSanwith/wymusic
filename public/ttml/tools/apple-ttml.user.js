// ==UserScript==
// @name         Apple Music TTML 提取
// @namespace    https://www.sanwith.cc.cd/ttml/
// @version      1.0.0
// @description  从 Apple Music 网页播放器自动提取逐字 TTML 歌词，一首一个 .ttml 文件，只存 TTML 本体
// @author       Sanwith
// @match        https://music.apple.com/*
// @match        https://beta.music.apple.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

/**
 * 工作原理
 *
 * Apple Music 网页播放器在拿到歌词时，会把逐字 TTML 放在响应里
 * （通常是 amp-api 的 /lyrics 接口，字段叫 ttml 或 ttmlLocalizations，
 *  后者是一个「装着整份 TTML 的 JSON 字符串」）。
 *
 * 这个脚本在页面启动前接管 fetch / XMLHttpRequest，把每个响应都扫一遍，
 * 一旦发现 TTML 就解出来存成 <歌曲id>.ttml。所以只要正常听歌、或者
 * 点开某首歌，歌词就会自动落到你的下载目录里。
 *
 * 只保存 TTML 本体：翻译、音译、歌手、封面这些都不单独导出
 * （它们本来就写在 TTML 里，属于 TTML 的一部分）。
 *
 * 提取 Apple 的歌词受 Apple 的服务条款约束，自己听歌用没问题，别拿去分发。
 */
;(function () {
  'use strict'

  const TAG = '[TTML]'
  const saved = new Set() // 已保存的内容指纹，避免同一份反复下载
  let enabled = true
  let count = 0

  // ---------- 提取核心 ----------

  /** 把 JSON 里被转义过的字符串还原 */
  function unescapeJsonString(s) {
    try {
      return JSON.parse('"' + s + '"')
    } catch {
      return s
    }
  }

  /**
   * 从任意文本里找出所有 TTML。
   * 兼容两种形态：
   *   1. 页面里直接内联的 XML：<tt ...>...</tt>
   *   2. JSON 字段里被转义的："ttml":"<tt ...>" / "ttmlLocalizations":"<tt ...>"
   */
  function extractTtml(text) {
    if (!text || typeof text !== 'string') return []
    const found = []

    // 先处理 JSON 里被转义的，并把命中的片段从原文里挖掉。
    // 否则同一份 TTML 会被下面的「内联 XML」再抓一次，
    // 而且抓到的是带 \\" 的转义版 —— 存下来就是坏文件。
    let rest = text
    const re = /"(?:ttml|ttmlLocalizations)"\s*:\s*"((?:[^"\\]|\\.)*)"/g
    let m
    while ((m = re.exec(text))) {
      const raw = unescapeJsonString(m[1])
      if (typeof raw !== 'string' || raw.indexOf('<tt') < 0) continue
      for (const x of raw.matchAll(/<tt\b[\s\S]*?<\/tt>/g)) found.push(x[0])
      rest = rest.split(m[0]).join(' ')
    }

    // 再扫剩下的内联 XML（页面里直接写着的）
    for (const x of rest.matchAll(/<tt\b[\s\S]*?<\/tt>/g)) found.push(x[0])

    // 去重 + 只保留看起来完整的
    const seen = new Set()
    return found.filter((x) => {
      const key = x.slice(0, 200) + '|' + x.length
      if (seen.has(key)) return false
      seen.add(key)
      return x.indexOf('<tt') === 0 && x.indexOf('</tt>') > 0
    })
  }

  /** 从文本里猜歌曲 id（Apple 的数字 id） */
  function guessSongId(text, url) {
    let m = /"id"\s*:\s*"(\d{6,})"/.exec(text || '')
    if (m) return m[1]
    if (url) {
      m = /[?&]i=(\d{6,})/.exec(url)
      if (m) return m[1]
      m = /\/song\/[^/]+\/(\d{6,})/.exec(url)
      if (m) return m[1]
      m = /\/(\d{6,})(?:[/?]|$)/.exec(url)
      if (m) return m[1]
    }
    return ''
  }

  /** 简单指纹，用来判定「这份已经存过了」 */
  function fingerprint(s) {
    let h = 5381
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
    return h + ':' + s.length
  }

  // ---------- 保存 ----------

  function saveOne(ttml, songId, source) {
    const fp = fingerprint(ttml)
    if (saved.has(fp)) return false
    saved.add(fp)

    const id = songId || 'unknown-' + Date.now()
    let name = id + '.ttml'
    // 同一首歌有多份（不同语言版本）时，别互相覆盖
    let n = 1
    while (names.has(name)) name = id + '-' + ++n + '.ttml'
    names.add(name)

    const blob = new Blob([ttml], { type: 'application/ttml+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.style.display = 'none'
    document.documentElement.appendChild(a)
    a.click()
    setTimeout(() => {
      URL.revokeObjectURL(url)
      a.remove()
    }, 4000)

    count++
    log('已保存 ' + name + '（' + (ttml.length / 1024).toFixed(1) + ' KB，来自 ' + source + '）', 'ok')
    return true
  }

  const names = new Set()

  /** 扫描一段文本，存下其中所有 TTML */
  function harvest(text, url) {
    if (!enabled) return 0
    const list = extractTtml(text)
    if (!list.length) return 0
    const songId = guessSongId(text, url || location.href)
    let n = 0
    for (const t of list) if (saveOne(t, songId, url ? '接口' : '页面')) n++
    return n
  }

  // ---------- 拦截 fetch ----------
  const origFetch = window.fetch
  if (origFetch) {
    window.fetch = function () {
      const args = arguments
      const p = origFetch.apply(this, args)
      p.then((res) => {
        try {
          const ct = (res.headers && res.headers.get('content-type')) || ''
          if (!/json|text|xml|javascript/i.test(ct)) return
          res
            .clone()
            .text()
            .then((body) => {
              const u = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || ''
              harvest(body, u)
            })
            .catch(() => {})
        } catch (e) {
          /* 忽略 */
        }
      }).catch(() => {})
      return p
    }
  }

  // ---------- 拦截 XHR ----------
  const XHR = window.XMLHttpRequest
  if (XHR) {
    const origOpen = XHR.prototype.open
    const origSend = XHR.prototype.send
    XHR.prototype.open = function (method, url) {
      this.__ttmlUrl = url
      return origOpen.apply(this, arguments)
    }
    XHR.prototype.send = function () {
      this.addEventListener('load', () => {
        try {
          const t = this.responseType
          if (t && t !== 'text' && t !== 'json') return
          const body = t === 'json' ? JSON.stringify(this.response) : this.responseText
          harvest(body, this.__ttmlUrl)
        } catch (e) {
          /* 忽略 */
        }
      })
      return origSend.apply(this, arguments)
    }
  }

  // ---------- 扫描页面内联数据 ----------
  function scanPage() {
    let n = 0
    // 页面里内联的 JSON（Apple 的 serialized-server-data 就在这里）
    document.querySelectorAll('script[type="application/json"], script[id], script').forEach((s) => {
      const t = s.textContent
      if (t && t.length > 200 && t.indexOf('tt') >= 0) n += harvest(t, '')
    })
    // 兜底：整页 HTML 里的 TTML
    if (!n) n += harvest(document.documentElement.innerHTML, '')
    log(n ? '扫到 ' + n + ' 份 TTML' : '当前页面没找到 TTML（试试播放这首歌，或点开歌词）', n ? 'ok' : '')
    return n
  }

  // ---------- 批量：按 Apple 歌曲 id 取 ----------
  async function fetchByIds(ids) {
    const list = ids
      .split(/[\s,，、]+/)
      .map((s) => s.trim())
      .filter((s) => /^\d{6,}$/.test(s))
    if (!list.length) {
      log('没识别到合法的歌曲 id（应该是 6 位以上的纯数字）')
      return
    }
    log('批量取 ' + list.length + ' 首…')
    for (const id of list) {
      // Apple 网页播放器用的就是这个接口，带上 cookie 就有权限
      const urls = [
        'https://amp-api.music.apple.com/v1/catalog/cn/songs/' +
          id +
          '/lyrics?l=zh-Hans-CN&extend=ttmlLocalizations&format=json',
        'https://amp-api.music.apple.com/v1/catalog/cn/songs/' + id + '?extend=lyrics',
      ]
      let got = false
      for (const u of urls) {
        try {
          const r = await origFetch(u, {
            credentials: 'include',
            headers: { Origin: 'https://music.apple.com', Referer: 'https://music.apple.com/' },
          })
          if (!r.ok) continue
          const body = await r.text()
          if (harvest(body, u)) got = true
        } catch (e) {
          /* 试下一个 */
        }
      }
      if (!got) log('id ' + id + ' 没取到（可能没这首歌、没权限，或者接口变了）', 'warn')
      await new Promise((r) => setTimeout(r, 400))
    }
    log('批量结束，本次共保存 ' + count + ' 份')
  }

  // ---------- 界面 ----------
  let box, logBox

  function log(msg, kind) {
    console.log(TAG, msg)
    if (!logBox) return
    const d = document.createElement('div')
    d.className = 'ttml-line' + (kind ? ' ttml-' + kind : '')
    d.textContent = msg
    logBox.appendChild(d)
    logBox.scrollTop = logBox.scrollHeight
  }

  function buildUI() {
    if (document.getElementById('ttml-tool')) return
    box = document.createElement('div')
    box.id = 'ttml-tool'
    box.innerHTML =
      '<div class="ttml-head">' +
      '<span>Apple Music → TTML</span>' +
      '<button type="button" class="ttml-min">–</button>' +
      '</div>' +
      '<div class="ttml-body">' +
      '<div class="ttml-row">' +
      '<button type="button" class="ttml-btn" data-act="scan">扫当前页</button>' +
      '<button type="button" class="ttml-btn" data-act="batch">按 id 批量</button>' +
      '<button type="button" class="ttml-btn" data-act="toggle">自动拦截：开</button>' +
      '</div>' +
      '<div class="ttml-log"></div>' +
      '<div class="ttml-tip">播放一首歌 / 打开歌曲页，TTML 会自动存成 .ttml</div>' +
      '</div>'

    const css = document.createElement('style')
    css.textContent = `
      #ttml-tool{position:fixed;right:16px;bottom:16px;width:320px;z-index:2147483647;
        background:#1c1c1e;color:#f2f2f7;border:1px solid #3a3a3c;border-radius:12px;
        font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        box-shadow:0 8px 28px rgba(0,0,0,.45);overflow:hidden}
      #ttml-tool.min .ttml-body{display:none}
      #ttml-tool .ttml-head{display:flex;justify-content:space-between;align-items:center;
        padding:8px 10px;background:#2c2c2e;font-weight:600}
      #ttml-tool .ttml-min{background:none;border:0;color:#f2f2f7;font-size:14px;cursor:pointer;padding:0 4px}
      #ttml-tool .ttml-body{padding:10px}
      #ttml-tool .ttml-row{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}
      #ttml-tool .ttml-btn{flex:1 1 auto;padding:6px 8px;border-radius:8px;cursor:pointer;
        background:#3a3a3c;border:1px solid #48484a;color:#f2f2f7;font-size:12px}
      #ttml-tool .ttml-btn:hover{background:#48484a}
      #ttml-tool .ttml-log{max-height:150px;overflow:auto;background:#000;
        border-radius:8px;padding:6px 8px;font-family:ui-monospace,Consolas,monospace;font-size:11px}
      #ttml-tool .ttml-line{white-space:pre-wrap;word-break:break-all;color:#9a9aa0;padding:1px 0}
      #ttml-tool .ttml-ok{color:#7ee2a8}
      #ttml-tool .ttml-warn{color:#ffd479}
      #ttml-tool .ttml-tip{margin-top:8px;color:#8e8e93;font-size:11px}
    `
    document.documentElement.appendChild(css)
    document.documentElement.appendChild(box)
    logBox = box.querySelector('.ttml-log')

    box.querySelector('.ttml-min').addEventListener('click', () => box.classList.toggle('min'))
    box.querySelector('.ttml-body').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]')
      if (!b) return
      const act = b.getAttribute('data-act')
      if (act === 'scan') scanPage()
      if (act === 'batch') {
        const input = prompt('粘贴 Apple Music 歌曲 id（多个用逗号或空格分隔）')
        if (input) fetchByIds(input)
      }
      if (act === 'toggle') {
        enabled = !enabled
        b.textContent = '自动拦截：' + (enabled ? '开' : '关')
        log('自动拦截已' + (enabled ? '开启' : '关闭'))
      }
    })
    log('就绪。播放或打开一首歌，TTML 会自动保存。')
  }

  // document-start 时还没有 body，等 DOM 就绪再挂界面
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildUI)
  } else {
    buildUI()
  }

  // 便于本地测试：Node 里能被 require 到（浏览器里没有 module，不影响）
  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = { extractTtml, guessSongId, fingerprint }
  }

  // 首屏内联数据也可能带 TTML，稍后再扫一次
  window.addEventListener('load', () => {
    setTimeout(() => {
      try {
        harvest(document.documentElement.innerHTML, '')
      } catch (e) {
        /* 忽略 */
      }
    }, 1500)
  })
})()
