// 文件挂载代理 · 通过 URL 下载
//
//   ?url=<http(s) 地址>        下载该文件
//   ?url=...&probe=1           只探测元信息（大小/类型/文件名），不传内容
//
// 策略（小文件代理、大文件跳转）：
//   - 体积 ≤ 4MB：由本函数取出并原样返回，能绕开源站的 CORS / 防盗链；
//   - 体积 > 4MB 或未知且超限：返回 302，让浏览器直连源站下载，
//     既不会撞 Vercel 函数约 4.5MB 的响应上限，也不消耗你的流量。
//
// 安全：只允许 http/https；每一跳都会解析域名并拒绝内网 / 环回 / 链路本地地址，
//       防止这个公开接口被当成探测内网的跳板（SSRF）。
const dns = require('dns').promises
const net = require('net')

const MAX_PROXY = 4 * 1024 * 1024 // 4MB
const TIMEOUT_MS = 20000
const MAX_HOPS = 5
const UA = 'Mozilla/5.0 (compatible; SanwithFileProxy/1.0)'

function fail(status, msg) {
  return { status, body: { code: status, msg } }
}

function ipIsPrivate(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number)
    return (
      p[0] === 0 ||
      p[0] === 10 ||
      p[0] === 127 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      p[0] >= 224
    )
  }
  const v = String(ip).toLowerCase()
  if (v === '::1' || v === '::') return true
  if (v.startsWith('fc') || v.startsWith('fd')) return true // 唯一本地地址
  if (v.startsWith('fe80')) return true // 链路本地
  if (v.startsWith('::ffff:')) return ipIsPrivate(v.slice(7))
  return false
}

/** 校验目标地址：协议白名单 + 域名解析结果不得指向内网 */
async function checkUrl(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error('不是合法的 URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('只支持 http / https 链接')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (net.isIP(host)) {
    if (ipIsPrivate(host)) throw new Error('不允许访问内网地址')
    return url
  }
  if (/^(localhost|.+\.local|.+\.internal|.+\.localhost)$/i.test(host)) {
    throw new Error('不允许访问内网地址')
  }
  const addrs = await dns.lookup(host, { all: true })
  if (!addrs.length) throw new Error('域名无法解析')
  for (const a of addrs) {
    if (ipIsPrivate(a.address)) throw new Error('不允许访问内网地址')
  }
  return url
}

/** 手动跟跳，每一跳都重新做一次内网校验（fetch 自动跟跳会绕过校验） */
async function openFollow(startUrl, headers, signal) {
  let current = startUrl
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const res = await fetch(current, {
      redirect: 'manual',
      signal,
      headers: { 'User-Agent': UA, ...headers },
    })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) return { res, url: current }
      const next = new URL(loc, current)
      current = await checkUrl(next.href)
      continue
    }
    return { res, url: current }
  }
  throw new Error('跳转次数过多')
}

/** 从 content-range / content-length 推断总大小 */
function sizeOf(res) {
  const cr = res.headers.get('content-range')
  if (cr) {
    const m = /\/(\d+)\s*$/.exec(cr)
    if (m) return Number(m[1])
  }
  const cl = res.headers.get('content-length')
  if (cl && /^\d+$/.test(cl)) return Number(cl)
  return null
}

function nameOf(res, url) {
  const cd = res.headers.get('content-disposition') || ''
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd)
  if (star) {
    try {
      return decodeURIComponent(star[1])
    } catch {
      /* 继续尝试其它写法 */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(cd)
  if (plain) return plain[1]
  const seg = decodeURIComponent(
    url.pathname.split('/').filter(Boolean).pop() || '',
  )
  return seg || 'download'
}

/** 读取响应体，超过 cap 就放弃（此时还没向客户端发送任何东西，可以改走跳转） */
async function readCapped(res, cap) {
  const chunks = []
  let total = 0
  for await (const chunk of res.body) {
    total += chunk.length
    if (total > cap) {
      try {
        await res.body.cancel()
      } catch {
        /* 取消失败无所谓，下面直接返回 */
      }
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

module.exports = async (query) => {
  const raw = String(query.url || '').trim()
  if (!raw) return fail(400, 'url 必填')

  let start
  try {
    start = await checkUrl(raw)
  } catch (e) {
    return fail(400, e.message)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const probe = String(query.probe || '') === '1'
    const { res, url } = await openFollow(
      start,
      probe ? { Range: 'bytes=0-0' } : {},
      controller.signal,
    )

    if (!res.ok && res.status !== 206) {
      return fail(res.status === 404 ? 404 : 502, `源站返回 ${res.status}`)
    }

    const size = sizeOf(res)
    const name = nameOf(res, url)

    if (probe) {
      try {
        await res.body?.cancel()
      } catch {
        /* 忽略 */
      }
      return {
        status: 200,
        body: {
          code: 200,
          size,
          name,
          type: res.headers.get('content-type') || '',
          proxy: size !== null && size <= MAX_PROXY,
        },
      }
    }

    // 已知过大：不取内容，直接让浏览器去源站下载
    if (size !== null && size > MAX_PROXY) {
      try {
        await res.body?.cancel()
      } catch {
        /* 忽略 */
      }
      return { status: 302, body: '', redirectUrl: url.href }
    }

    const buf = await readCapped(res, MAX_PROXY)
    if (!buf) return { status: 302, body: '', redirectUrl: url.href }

    return { status: 200, body: buf }
  } catch (e) {
    if (e && e.name === 'AbortError') return fail(504, '源站响应超时')
    return fail(502, e.message || '下载失败')
  } finally {
    clearTimeout(timer)
  }
}
