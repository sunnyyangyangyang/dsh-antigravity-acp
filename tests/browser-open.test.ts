/**
 * 宿主浏览器打开授权页的纯逻辑测试：环境白名单、打开器解析、spawn 参数。
 */
import { describe, expect, it, vi } from 'vitest'
import { browserOpenEnv, openAuthUrlInBrowser, resolveBrowserOpener } from '../src/runtime/browser-open.js'

describe('browserOpenEnv', () => {
  it('只转发桌面会话白名单，丢弃空值与无关变量', () => {
    const env = browserOpenEnv({
      DISPLAY: ':0',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      PATH: '/usr/bin',
      LANG: 'C',
      HTTPS_PROXY: 'http://proxy',
      DSH_TOKEN: 'secret',
    })
    expect(env).toEqual({ DISPLAY: ':0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', PATH: '/usr/bin', LANG: 'C' })
    expect(env.HTTPS_PROXY).toBeUndefined()
    expect(browserOpenEnv({ DISPLAY: '' })).toEqual({})
  })
})

describe('resolveBrowserOpener', () => {
  it('Linux 先按 PATH 找 xdg-open，再兜底 /usr/bin', () => {
    const pathOpener = resolveBrowserOpener({
      platform: 'linux',
      env: { PATH: '/opt/bin:/usr/bin', DISPLAY: ':0' },
      exists: (path) => path === '/opt/bin/xdg-open',
    })
    expect(pathOpener?.binary).toBe('/opt/bin/xdg-open')
    expect(pathOpener?.env.DISPLAY).toBe(':0')

    const fallback = resolveBrowserOpener({ platform: 'linux', env: { PATH: '' }, exists: (path) => path === '/usr/bin/xdg-open' })
    expect(fallback?.binary).toBe('/usr/bin/xdg-open')
    expect(resolveBrowserOpener({ platform: 'linux', env: { PATH: '' }, exists: () => false })).toBeUndefined()
  })

  it('macOS 用 open，Windows 不自动打开', () => {
    expect(resolveBrowserOpener({ platform: 'darwin', env: {}, exists: (path) => path === '/usr/bin/open' })?.binary).toBe('/usr/bin/open')
    expect(resolveBrowserOpener({ platform: 'win32', env: {}, exists: () => true })).toBeUndefined()
  })
})

describe('openAuthUrlInBrowser', () => {
  it('把 URL 交给打开器，并带上桌面会话环境', () => {
    const specs: Array<{ argv: string[]; env: Record<string, string> }> = []
    const subprocess = {
      spawn: (spec: { argv: string[]; env: Record<string, string> }) => {
        specs.push(spec)
        return { done: Promise.resolve({ exitCode: 0, signal: null }) }
      },
    }
    const url = 'https://accounts.google.com/o/oauth2/v2/auth?x=1'
    const started = openAuthUrlInBrowser(url, {
      subprocess: subprocess as never,
      env: { PATH: '/opt/bin', DISPLAY: ':0', HOME: '/home/u' },
      platform: 'linux',
      exists: (path) => path === '/opt/bin/xdg-open',
    })
    expect(started).toBe(true)
    expect(specs).toHaveLength(1)
    expect(specs[0]!.argv).toEqual(['/opt/bin/xdg-open', url])
    expect(specs[0]!.env.DISPLAY).toBe(':0')
    expect(specs[0]!.env.HTTPS_PROXY).toBeUndefined()
  })

  it('没有打开器时返回 false，并提示手动打开 login-url.txt', () => {
    const logs: string[] = []
    const started = openAuthUrlInBrowser('https://accounts.google.com/x', {
      subprocess: { spawn: vi.fn() } as never,
      env: {},
      platform: 'linux',
      exists: () => false,
      log: (message) => logs.push(message),
    })
    expect(started).toBe(false)
    expect(logs.join('\n')).toContain('login-url.txt')
  })

  it('spawn 抛错时不打断登录流程', () => {
    const started = openAuthUrlInBrowser('https://accounts.google.com/x', {
      subprocess: { spawn: () => { throw new Error('denied') } } as never,
      env: { PATH: '/opt/bin' },
      platform: 'linux',
      exists: (path) => path === '/opt/bin/xdg-open',
    })
    expect(started).toBe(false)
  })
})
