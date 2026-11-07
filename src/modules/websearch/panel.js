// 联网搜索 · 面板
// 写法对齐内置页（表情包 / 主动搭话那些）：Card 分组、Row 一行一项、
// Btn/Empty 用面板自带组件，只用已有的样式类，不自己拼内联 flex。
// 面板把整个文件当函数体执行（传入 React / h / ui / call），最后 return 一个组件。
const { useState, useEffect, useRef } = React

const fmt = (t) => {
  try {
    const d = new Date(t)
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':')
  } catch (error) {
    return '—'
  }
}

return function Panel({ settings, toast }) {
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)
  const [probe, setProbe] = useState('')
  const [verdict, setVerdict] = useState(null)
  const [query, setQuery] = useState('')
  const [trying, setTrying] = useState(false)
  const [trial, setTrial] = useState(null)
  const alive = useRef(true)

  const load = async (quiet) => {
    if (!quiet) setBusy(true)
    try {
      const r = await call('/stats')
      if (alive.current) setData(r)
    } catch (error) {
      if (!quiet) toast('读不到状态：' + (error.message || error), 'err')
    } finally {
      if (!quiet) setBusy(false)
    }
  }

  useEffect(() => {
    alive.current = true
    load()
    const timer = setInterval(() => load(true), 3000)
    return () => {
      alive.current = false
      clearInterval(timer)
    }
  }, [])

  const clear = async () => {
    try {
      await call('/clear', {})
      await load()
      toast('清空了', 'ok')
    } catch (error) {
      toast('清空失败：' + (error.message || error), 'err')
    }
  }

  const decide = async (id, approve) => {
    try {
      const r = await call('/decide', { id, approve })
      toast(r.ok === false ? r.message : approve ? '同意，让她去搜' : '拒绝了', r.ok === false ? 'err' : 'ok')
      await load()
    } catch (error) {
      toast('操作失败：' + (error.message || error), 'err')
    }
  }

  const test = async () => {
    const text = String(probe || '').trim()
    if (!text) return
    try {
      setVerdict(await call('/check?text=' + encodeURIComponent(text)))
    } catch (error) {
      toast('测不了：' + (error.message || error), 'err')
    }
  }

  const trySearch = async () => {
    const q = String(query || '').trim()
    if (!q) return
    setTrying(true)
    setTrial(null)
    try {
      setTrial(await call('/try?q=' + encodeURIComponent(q)))
    } catch (error) {
      toast('试搜失败：' + (error.message || error), 'err')
    } finally {
      setTrying(false)
    }
  }

  const s = (data && data.settings) || settings || {}
  const recent = (data && data.recent) || []
  const pending = (data && data.pending) || []
  const source = (data && data.source) || (s.searchMode === 'site' ? s.searchSite : 'DSH 内置搜索')
  const state = [
    s.enabled ? '已启用' : '已关闭',
    s.allowGroups ? '群聊可用' : '仅私聊',
    s.autoSearch ? '她可自主搜' : s.requireMention ? '要触发词' : '不限触发词',
    s.ownerApproval ? '别人搜先问你（' + (s.approvalTimeoutSec || 60) + ' 秒）' : '不审批',
    '自动读 ' + (s.readTop || 0) + ' 篇 / 每篇 ' + (s.readChars || 0) + ' 字',
    '每分钟 ' + s.perMinute + ' 次',
  ].join(' · ')

  return h(
    React.Fragment,
    null,

    pending.length
      ? h(
          ui.Card,
          { title: '等你同意（' + pending.length + '）', desc: '别人让她搜东西，得你点头才真的搜。也可以直接在 QQ 里回「同意」或「拒绝」。' },
          pending.map((p) =>
            h(
              ui.Row,
              { key: p.id, label: '#' + p.id + ' · ' + fmt(p.at) },
              h('span', { className: 'ab-badge' }, p.chatId),
              h('span', { className: 'ab-small' }, '想搜：' + p.query),
              h('div', { className: 'ab-spacer' }),
              h(ui.Btn, { small: true, kind: 'primary', onClick: () => decide(p.id, true) }, '同意'),
              h(ui.Btn, { small: true, onClick: () => decide(p.id, false) }, '拒绝'),
            ),
          ),
        )
      : null,

    h(
      ui.Card,
      {
        title: '最近搜索',
        desc: '她每真去搜一次就记一条；被触发词、审批或限流拦下的也会记。',
        right: h(ui.Btn, { small: true, onClick: () => load(), disabled: busy }, busy ? '读取中…' : '刷新'),
      },

      h(ui.Row, { label: '当前设置' }, h('span', { className: 'ab-small ab-muted' }, state)),
      h(ui.Row, { label: '搜索源' }, h('span', { className: 'ab-small ab-muted' }, source)),

      recent.length
        ? recent.map((r, i) =>
            h(
              ui.Row,
              { key: i, label: fmt(r.at) + ' · ' + r.chatId },
              h('span', { className: 'ab-small', style: { flex: 1, minWidth: 0 } }, r.query),
              r.ok ? h('span', { className: 'ab-small ab-muted' }, r.note || '成功') : h('span', { className: 'ab-note' }, r.note || '失败'),
            ),
          )
        : h(ui.Empty, { icon: '🔍', text: '还没搜过' }),

      recent.length
        ? h(
            'div',
            { className: 'ab-flex', style: { marginTop: 10 } },
            h('span', { className: 'ab-muted ab-small' }, '最近 ' + recent.length + ' 条'),
            h('div', { className: 'ab-spacer' }),
            h(ui.Btn, { small: true, onClick: clear }, '清空记录'),
          )
        : null,
    ),

    h(
      ui.Card,
      { title: '试搜一次', desc: '用当前设置真搜一次，顺带读第一条的正文。这是插件自己发的请求，不经过 QQ 会话。' },
      h(
        ui.Row,
        { label: '关键词' },
        h('input', {
          className: 'ab-input',
          placeholder: '例如：今天上海天气',
          value: query,
          onInput: (e) => setQuery(e.target.value),
          onKeyDown: (e) => {
            if (e.key === 'Enter') trySearch()
          },
        }),
        h(ui.Btn, { small: true, onClick: trySearch, disabled: trying }, trying ? '搜…' : '搜一下'),
      ),

      trial
        ? trial.ok
          ? h(
              'div',
              { className: 'ab-flex', style: { marginTop: 8 } },
              h('span', { className: 'ab-pill' }, (trial.used || source) + ' · ' + trial.count + ' 条 · ' + trial.ms + 'ms'),
              trial.page && !trial.page.error
                ? h('span', { className: 'ab-small ab-muted' }, '读了第 ' + trial.page.index + ' 条：' + trial.page.chars + ' 字')
                : null,
            )
          : h('div', { className: 'ab-note', style: { marginTop: 8 } }, '搜失败了：' + (trial.message || '未知错误'))
        : null,

      trial && trial.page && !trial.page.error
        ? h(
            'div',
            { className: 'ab-note', style: { marginTop: 8 } },
            h('div', { className: 'ab-small ab-muted', style: { marginBottom: 6 } }, trial.page.title || trial.page.url),
            h('div', { className: 'ab-small' }, (trial.page.head || '').slice(0, 300) + (trial.page.chars > 300 ? '…' : '')),
          )
        : null,

      trial && trial.page && trial.page.error ? h('div', { className: 'ab-note', style: { marginTop: 8 } }, '正文没读到：' + trial.page.error) : null,

      trial && trial.sample && trial.sample.length
        ? h(
            'div',
            { style: { marginTop: 8 } },
            trial.sample.map((x, i) => h('div', { key: i, className: 'ab-small ab-muted' }, i + 1 + '. ' + (x.title || x.url))),
          )
        : null,
    ),

    h(
      ui.Card,
      { title: '触发词检查', desc: '输入一句话，看现在这套规则会不会放她搜 —— 不用真发 QQ。' },
      h(
        ui.Row,
        { label: '试一句' },
        h('input', {
          className: 'ab-input',
          placeholder: '例如：帮我搜一下今天天气',
          value: probe,
          onInput: (e) => setProbe(e.target.value),
          onKeyDown: (e) => {
            if (e.key === 'Enter') test()
          },
        }),
        h(ui.Btn, { small: true, onClick: test }, '测一下'),
      ),
      verdict
        ? h(
            'div',
            { className: verdict.allowed ? 'ab-note' : 'ab-note err', style: { marginTop: 8 } },
            verdict.allowed
              ? '✓ 会放行' +
                  (verdict.auto
                    ? '（自主搜索开着，触发词不作为限制）'
                    : verdict.matched
                      ? '（命中「' + verdict.matched + '」）'
                      : verdict.requireMention
                        ? '（没配触发词，等于不限制）'
                        : '（没开限制）')
              : '✗ 会拦下（没有命中：' + verdict.words.join(' / ') + '）',
          )
        : null,
    ),
  )
}
