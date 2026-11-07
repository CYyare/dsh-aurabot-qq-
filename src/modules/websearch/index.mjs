/** @type {import('../aurabot').AurabotModule} */
// 联网搜索：给大肥鱼「查一下」和「点进去看」两件事。
//
// 搜索源两种：
//   site     —— 直接打开你指定的网址抓结果页（默认 bing.com），解析标题/链接/摘要
//   provider —— 走 DSH 自己的 ctx.web 搜索 provider（DeepSeek 官方搜索）
//
// 三个工具闸（都在搜索之前）：触发词 → 审批 → 限流
//
// 读网页：搜完自动读相关度最高的前 N 条正文（可关/可调字数），
// 另外提供 qq_web_read 工具，让她能顺着链接继续看。
//
// ⚠ 状态放在 globalThis 上、工具执行时再查当前实例：
//   插件的工具是「按工具名」缓存在会话上的（src/chat/hub.js 的 toolsKey），
//   模块热重载后名字没变就不会重挂，会话手里还是旧实例的工具对象。
//   旧对象的闭包里 state 是旧的（比如启动时为空的消息窗口），会导致
//   「明明说了触发词却被判没提到」。所以状态和实现都放到全局，
//   旧工具对象调用时拿到的一定是当前实例。

const STATE_KEY = '__aurabotWebsearch'
const G =
  globalThis[STATE_KEY] ||
  (globalThis[STATE_KEY] = {
    said: new Map(), // chatId -> 最近几条消息
    hits: new Map(), // 搜索限流
    readHits: new Map(), // 读页面限流
    approvedAt: new Map(), // chatId -> 最近一次主人同意
    pending: [], // 等审批的请求
    recent: [], // 最近搜索记录
    seq: 0,
    impl: null, // 当前实例的实现，工具对象通过它转发
  })

const DEFAULT_SETTINGS = {
  enabled: true,
  allowGroups: true,
  searchMode: 'site',
  searchSite: 'https://www.bing.com',
  autoSearch: false,
  requireMention: true,
  triggerWords: '搜,搜一下,搜索,查一下,查查,帮我搜,帮我查',
  ownerApproval: true,
  approvalTimeoutSec: 60,
  readTop: 1,
  readChars: 1500,
  maxResults: 5,
  perMinute: 3,
}

const RECENT_MAX = 20
const WINDOW = 3
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'
const PAGE_HEADERS = {
  'user-agent': UA,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'cache-control': 'no-cache',
  pragma: 'no-cache',
  'upgrade-insecure-requests': '1',
}
const SEARCH_HEADERS = { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' }

// ── 文本工具 ──
function decodeEntities(raw) {
  return String(raw)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&ensp;|&emsp;|&nbsp;|&middot;|&hellip;|&mdash;|&ndash;|&laquo;|&raquo;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/&[a-z]{2,10};/gi, ' ')
}

const stripTags = (s) => String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

/** bing 会把结果 URL 包成 /ck/a?u=a1<base64url>，这里还原成真实地址。 */
function realUrl(href, base) {
  try {
    const u = new URL(decodeEntities(href), base || 'https://www.bing.com')
    if (/(^|\.)bing\.com$/i.test(u.hostname) && u.pathname === '/ck/a') {
      const p = u.searchParams.get('u') || ''
      if (p.startsWith('a1')) {
        const b64 = p.slice(2).replace(/-/g, '+').replace(/_/g, '/')
        return Buffer.from(b64 + '='.repeat((4 - (b64.length % 4)) % 4), 'base64').toString('utf8')
      }
    }
    return u.toString()
  } catch (error) {
    return href
  }
}

const isBing = (url) => {
  try {
    return /(^|\.)bing\.com$/i.test(new URL(url).hostname)
  } catch (error) {
    return false
  }
}

/** 解析 bing 结果页的 b_algo 块。 */
function parseBing(html, limit) {
  const out = []
  for (const block of String(html).split(/class="b_algo"/).slice(1)) {
    const h2 = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)
    if (!h2) continue
    const a = h2[1].match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
    if (!a) continue
    const url = realUrl(a[1])
    if (!/^https?:/i.test(url) || isBing(url)) continue
    const title = stripTags(decodeEntities(a[2]))
    if (!title) continue
    const cap =
      block.match(/<p[^>]*>([\s\S]*?)<\/p>/i) ||
      block.match(/class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/(?:div|p)>/i) ||
      block.match(/class="b_caption"[^>]*>([\s\S]*?)<\/(?:div|p)>/i)
    const snippet = cap ? stripTags(decodeEntities(cap[1])).slice(0, 200) : ''
    out.push({ title, url, snippet })
    if (out.length >= limit) break
  }
  return out
}

/** 别的搜索站：退而求其次，抓页面上像结果的外链。 */
function parseGeneric(html, limit, base) {
  const out = []
  const seen = new Set()
  const re = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let m
  while ((m = re.exec(String(html))) && out.length < limit) {
    const url = realUrl(m[1], base)
    if (!/^https?:/i.test(url) || isBing(url)) continue
    const title = stripTags(decodeEntities(m[2]))
    if (title.length < 6 || seen.has(url)) continue
    seen.add(url)
    out.push({ title, url, snippet: '' })
  }
  return out
}

/** 把「你填的网址」变成一次搜索的 URL：支持 {q} 占位符，否则按站点惯例拼 /search?q= */
export function buildSearchUrl(site, query) {
  const s = String(site || '').trim() || DEFAULT_SETTINGS.searchSite
  const q = encodeURIComponent(String(query || '').trim())
  if (/\{(q|query)\}/i.test(s)) return s.replace(/\{(q|query)\}/gi, q)
  const base = s.replace(/\/+$/, '')
  if (/\/(search|s|so|web)$/i.test(base)) return `${base}?q=${q}`
  return `${base}/search?q=${q}`
}

// ── 查询相关性 ──
// 「今天/现在/最新」这类词会把引擎带到「日历」「历史上的今天」这种页面：
// 实测「今天溧阳天气」返回日历网和黄历，而「溧阳天气」完全正确。
const FILLER = /(今天|今日|现在|目前|当前|最新|最近|实时|请问|帮我|帮忙|麻烦|查一下|搜一下|看一下|一下|怎么样|怎样|多少|是什么|有没有|我们|你们|他们|的|地|得|了|吗|呢|吧|啊|呀|嘛|我|你)/g

/** 查询里真正有信息量的词。 */
export function contentTerms(query) {
  const cleaned = String(query || '')
    .replace(FILLER, ' ')
    .replace(/[，。！？、；：,.!?;:]/g, ' ')
    .trim()
  if (!cleaned) return []
  return cleaned.split(/\s+/).filter((t) => t.length >= 2)
}

/** 结果和查询词的重合度（标题权重高一些）。 */
function relevanceOf(item, terms) {
  if (!terms.length) return 0
  const title = String(item?.title || '').toLowerCase()
  const body = `${title} ${String(item?.snippet || '').toLowerCase()}`
  let score = 0
  for (const t of terms) {
    const w = t.toLowerCase()
    if (title.includes(w)) score += 2
    else if (body.includes(w)) score += 1
  }
  return score
}

/** 按相关度稳定排序（同分保持引擎原本的顺序）。 */
function rankByRelevance(sources, terms) {
  if (!terms.length) return sources
  return sources
    .map((s, i) => ({ s, i, r: relevanceOf(s, terms) }))
    .sort((a, b) => b.r - a.r || a.i - b.i)
    .map((x) => x.s)
}

// ── 读网页 ──
const PRIVATE_HOST = /^(localhost|127\.|0\.0\.0\.0$|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?)/i

function assertPublicUrl(raw) {
  const u = new URL(String(raw || '').trim())
  if (!/^https?:$/.test(u.protocol)) throw new Error('只读 http/https 链接')
  if (PRIVATE_HOST.test(u.hostname)) throw new Error('不读内网地址')
  return u
}

function sniffCharset(type, buf) {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(String(type || ''))
  if (fromHeader) return fromHeader[1].toLowerCase()
  const head = buf.slice(0, 4096).toString('latin1')
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)
  return fromMeta ? fromMeta[1].toLowerCase() : ''
}

/** 从 HTML 里抠出正文：去掉脚本/样式/导航/页脚，整页取文字再过滤样板行。
 *  （按 <article>/<main> 挑块在中文站点上经常挑到广告位，实测还不如整页。） */
function extractArticle(html) {
  let s = String(html).replace(/<!--[\s\S]*?-->/g, ' ')
  s = s.replace(/<(script|style|noscript|svg|iframe|template|head|nav|header|footer|aside|form|button|select)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  const body = (s.match(/<body\b[^>]*>([\s\S]*)<\/body>/i) || [null, s])[1]
  let t = body.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/blockquote|\/td)\b[^>]*>/gi, '\n')
  t = t.replace(/<[^>]*>/g, ' ')
  t = decodeEntities(t).replace(/[ \t\f\v\u00a0]+/g, ' ')

  const boiler = /版权所有|ICP备|网站标识码|主办[:：]|Copyright\s*©|技术支持|联系我们|免责声明|扫码|下载客户端|登录后|APP内打开/i
  const seen = new Set()
  const lines = []
  // 表格/天气这类页面会被拆成一格一行（「29日（今天）」「多云」「14℃」），
  // 按长度丢碎片会把温度一起丢掉，所以把连续短行合并成一行。
  let pending = ''
  const flush = () => {
    const joined = pending.replace(/\s+/g, ' ').trim()
    if (joined) lines.push(joined)
    pending = ''
  }
  for (const raw of t.split(/\n+/)) {
    const line = raw.replace(/\s+/g, ' ').trim()
    if (!line || seen.has(line)) continue
    if (/^(首页|登录|注册|更多|上一页|下一页|返回|分享|评论|广告|收藏)/.test(line) && line.length < 24) continue
    if (boiler.test(line) && line.length < 60) continue
    seen.add(line)
    pending = pending ? pending + ' ' + line : line
    if (pending.length >= 12) flush()
    if (lines.length >= 400) break
  }
  flush()
  // 开头的导航块（城市列表、栏目名）都是短行、没数字没句号；找到第一行「像内容」的为止
  let start = 0
  while (start < lines.length && start < 60 && !/[\d℃°%]/.test(lines[start]) && !/[。！？；]/.test(lines[start])) {
    start++
  }
  return lines.slice(start).join('\n')
}

function pageTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i.exec(html)
  return m ? stripTags(decodeEntities(m[1])).slice(0, 120) : ''
}

async function fetchPage(rawUrl, chars) {
  const u = assertPublicUrl(rawUrl)
  const res = await fetch(u.toString(), { headers: PAGE_HEADERS, signal: AbortSignal.timeout(20_000), redirect: 'follow' })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const type = res.headers.get('content-type') || ''
  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length) throw new Error('页面是空的')
  const charset = sniffCharset(type, buf) || 'utf-8'
  let raw
  try {
    raw = new TextDecoder(charset).decode(buf)
  } catch (error) {
    raw = buf.toString('utf8')
  }
  const isHtml = /text\/html|application\/xhtml/i.test(type) || /<html[\s>]/i.test(raw.slice(0, 1000))
  if (!isHtml) return { url: u.toString(), title: '', text: raw.slice(0, chars), kind: 'plain' }
  const title = pageTitle(raw)
  const text = extractArticle(raw)
  if (text.length < 80) throw new Error('这页没有可读的正文（可能要登录、或内容靠脚本加载）')
  return { url: u.toString(), title, text: text.slice(0, chars), kind: 'html' }
}

export default {
  id: 'websearch',
  name: '联网搜索',
  version: '1.0.0',
  api: 1,
  description: '让她能搜、也能点进链接读正文。可以指定搜索网址、限制触发词、别人搜要先问主人。',
  defaults: DEFAULT_SETTINGS,
  settings: [
    { key: 'enabled', label: '启用', type: 'switch', hint: '关掉后这个工具就不挂给她了' },
    { key: 'allowGroups', label: '群聊也能用', type: 'switch', hint: '关掉就只有主人私聊能查' },
    { key: 'searchMode', label: '搜索源', type: 'select', options: [{ value: 'site', label: '指定网址' }, { value: 'provider', label: 'DSH 内置搜索' }], hint: '指定网址 = 直接打开下面的网站抓结果页' },
    { key: 'searchSite', label: '搜索网址', type: 'text', placeholder: 'https://www.bing.com', hint: '填站点根地址（会用 /search?q=...），或用 {q} 写完整模板' },
    { key: 'readTop', label: '搜完自动读前几条', type: 'number', min: 0, max: 3, step: 1, hint: '0 = 只给链接；1 = 直接把最相关那条的正文读进来看' },
    { key: 'readChars', label: '每条正文最多多少字', type: 'number', min: 300, max: 6000, step: 100 },
    { key: 'autoSearch', label: '她可以自己决定要不要搜', type: 'switch', hint: '打开后：对话里出现她不懂、或可能过时的东西，她可以不等你说「搜」就自己去查。打开时下面的触发词限制不再生效' },
    { key: 'requireMention', label: '必须提到触发词才搜', type: 'switch', hint: '对方最近几句话里没出现触发词就不许搜（对你自己也一样）；如果上面「自己决定」打开了，这项会被忽略' },
    { key: 'triggerWords', label: '触发词', type: 'text', placeholder: '搜,查一下,帮我查', hint: '用逗号分隔；出现任意一个才放行' },
    { key: 'ownerApproval', label: '别人搜要先问我', type: 'switch', hint: '打开后：不是主人触发的搜索，会先给你发 QQ 请求，你同意才真的搜' },
    { key: 'approvalTimeoutSec', label: '等多久没回就拒绝（秒）', type: 'number', min: 20, max: 300, step: 10 },
    { key: 'maxResults', label: '每次最多几条', type: 'number', min: 1, max: 8, step: 1 },
    { key: 'perMinute', label: '每个聊天每分钟最多几次', type: 'number', min: 1, max: 20, step: 1 },
  ],
  panel: 'panel.js',

  setup(api) {
    const settings = () => ({ ...DEFAULT_SETTINGS, ...(api.settings() || {}) })
    const ownerQQ = () => String(api.config()?.ownerQQ || '')
    const ownerChat = () => 'private:' + ownerQQ()

    const wordsOf = (raw) =>
      String(raw || '')
        .split(/[,，、;；\s]+/)
        .map((w) => w.trim())
        .filter(Boolean)

    function gate(text, cfg) {
      const words = wordsOf(cfg.triggerWords)
      const matched = words.find((w) => String(text || '').includes(w)) || ''
      // 「她可以自己决定」优先：这时不拿触发词卡她，由她自己判断该不该搜
      if (cfg.autoSearch) return { allowed: true, words, matched, auto: true }
      if (!cfg.requireMention) return { allowed: true, words, matched }
      if (!words.length) return { allowed: true, words, matched: '' }
      return { allowed: Boolean(matched), words, matched }
    }

    const web = (exec) => {
      try {
        const fromAgent = exec?.agent?.ctx?.web
        if (fromAgent?.search) return fromAgent
      } catch (error) {}
      try {
        return api.dsh?.get?.('web') || null
      } catch (error) {
        return null
      }
    }

    async function searchBySite(cfg, query, signal) {
      const url = buildSearchUrl(cfg.searchSite, query)
      const res = await fetch(url, { headers: SEARCH_HEADERS, signal, redirect: 'follow' })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const html = await res.text()
      const limit = Number(cfg.maxResults) || 5
      const sources = isBing(url) ? parseBing(html, limit) : parseGeneric(html, limit, url).concat(parseBing(html, limit)).slice(0, limit)
      return { url, sources, content: '' }
    }

    async function runSearch(cfg, query, exec) {
      const signal = AbortSignal.timeout(25_000)
      const terms = contentTerms(query)
      let siteError = null
      if (cfg.searchMode !== 'provider') {
        try {
          let r = await searchBySite(cfg, query, signal)
          // 结果和问题完全不沾边（「今天溧阳天气」被搜成「今天」），
          // 就用去掉时间词/语气词的查询重试一次。
          const best = r.sources.length ? Math.max(...r.sources.map((s) => relevanceOf(s, terms))) : 0
          if (r.sources.length && terms.length && best === 0) {
            const simplified = terms.join(' ')
            if (simplified && simplified !== String(query).trim()) {
              api.log.info(`「${query}」搜歪了，改用「${simplified}」重试`)
              const r2 = await searchBySite(cfg, simplified, signal)
              const best2 = r2.sources.length ? Math.max(...r2.sources.map((s) => relevanceOf(s, terms))) : 0
              if (r2.sources.length && best2 > best) r = r2
            }
          }
          if (r.sources.length) return { ...r, sources: rankByRelevance(r.sources, terms), used: hostOf(cfg.searchSite) }
        } catch (error) {
          siteError = error
          api.log.warn('抓 ' + hostOf(cfg.searchSite) + ' 失败：', error?.message || String(error))
        }
      }
      const seam = web(exec)
      if (seam?.search) {
        const r = await seam.search({ query, maxResults: Number(cfg.maxResults) || 5 }, AbortSignal.timeout(30_000))
        return { url: '', sources: rankByRelevance(r?.sources || [], terms), content: r?.content || '', used: '内置搜索' }
      }
      if (siteError) throw siteError
      return { url: '', sources: [], content: '', used: '' }
    }

    function hostOf(site) {
      try {
        return new URL(buildSearchUrl(site, 'x')).hostname
      } catch (error) {
        return String(site || '')
      }
    }

    function overLimit(map, chatId, perMinute) {
      const now = Date.now()
      const list = (map.get(chatId) || []).filter((t) => now - t < 60_000)
      if (list.length >= perMinute) {
        map.set(chatId, list)
        return Math.ceil((60_000 - (now - list[0])) / 1000)
      }
      list.push(now)
      map.set(chatId, list)
      return 0
    }

    function record(chatId, query, ok, note) {
      G.recent.unshift({ at: Date.now(), chatId, query: String(query || '').slice(0, 80), ok, note: String(note || '') })
      while (G.recent.length > RECENT_MAX) G.recent.pop()
    }

    const windowOf = (chatId) => (G.said.get(chatId) || []).map((m) => m.text).join('\n')
    const lastNick = (chatId) => {
      const list = G.said.get(chatId) || []
      return list.length ? list[list.length - 1].nick : ''
    }
    const groupName = (groupId) => {
      try {
        return api.core.hub.groupName(String(groupId)) || String(groupId)
      } catch (error) {
        return String(groupId)
      }
    }

    function askOwner(chat, query, cfg) {
      return new Promise((resolve) => {
        const own = ownerQQ()
        const conf = api.config() || {}
        if (!own) return resolve({ approved: false, reason: '没配主人 QQ' })
        if (conf.dryRun) return resolve({ approved: false, reason: '试运行中，没发请求' })

        const id = ++G.seq
        const seconds = Math.max(20, Math.min(300, Number(cfg.approvalTimeoutSec) || 60))
        const who = lastNick(chat.chatId) || '有人'
        const where = chat.kind === 'group' ? `群「${groupName(chat.groupId)}」里的 ${who}` : `QQ ${who}`
        const entry = { id, chatId: chat.chatId, query, at: Date.now(), timer: null, resolve }

        entry.timer = setTimeout(() => settle(entry, false, '超时'), seconds * 1000)
        G.pending.push(entry)

        Promise.resolve(
          api.sendText(ownerChat(), `【联网搜索请求 #${id}】${where} 想让我搜：「${query}」\n回「同意」或「拒绝」，${seconds} 秒内有效。`),
        ).catch((error) => {
          api.log.warn('发审批请求失败：', error?.message || error)
          settle(entry, false, '请求没发出去')
        })
        api.log.info(`等主人审批搜索 #${id}：${chat.chatId} → ${query}`)
      })
    }

    function settle(entry, approved, by) {
      const i = G.pending.indexOf(entry)
      if (i < 0) return
      G.pending.splice(i, 1)
      try {
        clearTimeout(entry.timer)
      } catch (error) {}
      api.log.info(`搜索请求 #${entry.id}：${approved ? '主人同意' : '没同意'}（${by || ''}）`)
      entry.resolve({ approved, reason: by || '' })
    }

    function decideByText(text, chatId) {
      if (!G.pending.length) return false
      const t = String(text || '').trim()
      if (!t) return false
      const deny = /不同意|不行|拒绝|别搜|不要搜|算了|取消|不用/.test(t)
      const allow = /同意|可以|批准|确认|搜吧|去搜/.test(t)
      if (!deny && !allow) return false
      const m = t.match(/#?(\d{1,3})/)
      const target = m ? G.pending.find((p) => p.id === Number(m[1])) : G.pending[0]
      if (!target) return false
      settle(target, allow && !deny, 'QQ 回复')
      Promise.resolve(api.sendText(chatId, allow && !deny ? '好，让她去搜。' : '行，不搜了。')).catch(() => {})
      return true
    }

    /** 把抓到的几条正文拼成给模型看的段落。第一条打不开就顺延读下一条。 */
    async function readTopPages(sources, cfg) {
      const want = Math.max(0, Math.min(3, Number(cfg.readTop) || 0))
      if (!want || !sources.length) return { blocks: [], notes: [] }
      const chars = Math.max(300, Math.min(6000, Number(cfg.readChars) || 1500))
      const blocks = []
      const notes = []
      const attempts = Math.min(sources.length, want + 2)
      for (let i = 0; i < attempts && blocks.length < want; i++) {
        const s = sources[i]
        try {
          const page = await fetchPage(s.url, chars)
          blocks.push(`【正文 ${blocks.length + 1}】${page.title || s.title}\n${page.url}\n${page.text}`)
          notes.push(`第 ${i + 1} 条：${page.text.length} 字`)
        } catch (error) {
          notes.push(`第 ${i + 1} 条打不开（${error?.message || '出错'}）`)
        }
      }
      return { blocks, notes }
    }

    const isOwnerTurn = (level, sessionId) => {
      if (level === 'full') return true
      try {
        return Boolean(api.core.hub.turnHasOwner(sessionId))
      } catch (error) {
        return false
      }
    }

    // ── 工具实现（工具对象只负责转发到这里，见文件头说明） ──
    async function searchImpl({ query }, exec, ctx) {
      const { chat, level, sessionId } = ctx
      const cfg = settings()
      const q = String(query || '').trim()
      if (!q) return { ok: false, message: '搜索词是空的' }

      const mine = isOwnerTurn(level, sessionId)

      if (!mine && cfg.ownerApproval) {
        const verdict = await askOwner(chat, q, cfg)
        if (!verdict.approved) {
          record(chat.chatId, q, false, '主人没同意（' + verdict.reason + '）')
          return {
            ok: false,
            message: `这次搜索要先经过主人同意，现在没同意（${verdict.reason}），所以没搜。直接按你知道的回答；如果确实需要最新信息，可以跟对方说「我去问问主人」。`,
          }
        }
        G.approvedAt.set(chat.chatId, Date.now())
      } else {
        const verdict = gate(windowOf(chat.chatId), cfg)
        if (!verdict.allowed) {
          record(chat.chatId, q, false, '没提到触发词')
          return {
            ok: false,
            message: `对方没让你搜（最近几句话里没有「${verdict.words.slice(0, 3).join('」「')}」这类词），这次别搜了，直接用你已经知道的回答；需要的话可以先问一句要不要帮她搜。`,
          }
        }
      }

      const wait = overLimit(G.hits, chat.chatId, Number(cfg.perMinute) || 3)
      if (wait > 0) {
        record(chat.chatId, q, false, '限流')
        return { ok: false, message: `搜太频繁了，${wait} 秒后再试` }
      }

      let result
      try {
        result = await runSearch(cfg, q, exec)
      } catch (error) {
        api.log.warn('联网搜索失败：', error?.message || String(error))
        record(chat.chatId, q, false, '搜索失败：' + (error?.message || '出错'))
        return { ok: false, message: '没搜出来（' + (error?.message || '搜索服务出错') + '）' }
      }

      const sources = (result.sources || []).slice(0, Number(cfg.maxResults) || 5)
      const answer = String(result.content || '').trim()
      if (!sources.length && !answer) {
        record(chat.chatId, q, true, '0 条')
        return { ok: false, message: `「${q}」什么都没搜到，换个说法试试` }
      }

      const { blocks, notes } = await readTopPages(sources, cfg)
      record(
        chat.chatId,
        q,
        true,
        sources.length + ' 条（' + (result.used || '搜索') + '）' + (blocks.length ? '，读了 ' + blocks.length + ' 篇' : '') + (mine ? '' : '，主人已同意'),
      )

      const lines = []
      if (answer) lines.push(answer)
      if (sources.length) {
        lines.push('搜索结果：')
        for (const [i, s] of sources.entries()) {
          const title = s?.title || s?.url || '（无标题）'
          const snip = s?.snippet ? ' — ' + String(s.snippet).slice(0, 160) : ''
          lines.push(`${i + 1}. ${title}${snip}\n   ${s?.url || ''}`)
        }
      }
      if (blocks.length) {
        lines.push('')
        lines.push(blocks.join('\n\n'))
        lines.push('（以上正文是网页原文，可能夹带广告或无关内容；回答时用自己的话概括，带上来源链接。）')
      } else if (sources.length) {
        lines.push('（没读到正文。需要细节可以用 qq_web_read 打开某条链接。）')
      }
      return { ok: true, message: lines.join('\n') }
    }

    async function readImpl({ url }, exec, ctx) {
      const { chat, level, sessionId } = ctx
      const cfg = settings()
      const target = String(url || '').trim()
      if (!target) return { ok: false, message: '没给网址' }

      const mine = isOwnerTurn(level, sessionId)
      const fresh = Date.now() - (G.approvedAt.get(chat.chatId) || 0) < 5 * 60_000
      if (!mine && cfg.ownerApproval && !fresh) {
        const verdict = await askOwner(chat, '读网页 ' + target, cfg)
        if (!verdict.approved) {
          record(chat.chatId, target, false, '读网页没被同意（' + verdict.reason + '）')
          return { ok: false, message: '主人没同意读这个网页（' + verdict.reason + '），别读了。' }
        }
        G.approvedAt.set(chat.chatId, Date.now())
      }

      const wait = overLimit(G.readHits, chat.chatId, Number(cfg.perMinute) || 3)
      if (wait > 0) return { ok: false, message: `读太频繁了，${wait} 秒后再试` }

      const chars = Math.max(300, Math.min(6000, Number(cfg.readChars) || 1500))
      try {
        const page = await fetchPage(target, chars)
        record(chat.chatId, target, true, '读了 ' + page.text.length + ' 字')
        return {
          ok: true,
          message: `【${page.title || page.url}】\n${page.url}\n\n${page.text}\n\n（网页原文，可能夹带广告；回答时用自己的话概括。）`,
        }
      } catch (error) {
        record(chat.chatId, target, false, '读不了：' + (error?.message || '出错'))
        return { ok: false, message: '这页打不开：' + (error?.message || '出错') }
      }
    }

    // 当前实例的实现挂到全局：旧工具对象转发过来时用的是最新的代码和状态
    G.impl = { search: searchImpl, read: readImpl, api }

    api.on('message', (msg) => {
      try {
        if (!msg?.chatId) return false
        if (msg.chatId === ownerChat() && decideByText(msg.text, msg.chatId)) return true
        const list = G.said.get(msg.chatId) || []
        list.push({ text: String(msg.text || ''), nick: String(msg.nickname || msg.userId || '') })
        while (list.length > WINDOW) list.shift()
        G.said.set(msg.chatId, list)
      } catch (error) {
        api.log.warn('记录消息出错：', error?.message || String(error))
      }
      return false
    })

    api.tool((ctx) => {
      const cfg = settings()
      if (!cfg.enabled) return []
      if (ctx.chat.kind === 'system') return []
      if (ctx.level === 'chat') return []
      if (ctx.level === 'social' && !cfg.allowGroups) return []

      const searchTool = api.defineTool({
        name: 'qq_web_search',
        description:
          '上网搜一下，并且会把最相关的那条的正文一起读回来。用在你不确定、或者信息可能过时的时候（新闻、价格、天气、赛事、某个东西是什么、最近发生了什么）。' +
          '一次一个问题；回答时引用来源链接。如果想看别的链接，再用 qq_web_read 打开它。',
        properties: {
          query: { type: 'string', description: '搜索词，像在搜索框里输入的那样，别太长' },
        },
        required: ['query'],
        execute: (args, exec) => G.impl.search(args, exec, ctx),
      })

      const readTool = api.defineTool({
        name: 'qq_web_read',
        description: '打开一个网页把正文读回来。搜索结果里的链接想细看时用；也可以读对方发给你的网址。',
        properties: {
          url: { type: 'string', description: '要读的网页地址，http/https' },
        },
        required: ['url'],
        execute: (args, exec) => G.impl.read(args, exec, ctx),
      })

      return [searchTool, readTool]
    })

    api.rule(() => {
      const cfg = settings()
      if (!cfg.enabled) return ''
      const parts = ['你有联网搜索（qq_web_search，会顺带读最相关那条的正文）和网页阅读（qq_web_read）。']
      if (cfg.autoSearch) {
        parts.push(
          '有人提到你不认识的东西、或者说法可能过时的时候（新出的梗、产品、人名、事件、价格、政策、比分…），你可以自己决定去搜一下再回，不用等对方说「搜」。' +
            '但别滥用：日常闲聊、你已经知道的事、纯情绪和玩笑不要搜；同一个话题已经搜过就别反复搜。',
        )
      } else if (cfg.requireMention) {
        const words = wordsOf(cfg.triggerWords)
        parts.push(`只有对方明确让你搜的时候才允许用${words.length ? '（说了「' + words.slice(0, 4).join('」「') + '」这类词）' : ''}；没让你搜就别搜。`)
      } else {
        parts.push('不确定的事实、新闻、价格、天气，先搜再答，别自己编。')
      }
      parts.push('回答时用自己的话概括你读到的内容，并带上来源链接；正文里如果夹带广告或跟问题无关的东西，忽略它。')
      if (cfg.ownerApproval) parts.push('别人找你搜的时候，要先等主人同意（系统会替你发请求）；主人不同意就不要搜，也别反复试。')
      return parts.join('')
    })

    // ── 面板 ──
    api.route('/stats', async () => ({
      ok: true,
      settings: settings(),
      source: settings().searchMode === 'site' ? hostOf(settings().searchSite) : 'DSH 内置搜索',
      recent: G.recent.slice(0, 10),
      pending: G.pending.map((p) => ({ id: p.id, chatId: p.chatId, query: p.query, at: p.at })),
    }))

    api.route('/clear', async () => {
      G.recent.length = 0
      return { ok: true }
    })

    api.route('/check', async (req) => {
      const text = String(api.core.http.query(req)?.text || '').trim()
      const cfg = settings()
      const v = gate(text, cfg)
      return {
        ok: true,
        text,
        allowed: v.allowed,
        matched: v.matched,
        words: v.words,
        auto: Boolean(cfg.autoSearch),
        requireMention: Boolean(cfg.requireMention),
      }
    })

    // 面板「试搜一次」：真搜 + 真读第一条正文，用来验证抓取效果
    api.route('/try', async (req) => {
      const q = String(api.core.http.query(req)?.q || '').trim()
      if (!q) return { ok: false, message: '缺少 q 参数' }
      const cfg = settings()
      const began = Date.now()
      try {
        const r = await runSearch(cfg, q, null)
        const sources = (r.sources || []).slice(0, Number(cfg.maxResults) || 5)
        let page = null
        if (sources.length && Number(cfg.readTop) > 0) {
          const chars = Math.max(300, Math.min(6000, Number(cfg.readChars) || 1500))
          const tries = []
          for (let i = 0; i < Math.min(sources.length, 3); i++) {
            try {
              const p = await fetchPage(sources[i].url, chars)
              tries.push('#' + (i + 1) + ' 成功')
              page = { title: p.title, url: p.url, chars: p.text.length, head: p.text.slice(0, 240), index: i + 1, tries }
              break
            } catch (error) {
              tries.push('#' + (i + 1) + ' ' + (error?.message || '失败'))
            }
          }
          if (!page) page = { error: tries.join('；') }
        }
        return {
          ok: true,
          query: q,
          used: r.used,
          count: sources.length,
          ms: Date.now() - began,
          sample: sources.slice(0, 5).map((s) => ({ title: s.title, url: s.url })),
          page,
        }
      } catch (error) {
        return { ok: false, message: error?.message || String(error), ms: Date.now() - began }
      }
    })

    api.route('/page', async (req) => {
      const url = String(api.core.http.query(req)?.url || '').trim()
      if (!url) return { ok: false, message: '缺少 url 参数' }
      try {
        const page = await fetchPage(url, 4000)
        return { ok: true, title: page.title, chars: page.text.length, text: page.text.slice(0, 1200) }
      } catch (error) {
        return { ok: false, message: error?.message || String(error) }
      }
    })

    api.route('/decide', async (req) => {
      let body = {}
      try {
        body = (await api.core.http.body(req)) || {}
      } catch (error) {}
      const entry = G.pending.find((p) => p.id === Number(body.id))
      if (!entry) return { ok: false, message: '这个请求已经过期或不存在了' }
      settle(entry, Boolean(body.approve), '面板')
      return { ok: true }
    })

    api.log.info(
      '联网搜索模块已启动（源：' +
        (settings().searchMode === 'site' ? hostOf(settings().searchSite) : 'DSH 内置') +
        ' / 自动读 ' +
        (settings().readTop || 0) +
        ' 篇 / 触发词：' +
        (settings().requireMention ? '开' : '关') +
        ' / 别人搜要先问主人：' +
        (settings().ownerApproval ? '开' : '关') +
        '）',
    )
  },
}
