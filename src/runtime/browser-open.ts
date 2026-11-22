/**
 * 用宿主浏览器打开登录授权页。
 *
 * 为什么不由官方进程自己开：插件 spawn 官方进程时只显式转发最小环境（DSH 会
 * scrub 父环境），官方进程的 webbrowser.open 拿不到 DISPLAY / DBUS；再加上严格
 * bwrap 沙箱本来就不允许它拉起浏览器。于是改由插件（宿主进程，环境完整）经
 * ctx.subprocess 调宿主的 xdg-open / open 打开链接；官方进程仍留在沙箱里。
 *
 * 只转发打开浏览器必需的桌面会话变量，不把代理、凭据或 DSH_* 传出去。
 */
import { delimiter, dirname, join } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { executableExists } from './sandbox.js'
import type { PathExists } from './sandbox.js'

/** 桌面会话需要的环境变量（白名单）。 */
const FORWARD_ENV = [
  'PATH',
  'HOME',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'XAUTHORITY',
  'XDG_SESSION_TYPE',
  'XDG_CURRENT_DESKTOP',
  'XDG_DATA_DIRS',
  'LANG',
  'LC_ALL',
] as const

/** 只挑白名单键，空值丢弃。 */
export function browserOpenEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of FORWARD_ENV) {
    const value = env[key]
    if (typeof value === 'string' && value.length > 0) out[key] = value
  }
  return out
}

export interface BrowserOpener {
  /** 打开器可执行文件路径。 */
  binary: string
  /** 除 URL 外的固定参数。 */
  prefix: string[]
  env: Record<string, string>
}

/**
 * 解析平台的浏览器打开器：Linux 用 xdg-open（PATH 优先），macOS 用 open；
 * Windows 不自动打开（沙箱只在 Linux 启用，Windows 走系统默认即可）。
 */
export function resolveBrowserOpener(options: {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  exists?: PathExists
} = {}): BrowserOpener | undefined {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const exists = options.exists ?? executableExists
  if (platform === 'linux') {
    for (const dir of (env.PATH ?? '').split(delimiter)) {
      if (!dir) continue
      const candidate = join(dir, 'xdg-open')
      if (exists(candidate)) return { binary: candidate, prefix: [], env: browserOpenEnv(env) }
    }
    for (const candidate of ['/usr/bin/xdg-open', '/bin/xdg-open']) {
      if (exists(candidate)) return { binary: candidate, prefix: [], env: browserOpenEnv(env) }
    }
    return undefined
  }
  if (platform === 'darwin' && exists('/usr/bin/open')) {
    return { binary: '/usr/bin/open', prefix: [], env: browserOpenEnv(env) }
  }
  return undefined
}

export interface BrowserOpenDeps {
  subprocess: Pick<SubprocessRuntime, 'spawn'>
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  exists?: PathExists
  log?: (message: string) => void
}

/**
 * 启动宿主浏览器打开链接；返回是否已把打开器拉起来（不等待浏览器退出）。
 * 打开器缺失或 spawn 被拒时返回 false 并告警，不抛断登录流程。
 */
export function openAuthUrlInBrowser(url: string, deps: BrowserOpenDeps): boolean {
  const env = deps.env ?? process.env
  const opener = resolveBrowserOpener({ platform: deps.platform, env, exists: deps.exists })
  if (!opener) {
    deps.log?.('antigravity-acp: 未找到 xdg-open / open，无法自动打开授权页；请手动打开 ~/.gemini/antigravity-acp/login-url.txt 里的链接')
    return false
  }
  try {
    const handle = deps.subprocess.spawn({
      argv: [opener.binary, ...opener.prefix, url],
      cwd: dirname(opener.binary),
      env: opener.env,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 4 * 1024 },
        stderr: { maxBytes: 4 * 1024 },
      },
      graceMs: 2_000,
    })
    void handle.done.catch(() => undefined)
    return true
  } catch (error) {
    deps.log?.(`antigravity-acp: 调用宿主浏览器失败（${error instanceof Error ? error.message : String(error)}）；请手动打开 ~/.gemini/antigravity-acp/login-url.txt`)
    return false
  }
}
