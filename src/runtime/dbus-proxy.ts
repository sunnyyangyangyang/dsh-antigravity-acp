/**
 * 临时 keyring 代理：给沙箱内的 agy 登录进程一条**只放行 org.freedesktop.secrets**
 * 的 D-Bus 通道（xdg-dbus-proxy），用完即销毁。
 *
 * 为什么不直接 bind $XDG_RUNTIME_DIR/bus：那等于把整个用户会话总线交给这个二进制
 * （可 talk 到任意服务）。代理只放行 Secret Service，登录结束随进程回收；socket 放在
 * ~/.gemini/antigravity-cli 下，沙箱本来就把该目录可写 bind 进去。
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

export interface KeyringProxy {
  /** 注入给登录进程的环境（DBUS_SESSION_BUS_ADDRESS / XDG_RUNTIME_DIR）。 */
  env: Record<string, string>
  cleanup: () => void
}

function findProxyBinary(env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, 'xdg-dbus-proxy')
    if (existsSync(candidate)) return candidate
  }
  for (const fallback of ['/usr/bin/xdg-dbus-proxy', '/bin/xdg-dbus-proxy']) {
    if (existsSync(fallback)) return fallback
  }
  return undefined
}

export async function startKeyringProxy(options: {
  subprocess: Pick<SubprocessRuntime, 'spawn'>
  home: string
  env?: NodeJS.ProcessEnv
  log?: (message: string) => void
}): Promise<KeyringProxy | undefined> {
  const env = options.env ?? process.env
  const bus = env.DBUS_SESSION_BUS_ADDRESS?.trim()
  if (!bus) {
    options.log?.('antigravity-acp: 没有 DBUS_SESSION_BUS_ADDRESS，登录退回文件型 secret 存储')
    return undefined
  }
  const binary = findProxyBinary(env)
  if (!binary) {
    options.log?.('antigravity-acp: 未找到 xdg-dbus-proxy，登录退回文件型 secret 存储')
    return undefined
  }
  const dir = join(options.home, '.gemini', 'antigravity-cli')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const socket = join(dir, 'keyring-bus.sock')
  try { rmSync(socket, { force: true }) } catch { /* 残留 socket 忽略 */ }
  let handle: SubprocessHandle | undefined
  try {
    handle = options.subprocess.spawn({
      argv: [binary, '--filter', '--talk=org.freedesktop.secrets', bus, socket],
      cwd: dirname(binary),
      env: {
        PATH: env.PATH ?? '',
        HOME: options.home,
        ...(env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR } : {}),
      },
      stdio: { stdin: 'ignore', stdout: { maxBytes: 16 * 1024 }, stderr: { maxBytes: 16 * 1024 } },
      graceMs: 1_000,
    })
  } catch (error) {
    options.log?.('antigravity-acp: 启动 keyring 代理失败：' + (error instanceof Error ? error.message : String(error)))
    return undefined
  }
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (existsSync(socket)) {
      const running = handle
      return {
        env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=' + socket, XDG_RUNTIME_DIR: dir },
        cleanup: () => { try { running.terminate() } catch { /* 已退出 */ } },
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  try { handle.terminate() } catch { /* 已退出 */ }
  return undefined
}
