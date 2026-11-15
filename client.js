/**
 * dsh-PEC client half: one Settings section that shows how the phone connects.
 *
 * The gateway port is injected into index.html by the host half
 * (`window.__CCDSH__`), so this panel always talks to the right port, and the
 * request is loopback-owned, which the gateway treats as the PC owner.
 */
window.__ModuleLoader__.load({
  id: 'dsh-pec',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const styles = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 0' },
      card: {
        border: '1px solid var(--dsh-border, #2a3550)',
        borderRadius: 12,
        padding: 14,
        background: 'var(--dsh-surface, transparent)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      },
      label: { fontSize: 12, opacity: 0.6, letterSpacing: '0.02em' },
      code: {
        fontSize: 30,
        letterSpacing: '0.18em',
        fontWeight: 600,
        fontFamily: 'ui-monospace, Consolas, monospace',
      },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      mono: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12, opacity: 0.85, wordBreak: 'break-all' },
      button: {
        border: '1px solid var(--dsh-border, #2a3550)',
        background: 'transparent',
        color: 'inherit',
        borderRadius: 8,
        padding: '6px 12px',
        cursor: 'pointer',
        fontSize: 12,
      },
      dim: { fontSize: 12, opacity: 0.6 },
    }

    function useStatus() {
      const [status, setStatus] = React.useState(null)
      const [error, setError] = React.useState('')
      const load = React.useCallback(async () => {
        try {
          const base = window.__CCDSH__ && window.__CCDSH__.origin ? window.__CCDSH__.origin : 'http://127.0.0.1:7317'
          const response = await fetch(`${base}/api/server`, { credentials: 'omit' })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const data = await response.json()
          // The compatibility probe rides along; a failure here must not hide the
          // pairing panel, so it is optional.
          try {
            const probe = await fetch(`${base}/api/health`, { credentials: 'omit' })
            data.health = probe.ok ? await probe.json() : null
          } catch {
            data.health = null
          }
          setStatus(data)
          setError('')
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause))
        }
      }, [])
      React.useEffect(() => {
        load()
        const timer = setInterval(load, 15000)
        return () => clearInterval(timer)
      }, [load])
      return { status, error, reload: load }
    }

    function copy(text) {
      try {
        navigator.clipboard?.writeText(text)
      } catch {}
    }

    function Panel() {
      try {
        return renderPanel()
      } catch (cause) {
        // Never let this panel take the settings page down with it.
        return h('div', { style: styles.wrap }, [
          h('div', { style: styles.card }, [
            h('div', { style: styles.label }, '手机连接'),
            h('div', { style: styles.dim }, `面板渲染失败：${String(cause && cause.message ? cause.message : cause)}`),
          ]),
        ])
      }
    }

    function TunnelCard() {
      const origin = (window.__CCDSH__ && window.__CCDSH__.origin) || 'http://127.0.0.1:7317'
      const [tunnel, setTunnel] = React.useState(null)
      const [loadError, setLoadError] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [token, setToken] = React.useState('')
      const [binary, setBinary] = React.useState('')
      const [message, setMessage] = React.useState('')
      const inputStyle = { width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 8, border: '1px solid var(--dsh-border, #2a3550)', background: 'transparent', color: 'inherit', fontSize: 12 }
      const load = React.useCallback(async () => {
        try {
          const response = await fetch(origin + '/api/tunnel', { credentials: 'omit' })
          if (!response.ok) throw new Error('HTTP ' + response.status)
          setTunnel(await response.json())
          setLoadError('')
        } catch (cause) {
          setLoadError(String(cause && cause.message ? cause.message : cause))
        }
      }, [origin])
      React.useEffect(() => { load() }, [load])
      const act = async (action, extra) => {
        setBusy(action)
        setMessage('')
        try {
          const response = await fetch(origin + '/api/tunnel', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'omit',
            body: JSON.stringify(Object.assign({ action }, extra || {})),
          })
          const data = await response.json()
          if (!response.ok || (data.ok === false && data.error)) throw new Error(data.error || ('HTTP ' + response.status))
          await load()
          setMessage(action === 'install' ? '服务已安装并启动。' : data.status && data.status.running ? '隧道已开启，异地可通过域名访问。' : '隧道已关闭，仅局域网/内网可达。')
        } catch (cause) {
          setMessage('操作失败：' + String(cause && cause.message ? cause.message : cause))
          load()
        } finally {
          setBusy('')
        }
      }
      if (loadError && !tunnel) {
        return h('div', { style: styles.card }, [
          h('div', { style: styles.label }, 'Cloudflare 隧道（异地访问）'),
          h('div', { style: styles.dim }, '状态读取失败（' + loadError + '）。未安装 cloudflared 服务时属正常，安装方法见 docs/tunnel.md。'),
        ])
      }
      if (!tunnel) return null
      return h('div', { style: styles.card }, [
        h('div', { style: styles.label }, 'Cloudflare 隧道（异地访问）'),
        !tunnel.available
          ? h('div', null, [
              h('div', { style: styles.dim }, '未检测到 cloudflared 服务。粘贴 Cloudflare 面板的安装 Token 与程序路径，一键安装为 Windows 服务：'),
              h('input', { style: inputStyle, placeholder: '粘贴安装 Token（eyJ…）', value: token, onInput: (event) => setToken(event.target.value) }),
              h('input', { style: Object.assign({}, inputStyle, { marginTop: 6 }), placeholder: 'cloudflared.exe 完整路径（如 C:\\Tools\\cloudflared\\cloudflared.exe）', value: binary, onInput: (event) => setBinary(event.target.value) }),
              h('button', { style: Object.assign({}, styles.button, { marginTop: 8 }), disabled: busy === 'install' || !token || !binary, onClick: () => act('install', { token, binary }) }, busy === 'install' ? '安装中…' : '安装为 Windows 服务并启动'),
            ])
          : h('div', null, [
              h('div', { style: styles.row, marginTop: 6 }, [
                h('div', { style: styles.dim }, '状态：' + (tunnel.running ? '运行中（异地可通过域名访问）' : '已停止（仅局域网/内网可达）')),
                h('button', { style: styles.button, disabled: Boolean(busy) || tunnel.busy, onClick: () => act(tunnel.running ? 'stop' : 'start') }, busy === 'start' || busy === 'stop' ? '处理中…' : tunnel.running ? '关闭隧道' : '开启隧道'),
              ]),
            ]),
        message ? h('div', { style: styles.dim, marginTop: 6 }, message) : null,
      ])
    }
    function RecoveryCard() {
      const origin = (window.__CCDSH__ && window.__CCDSH__.origin) || 'http://127.0.0.1:7317'
      const [code, setCode] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const generate = async () => {
        setBusy(true)
        try {
          const response = await fetch(origin + '/api/recovery', { credentials: 'omit' })
          const data = await response.json()
          setCode(data.code || '')
        } finally { setBusy(false) }
      }
      const clear = async () => {
        setBusy(true)
        try {
          await fetch(origin + '/api/recovery', { method: 'DELETE', credentials: 'omit' })
          setCode('')
        } finally { setBusy(false) }
      }
      return h('div', { style: styles.card }, [
        h('div', { style: styles.label }, '恢复码（异地重新配对用）'),
        code
          ? h('div', null, [
              h('div', { style: styles.code }, code),
              h('div', { style: styles.dim }, '截图保存或抄下来。手机令牌丢失时，在配对页输入它即可免看电脑重新配对。此码使用一次后自动更换。'),
              h('div', { style: styles.row, marginTop: 6 }, [
                h('button', { style: styles.button, onClick: () => copy(code) }, '复制'),
                h('button', { style: styles.button, onClick: clear }, '删除恢复码'),
              ]),
            ])
          : h('div', null, [
              h('div', { style: styles.dim }, '尚未设置。生成后截图保存——在异地手机令牌丢失时，凭它可重新配对，无需回到电脑前。'),
              h('button', { style: Object.assign({}, styles.button, { marginTop: 8 }), disabled: busy, onClick: generate }, busy ? '生成中…' : '生成恢复码'),
            ]),
      ])
    }
    function renderPanel() {
      const { status, error, reload } = useStatus()
      if (error) {
        return h('div', { style: styles.wrap }, [
          h('div', { style: styles.card }, [
            h('div', { style: styles.label }, '手机网关'),
            h('div', { style: styles.dim }, `没有连上网关（${error}）。`),
            h('button', { style: styles.button, onClick: reload }, '重试'),
          ]),
        ])
      }
      if (!status) return h('div', { style: styles.dim }, '正在读取网关状态…')

      const urls = status.urls || []
      const lan = urls.find((entry) => entry.kind === 'lan' && !entry.url.includes('127.0.0.1'))
      const tail = urls.find((entry) => entry.kind === 'tailscale')
      const code = status.pairing ? status.pairing.value : ''

      return h('div', { style: styles.wrap }, [
        h(TunnelCard),
        h(RecoveryCard),
        status.health && !status.health.ok
          ? h('div', { style: styles.card }, [
              h('div', { style: styles.label }, '兼容性'),
              h('div', { style: styles.dim }, `当前 DSH 缺少：${(status.health.missing || []).join('、') || '未知'}。相关功能不可用，其余正常；更新插件通常即可恢复。`),
            ])
          : null,
        h('div', { style: styles.card }, [
          h('div', { style: styles.label }, '手机配对码'),
          h('div', { style: styles.code }, code || '—'),
          h('div', { style: styles.dim }, '在手机 App 里输入这 6 位数字。码每 10 分钟自动更换，用过一次即失效。'),
        ]),
        h('div', { style: styles.card }, [
          h('div', { style: styles.label }, '连接地址'),
          lan ? h('div', { style: styles.mono }, `局域网：${lan.url}`) : null,
          tail ? h('div', { style: styles.mono }, `异地（Tailscale）：${tail.url}`) : null,
          h('div', { style: styles.row, marginTop: 6 }, [
            h('button', {
              style: styles.button,
              onClick: () => copy(lan ? lan.url : urls[0] ? urls[0].url : ''),
            }, '复制地址'),
            h('button', {
              style: styles.button,
              onClick: async () => {
                await fetch(`${(window.__CCDSH__ && window.__CCDSH__.origin) || 'http://127.0.0.1:7317'}/api/pairing/rotate`, { method: 'POST' })
                reload()
              },
            }, '换一个配对码'),
          ]),
          h('div', { style: styles.dim }, '手机和电脑在同一个 Wi-Fi 时用局域网地址；在外面先连上电脑的 Tailscale，再用异地地址。'),
        ]),
        h('div', { style: styles.card }, [
          h('div', { style: styles.label }, `已配对的手机（${(status.devices || []).length}）`),
          (status.devices || []).length === 0
            ? h('div', { style: styles.dim }, '还没有手机配对。')
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
                (status.devices || []).map((device) => h(DeviceRow, { key: device.id, device, reload }))),
        ]),
      ])
    }

    /** One paired phone: rename inline, remove, and show when it was added. */
    function DeviceRow({ device, reload }) {
      const [editing, setEditing] = React.useState(false)
      const [draft, setDraft] = React.useState(device.name || '')

      const save = async () => {
        const name = draft.trim()
        setEditing(false)
        if (!name || name === device.name) return
        await fetch(`${origin()}/api/devices/rename`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: device.id, name }),
        })
        reload()
      }

      const remove = async () => {
        await fetch(`${origin()}/api/devices/revoke`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: device.id }),
        })
        reload()
      }

      const meta = [device.platform, device.createdAt ? `配对于 ${new Date(device.createdAt).toLocaleString()}` : '']
        .filter(Boolean)
        .join(' · ')

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } }, [
        h('div', { style: styles.row }, [
          editing
            ? h('input', {
                autoFocus: true,
                value: draft,
                onChange: (event) => setDraft(event.target.value),
                onBlur: save,
                onKeyDown: (event) => {
                  if (event.key === 'Enter') save()
                  if (event.key === 'Escape') {
                    setDraft(device.name || '')
                    setEditing(false)
                  }
                },
                style: {
                  flex: 1,
                  background: 'transparent',
                  border: '1px solid var(--dsh-border, #2a3550)',
                  borderRadius: 8,
                  padding: '6px 8px',
                  color: 'inherit',
                  fontSize: 13,
                },
              })
            : h('div', { style: { flex: 1 } }, device.name || '手机'),
          h('button', { style: styles.button, onClick: () => (editing ? save() : setEditing(true)) }, editing ? '保存' : '重命名'),
          h('button', { style: styles.button, onClick: remove }, '移除'),
        ]),
        meta ? h('div', { style: styles.dim }, meta) : null,
      ])
    }

    const origin = () => (window.__CCDSH__ && window.__CCDSH__.origin) || 'http://127.0.0.1:7317'

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'dsh-pec-phone', order: 92, label: '手机连接' },
            Panel,
          ),
        )
      },
    }
  },
})
