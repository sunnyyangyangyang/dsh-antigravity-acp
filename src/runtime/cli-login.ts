/**
 * agy CLI 首次登录（设置页一键授权）。
 *
 * agy 的登录入口只有 `agy acp --login`：它打印 Google 授权链接并等 stdin 里的 code。
 * 这里把它包成可被设置页驱动的状态机：启动 → 抓链接并交给宿主浏览器 → 接收 code →
 * 校验登录态文件。进程本身不经沙箱执行（只是登录，不跑 agent），完成后 ACP/额度共用同一份
 * 凭证（~/.config/antigravity/plugin-secrets.json）。
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { cliEnv } from './agy-cli.js'
import { extractAuthUrl } from './auth-url.js'
import { redactSensitiveText } from './redact.js'

export type CliLoginPhase = 'idle' | 'starting' | 'waiting-code' | 'verifying' | 'signed-in' | 'failed' | 'cancelled'

export interface CliLoginSnapshot {
  phase: CliLoginPhase
  url?: string
  message: string
  updatedAt: string
}

export interface CliLoginOptions {
  subprocess: Pick<SubprocessRuntime, 'spawn'>
  resolveCliPath: () => string | undefined
  /** 宿主侧打开浏览器；返回是否已拉起打开器。 */
  openUrl?: (url: string) => boolean
  home?: () => string
  log?: (message: string) => void
  /** 等待授权链接出现的上限（毫秒）。 */
  startupTimeoutMs?: number
  /** 提交 code 后等待进程退出的上限（毫秒）。 */
  verifyTimeoutMs?: number
}

interface WritableLike {
  write?: (chunk: string) => unknown
}

export class CliLoginManager {
  private handle: SubprocessHandle | undefined
  private phase: CliLoginPhase = 'idle'
  private url: string | undefined
  private message = ''
  private updatedAt = new Date().toISOString()
  private stdoutOffset = 0
  private stderrOffset = 0
  private tail = ''
  private poll: ReturnType<typeof setInterval> | undefined
  private urlWaiters: Array<(url: string | undefined) => void> = []

  constructor(private readonly options: CliLoginOptions) {}

  snapshot(): CliLoginSnapshot {
    return { phase: this.phase, ...(this.url ? { url: this.url } : {}), message: this.message, updatedAt: this.updatedAt }
  }

  async start(): Promise<CliLoginSnapshot> {
    if (this.phase === 'waiting-code' || this.phase === 'verifying') return this.snapshot()
    this.stop()
    const cliPath = this.options.resolveCliPath()
    if (!cliPath) return this.fail('未找到 agy CLI：请先配置 agyCliPath，或把 agy 放进 PATH')
    this.phase = 'starting'
    this.url = undefined
    this.stdoutOffset = 0
    this.stderrOffset = 0
    this.tail = ''
    this.set('starting', '正在启动 agy acp --login…')
    try {
      this.handle = this.options.subprocess.spawn({
        argv: [cliPath, 'acp', '--login'],
        cwd: dirname(cliPath),
        env: cliEnv(process.env),
        stdio: { stdin: 'pipe', stdout: { maxBytes: 256 * 1024 }, stderr: { maxBytes: 256 * 1024 } },
        graceMs: 3_000,
      })
    } catch (error) {
      return this.fail('启动 agy 登录失败：' + redactSensitiveText(error instanceof Error ? error.message : String(error)))
    }
    this.poll = setInterval(() => this.scan(), 250)
    const url = await this.waitForUrl(this.options.startupTimeoutMs ?? 15_000)
    if (!url) {
      this.stop()
      return this.fail('未从 agy 输出里识别到授权链接；可在终端手动运行 agy acp --login')
    }
    const opened = this.options.openUrl?.(url) ?? false
    this.set('waiting-code', opened
      ? '已在浏览器打开授权页；完成后把页面上的 code 粘贴到下方并提交'
      : '请打开上方授权链接；完成后把页面上的 code 粘贴到下方并提交')
    return this.snapshot()
  }

  async submit(code: string): Promise<CliLoginSnapshot> {
    if (!this.handle || this.phase !== 'waiting-code') return this.fail('当前没有等待输入的登录流程')
    const trimmed = code.trim()
    if (!trimmed) return this.snapshot()
    try {
      (this.handle.stdin as unknown as WritableLike | undefined)?.write?.(trimmed + '\n')
    } catch (error) {
      return this.fail('写入登录进程失败：' + redactSensitiveText(error instanceof Error ? error.message : String(error)))
    }
    this.set('verifying', '正在校验授权码…')
    const handle = this.handle
    await Promise.race([
      handle.done.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, this.options.verifyTimeoutMs ?? 30_000)),
    ])
    if (this.secretExists()) {
      this.stop()
      this.set('signed-in', 'agy CLI 登录成功，ACP 与额度会共用这份登录态')
      return this.snapshot()
    }
    const tail = redactSensitiveText(this.tail).slice(-300)
    this.stop()
    return this.fail('登录未完成' + (tail ? '：' + tail : '（未找到登录态文件）'))
  }

  async cancel(): Promise<CliLoginSnapshot> {
    this.stop()
    this.set('cancelled', '登录已取消')
    return this.snapshot()
  }

  private fail(message: string): CliLoginSnapshot {
    this.set('failed', message)
    return this.snapshot()
  }

  private set(phase: CliLoginPhase, message: string): void {
    this.phase = phase
    this.message = message
    this.updatedAt = new Date().toISOString()
    const waiters = this.urlWaiters
    this.urlWaiters = []
    for (const resolve of waiters) resolve(this.url)
  }

  private scan(): void {
    const handle = this.handle
    if (!handle) return
    try {
      const out = handle.collected.stdout?.readFrom(this.stdoutOffset)
      if (out) { this.stdoutOffset = out.nextOffset; this.consider(out.text) }
      const err = handle.collected.stderr?.readFrom(this.stderrOffset)
      if (err) { this.stderrOffset = err.nextOffset; this.tail = (this.tail + err.text).slice(-4000); this.consider(err.text) }
    } catch {
      // 进程已退出等：忽略本轮。
    }
  }

  private consider(text: string): void {
    if (this.url) return
    this.url = extractAuthUrl(text)
  }

  private waitForUrl(ms: number): Promise<string | undefined> {
    if (this.url) return Promise.resolve(this.url)
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), ms)
      this.urlWaiters.push((url) => { clearTimeout(timer); resolve(url) })
    })
  }

  private secretExists(): boolean {
    const home = this.options.home?.() ?? homedir()
    return existsSync(join(home, '.config', 'antigravity', 'plugin-secrets.json'))
      || existsSync(join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'))
  }

  private stop(): void {
    if (this.poll) clearInterval(this.poll)
    this.poll = undefined
    const handle = this.handle
    this.handle = undefined
    try { handle?.terminate?.() } catch { /* 进程可能已退出 */ }
  }
}
