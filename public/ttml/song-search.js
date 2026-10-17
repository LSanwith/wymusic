/**
 * 按歌名搜歌 → 显示封面/歌名/歌手/id → 一键把 id 填进去。
 *
 * 上传页和预览页共用这一份，用法：
 *   SongSearch.mount(container, {
 *     onPick: function (song) { ... },        // 必填
 *     getUsedIds: function () { return [] },  // 可选：返回「已经在列表里」的 id 数组，
 *                                             //       这些结果会标绿
 *     placeholder: '按歌名或歌曲 id 搜索，例如 晴天',
 *     hint: '搜索结果点一下就能把 id 填进去',
 *   })
 *
 * song = { id, name, artists, album, cover, durationSec }
 */
(function () {
  'use strict'

  var STYLE_ID = 'song-search-style'
  var CSS = [
    '.ss { margin-top: 10px; }',
    '.ss-row { display: flex; gap: 8px; align-items: center; }',
    '.ss-row input { flex: 1 1 auto; min-width: 0; }',
    '.ss-row button { flex: 0 0 auto; }',
    '.ss-list { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }',
    '.ss-card {',
    '  display: flex; gap: 12px; align-items: center;',
    '  padding: 8px 10px; border-radius: 10px;',
    '  border: 1px solid var(--card-border, rgba(255,255,255,.15));',
    '  background: rgba(0,0,0,.22); cursor: pointer;',
    '  transition: background .18s, border-color .18s;',
    '}',
    '.ss-card:hover { background: rgba(255,255,255,.1); border-color: rgba(255,255,255,.3); }',
    /* 已经在 TTML 的 id 列表里：绿色高亮 */
    '.ss-card.used {',
    '  border-color: rgba(126,226,168,.65);',
    '  background: rgba(126,226,168,.12);',
    '}',
    '.ss-card.used .ss-id { color: rgba(126,226,168,.95); }',
    '.ss-card.used .ss-pick {',
    '  border-color: rgba(126,226,168,.5);',
    '  color: #7ee2a8;',
    '  background: rgba(126,226,168,.12);',
    '}',
    '.ss-cover {',
    '  flex: 0 0 52px; width: 52px; height: 52px; border-radius: 8px;',
    '  object-fit: cover; background: rgba(255,255,255,.08); display: block;',
    '}',
    '.ss-info { flex: 1 1 auto; min-width: 0; }',
    '.ss-name {',
    '  font-size: 14px; font-weight: 500; color: var(--fg, #fff);',
    '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;',
    '}',
    '.ss-meta {',
    '  font-size: 12px; color: var(--muted, rgba(255,255,255,.7));',
    '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;',
    '}',
    '.ss-id {',
    '  font-size: 11.5px; color: rgba(255,255,255,.45);',
    '  font-family: ui-monospace, Consolas, monospace;',
    '}',
    '.ss-pick { flex: 0 0 auto; padding: 7px 12px; font-size: 13px; }',
    '.ss-state { font-size: 13px; color: var(--muted, rgba(255,255,255,.7)); }',
    '.ss-state.err { color: #ff9c9c; }',
  ].join('\n')

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return
    var st = document.createElement('style')
    st.id = STYLE_ID
    st.textContent = CSS
    document.head.appendChild(st)
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }

  function mount(container, opts) {
    opts = opts || {}
    ensureStyle()

    var root = el('div', 'ss')
    var row = el('div', 'ss-row')
    var input = el('input')
    input.type = 'text'
    input.placeholder = opts.placeholder || '按歌名或歌曲 id 搜索，例如 晴天'
    input.setAttribute('enterkeyhint', 'search')
    var btn = el('button', 'ss-btn', opts.buttonText || '搜歌曲')
    btn.type = 'button'
    row.appendChild(input)
    row.appendChild(btn)

    var list = el('div', 'ss-list')
    var state = el('div', 'ss-state', opts.hint || '输入歌名或 id 搜索，点结果就能把 id 填进去')

    root.appendChild(row)
    root.appendChild(state)
    root.appendChild(list)
    container.appendChild(root)

    var seq = 0
    // 本地缓存：上游搜索有频率限制（连续搜会 405），同一个词 2 分钟内不重复请求。
    // 也别加时间戳参数 —— 服务端已经挂了 2 分钟缓存，带随机参数会把它废掉。
    var cache = {}
    var CACHE_MS = 120000

    function usedSet() {
      var out = {}
      if (typeof opts.getUsedIds === 'function') {
        var list2 = opts.getUsedIds() || []
        for (var i = 0; i < list2.length; i++) out[String(list2[i]).trim()] = true
      }
      return out
    }

    /** 把「已在列表里」的卡片标绿；列表变动（填了新的、删了行）之后调一下 */
    function refreshUsed() {
      var used = usedSet()
      var usedLabel = opts.usedLabel || '移除'
      var cards = list.querySelectorAll('.ss-card')
      for (var i = 0; i < cards.length; i++) {
        var id = cards[i].getAttribute('data-id')
        var on = !!used[id]
        cards[i].classList.toggle('used', on)
        cards[i].title = on ? '再点一下从列表里移除' : '点一下使用这个 id'
        var b = cards[i].querySelector('.ss-pick')
        if (b) b.textContent = on ? usedLabel : '用这个 id'
      }
    }

    function pick(song) {
      if (typeof opts.onPick === 'function') opts.onPick(song)
      refreshUsed()
    }

    function renderCard(s) {
      var card = el('div', 'ss-card')
      card.setAttribute('data-id', s.id)
      card.title = '点一下使用这个 id'

      var img = el('img', 'ss-cover')
      img.alt = ''
      img.loading = 'lazy'
      img.referrerPolicy = 'no-referrer'
      if (s.cover) img.src = s.cover
      card.appendChild(img)

      var info = el('div', 'ss-info')
      info.appendChild(el('div', 'ss-name', s.name || '(无标题)'))
      var meta = [s.artists, s.album].filter(Boolean).join(' · ')
      info.appendChild(el('div', 'ss-meta', meta || '—'))
      info.appendChild(el('div', 'ss-id', 'id ' + s.id))
      card.appendChild(info)

      var b = el('button', 'ss-pick', '用这个 id')
      b.type = 'button'
      b.addEventListener('click', function (e) {
        e.stopPropagation()
        pick(s)
      })
      card.appendChild(b)

      card.addEventListener('click', function () {
        pick(s)
      })
      return card
    }

    function showSongs(data, kw) {
      list.innerHTML = ''
      if (!data.songs || !data.songs.length) {
        state.className = 'ss-state'
        state.textContent = '没搜到「' + kw + '」，换个关键词或直接填 id 试试。'
        return
      }
      state.className = 'ss-state'
      state.textContent = data.byId
        ? '按 id 查到的歌曲，点一下使用：'
        : '找到 ' + data.songs.length + ' 首，点一下使用它的 id：'
      for (var i = 0; i < data.songs.length; i++) {
        list.appendChild(renderCard(data.songs[i]))
      }
      refreshUsed()
    }

    function search() {
      var kw = input.value.trim()
      if (!kw) {
        state.className = 'ss-state err'
        state.textContent = '先输入歌名或歌曲 id。'
        return
      }
      var key = kw.toLowerCase()
      var hit = cache[key]
      if (hit && Date.now() - hit.at < CACHE_MS) {
        showSongs(hit.data, kw)
        return
      }

      var mine = ++seq
      btn.disabled = true
      state.className = 'ss-state'
      state.textContent = '搜索中…'
      list.innerHTML = ''

      fetch('/ttml/song?keywords=' + encodeURIComponent(kw))
        .then(function (r) { return r.json() })
        .then(function (j) {
          if (mine !== seq) return // 有更新的搜索了，丢掉这次结果
          btn.disabled = false
          if (j.code !== 200) {
            state.className = 'ss-state err'
            state.textContent = j.msg || '搜索失败'
            return
          }
          cache[key] = { at: Date.now(), data: j }
          showSongs(j, kw)
        })
        .catch(function (e) {
          if (mine !== seq) return
          btn.disabled = false
          state.className = 'ss-state err'
          state.textContent = '请求失败：' + (e && e.message ? e.message : e)
        })
    }

    btn.addEventListener('click', search)
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault()
        search()
      }
    })

    return {
      focus: function () { input.focus() },
      refreshUsed: refreshUsed,
      clear: function () {
        input.value = ''
        list.innerHTML = ''
        state.className = 'ss-state'
        state.textContent = opts.hint || ''
      },
    }
  }

  window.SongSearch = { mount: mount }
})()
