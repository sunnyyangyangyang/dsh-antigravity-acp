/**
 * 授权链接捕获测试：从 stderr 文本取 Google OAuth 链接、落盘权限，
 * 以及轮询增量 stderr 的行为。
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AUTH_URL_FILE, authUrlPath, extractAuthUrl, recordAuthUrl, watchAuthUrl } from '../src/runtime/auth-url.js'

const SAMPLE = 'Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=abc&state=xyz\n'

describe('extractAuthUrl', () => {
  it('从官方 stderr 提示里取出授权链接', () => {
    expect(extractAuthUrl(SAMPLE)).toBe('https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=abc&state=xyz')
  })

  it('忽略非授权端点与普通 URL', () => {
    expect(extractAuthUrl('see https://example.com/docs')).toBeUndefined()
    expect(extractAuthUrl('https://oauth2.googleapis.com/token')).toBeUndefined()
    expect(extractAuthUrl('')).toBeUndefined()
  })
})

describe('recordAuthUrl', () => {
  it('写到 ~/.gemini/antigravity-acp/login-url.txt，权限 0600', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agy-auth-'))
    try {
      const path = await recordAuthUrl('https://accounts.google.com/o/oauth2/v2/auth?a=1', home)
      expect(path).toBe(authUrlPath(home))
      expect(path.endsWith(AUTH_URL_FILE)).toBe(true)
      expect((await readFile(path, 'utf8')).trim()).toBe('https://accounts.google.com/o/oauth2/v2/auth?a=1')
      if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('watchAuthUrl', () => {
  it('轮询增量 stderr，发现链接后落盘并回调一次', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agy-auth-watch-'))
    let reads = 0
    const reader = {
      readFrom(offset: number) {
        reads += 1
        if (reads < 2) return { text: '', nextOffset: offset }
        return { text: SAMPLE, nextOffset: offset + SAMPLE.length }
      },
    }
    let seen: { url: string; path: string } | undefined
    const stop = watchAuthUrl(reader, {
      home,
      intervalMs: 5,
      onUrl: (url, path) => { seen = { url, path } },
    })
    try {
      const deadline = Date.now() + 2000
      while (!seen && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
      expect(seen?.url).toContain('accounts.google.com/o/oauth2/v2/auth')
      expect((await readFile(seen!.path, 'utf8')).trim()).toBe(seen!.url)
      // 已经找到后不再重复落盘/回调。
      const seenAt = seen
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(seen).toBe(seenAt)
    } finally {
      stop()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('没有 stderr 读取能力时是空操作', () => {
    expect(() => watchAuthUrl(undefined)()).not.toThrow()
  })
})
