import { spawn } from 'node:child_process'

const SERVICE = 'cloudflared'

function runPs(command, timeoutMs) {
  const limit = timeoutMs || 15000
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true })
    let out = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill() } catch { /* already exited */ }
      resolve(result)
    }
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), limit)
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { out += chunk })
    child.on('error', (error) => finish({ ok: false, error: String(error.message || error), output: out }))
    child.on('close', (code) => finish({ ok: code === 0, code, output: out }))
  })
}

export class TunnelManager {
  constructor(log) {
    this.log = log
    this.busy = false
  }

  async status() {
    const probe = await runPs('$s = Get-Service -Name cloudflared -ErrorAction SilentlyContinue; $bin = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source; $svc = (Get-CimInstance Win32_Service -Filter \'Name=\"cloudflared\"\' -ErrorAction SilentlyContinue).PathName; [pscustomobject]@{ exists = [bool]$s; status = if ($s) { $s.Status.ToString() } else { \'\' }; startType = if ($s) { $s.StartType.ToString() } else { \'\' }; binary = if ($bin) { $bin } else { \'\' }; servicePath = if ($svc) { $svc } else { \'\' } } | ConvertTo-Json -Compress')
    let parsed = {}
    try { parsed = JSON.parse(probe.output || '{}') } catch { /* probe failed */ }
    return {
      available: Boolean(parsed.exists),
      running: parsed.status === 'Running',
      status: parsed.status || null,
      startType: parsed.startType || null,
      binary: parsed.binary || parsed.servicePath || null,
      busy: this.busy,
    }
  }

  async setRunning(run) {
    if (this.busy) return { ok: false, error: '操作正在进行中' }
    this.busy = true
    try {
      const verb = run ? 'Start-Service' : 'Stop-Service'
      const result = await runPs('try { ' + verb + ' -Name cloudflared -ErrorAction Stop; \'ok\' } catch { \'fail: \' + $_.Exception.Message }', 20000)
      if (!result.ok) return { ok: false, error: result.error || '服务操作超时' }
      const text = String(result.output || '')
      if (text.includes('fail:')) return { ok: false, error: text.split('fail:')[1].trim() }
      const state = await this.status()
      this.log?.info('cloudflared ' + (run ? 'started' : 'stopped') + ' -> ' + state.status)
      return { ok: state.running === run, status: state }
    } finally {
      this.busy = false
    }
  }

  async install(binaryPath, token) {
    if (this.busy) return { ok: false, error: '操作正在进行中' }
    if (!token || String(token).length < 20) return { ok: false, error: 'Token 无效' }
    const bin = String(binaryPath || '').trim()
    if (!/cloudflared\.exe['\"]?$/i.test(bin) || !/^[A-Za-z]:/.test(bin)) {
      return { ok: false, error: 'cloudflared.exe 路径无效' }
    }
    const safeToken = String(token).replace(/['\"\\]/g, '')
    this.busy = true
    try {
      const result = await runPs('& ' + JSON.stringify(bin) + ' service install ' + JSON.stringify(safeToken), 30000)
      if (!result.ok) return { ok: false, error: '安装失败：' + (result.error || result.output || '超时') }
      await runPs('Start-Service -Name cloudflared -ErrorAction SilentlyContinue')
      const state = await this.status()
      return { ok: true, status: state }
    } finally {
      this.busy = false
    }
  }
}
