#!/usr/bin/env node
// TTML 数据迁移：从线上 API 拉到本地磁盘
//
//   node tools/ttml-migrate.js --from https://sanwith.de5.net --to ./data/kv
//
// 做两件事：
//   1. GET /ttml/admin/list 拿到所有 ttmlId 和它们绑定的歌曲 id
//   2. 逐个 GET /ttml/file?id=<歌曲id> 取回 TTML 原文，再用 ttmlStore.save()
//      写进目标存储（默认本地磁盘，取决于 KV_DRIVER / KV_LOCAL_DIR）
//
// 为什么走 HTTP 而不是直连 KV：线上数据在 Upstash 里，凭据只在 Vercel 环境变量里，
// 走 API 不需要凭据，也不会碰到 Blob 那一层。
//
// --dry 只读取和打印，不写任何东西。

const path = require('path')

const argv = process.argv.slice(2)
function arg(name, fallback) {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const FROM = String(arg('from', '')).replace(/\/+$/, '')
const TO = arg('to', '')
const DRY = argv.includes('--dry')

if (!FROM) {
  console.error('缺少 --from，例如：--from https://sanwith.de5.net')
  process.exit(2)
}

// 必须在 require 之前设定，store 会读这两个变量
process.env.KV_DRIVER = 'local'
if (TO) process.env.KV_LOCAL_DIR = path.resolve(TO)

const store = require('../plugins/ttmlStore.js')

async function main() {
  console.log('源站:', FROM)
  console.log('目标:', process.env.KV_LOCAL_DIR)
  console.log('模式:', DRY ? '只读演练（不写入）' : '写入')
  console.log('')

  const listRes = await fetch(FROM + '/ttml/admin/list')
  if (!listRes.ok) throw new Error('列表接口失败：HTTP ' + listRes.status)
  const list = await listRes.json()
  if (!list || !Array.isArray(list.items)) {
    throw new Error('列表接口返回异常：' + JSON.stringify(list).slice(0, 200))
  }

  console.log(
    `线上共 ${list.items.length} 份 TTML、${list.bindingCount} 个绑定`,
  )
  if (list.legacyCount) console.log(`另有老格式 ${list.legacyCount} 个`)

  let saved = 0
  let failed = 0
  for (const item of list.items) {
    const ids = item.ids || []
    const probe = ids[0]
    if (!probe) {
      console.log(`  跳过 ${item.ttmlId}：没有绑定任何歌曲 id`)
      continue
    }
    let ttml = ''
    try {
      const res = await fetch(
        `${FROM}/ttml/file?id=${encodeURIComponent(probe)}`,
      )
      if (!res.ok) throw new Error('HTTP ' + res.status)
      ttml = await res.text()
    } catch (e) {
      failed++
      console.log(`  失败 ${item.ttmlId}：下载出错 ${e.message}`)
      continue
    }
    if (ttml.indexOf('<tt') < 0) {
      failed++
      console.log(
        `  失败 ${item.ttmlId}：返回内容不像 TTML（${ttml.length} 字节）`,
      )
      continue
    }
    if (DRY) {
      saved++
      console.log(
        `  [演练] ${item.ttmlId}  ${ttml.length} 字节  ids=${ids.join(',')}`,
      )
      continue
    }
    try {
      const r = await store.save(ids, ttml)
      if (r && r.blocked) {
        failed++
        console.log(
          `  失败 ${item.ttmlId}：${r.conflicts.length} 个 id 已绑别的版本`,
        )
        continue
      }
      saved++
      console.log(
        `  已写入 ${r.ttmlId}  ${(ttml.length / 1024).toFixed(1)} KB  ` +
          `ids=${ids.join(',')}${r.alreadyBound && r.alreadyBound.length ? ' (已有 ' + r.alreadyBound.length + ' 个)' : ''}`,
      )
    } catch (e) {
      failed++
      console.log(`  失败 ${item.ttmlId}：写入出错 ${e.message}`)
    }
  }

  console.log('')
  console.log(`完成：成功 ${saved}，失败 ${failed}`)
  if (failed) process.exitCode = 1
}

main().catch((e) => {
  console.error('迁移中断：', e && e.message ? e.message : e)
  process.exit(1)
})
