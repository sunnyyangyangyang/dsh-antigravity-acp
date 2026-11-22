/**
 * 捕获官方进程打到 stderr 的 OAuth 授权链接。
 *
 * 背景：官方 ACP server 的交互式登录用 webbrowser.open 打开浏览器；在无浏览器
 * 环境（尤其本插件的严格 bwrap 沙箱）里它会失败，然后按官方实现把
 * "Open the following link to authenticate the ACP server: <URL>" 打到 stderr。
 * 插件出于脱敏原则（见 runtime/redact.ts）不把链接放进日志或界面，但交互式
 * 登录没有这个链接就无法完成。这里把首个匹配到的链接写到
 * ~/.gemini/antigravity-acp/login-url.txt（0600），日志只记路径、不记链接；
 * 用户在同一个 5 分钟窗口内把它复制到浏览器打开，loopback 回调即可完成登录
 * （沙箱与宿主共享网络命名空间，127.0.0.1 回调能落到沙箱内的官方进程）。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 授权链接落盘文件名。 */
export const AUTH_URL_FILE = 'login-url.txt'
/** 只认 Google OAuth 授权端点，避免把诊断里的其它 URL 当成登录链接。 */
const AUTH_URL_PATTERN = /https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?[^\s"'<>]+/g

/** 从一段 stderr 文本里取首个 Google OAuth 授权链接。 */
export function extractAuthUrl(text: string): string | undefined {
  AUTH_URL_PATTERN.lastIndex = 0
  return AUTH_URL_PATTERN.exec(text)?.[0]
}

/** 授权链接文件路径（与官方登录态同目录，沙箱内可写）。 */
export function authUrlPath(home: string = homedir()): string {
  return join(home, '.gemini', 'antigravity-acp', AUTH_URL_FILE)
}

/** 把授权链接写到 login-url.txt（0600），返回路径。 */
export async function recordAuthUrl(url: string, home: string = homedir()): Promise<string> {
  const path = authUrlPath(home)
  await mkdir(join(home, '.gemini', 'antigravity-acp'), { recursive: true, mode: 0o700 })
  await writeFile(path, url + '\n', { encoding: 'utf8', mode: 0o600 })
  return path
}

/** 需要的 stderr 读取能力（与 dsh-subprocess 的 SubprocessOutputReader 结构兼容）。 */
export interface AuthUrlStderrReader {
  readFrom(fromByte: number): { text: string; nextOffset: number }
}

/** 轮询 stderr 增量，发现授权链接就落盘；返回停止函数。 */
export function watchAuthUrl(
  stderr: AuthUrlStderrReader | undefined,
  options: {
    home?: string
    intervalMs?: number
    log?: (message: string) => void
    onUrl?: (url: string, path: string) => void
  } = {},
): () => void {
  if (!stderr) return () => undefined
  let offset = 0
  let stopped = false
  let found = false
  const timer = setInterval(() => {
    if (stopped || found) return
    try {
      const read = stderr.readFrom(offset)
      offset = read.nextOffset
      const url = extractAuthUrl(read.text)
      if (!url) return
      found = true
      void recordAuthUrl(url, options.home).then((path) => {
        options.log?.(`antigravity-acp: 授权链接已写入 ${path}（沙箱内不会自动打开浏览器，请在本次授权超时前复制到浏览器完成回调）`)
        options.onUrl?.(url, path)
      }).catch(() => undefined)
    } catch {
      // 进程已退出或读取失败：等下一次轮询或停止。
    }
  }, options.intervalMs ?? 500)
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
