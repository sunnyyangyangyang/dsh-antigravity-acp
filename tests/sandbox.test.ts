/**
 * bwrap 沙箱测试：白名单 argv 组装、home 不挂载、系统符号链接重建、
 * 启用判定与 bwrap 解析。真实 bwrap 的隔离行为在本地烟测中验证，
 * 这里只保证纯函数契约，CI 没有 bwrap 也能跑。
 */
import { describe, expect, it } from 'vitest'
import {
  AGY_SANDBOX_ERROR,
  BWRAP_PATH_ENV,
  SANDBOX_DISABLE_ENV,
  buildSandboxArgv,
  resolveBwrapPath,
  sandboxRequested,
  sandboxSessionCwd,
} from '../src/runtime/sandbox.js'
import type { SandboxFsProbe } from '../src/runtime/sandbox.js'

const paths = {
  home: '/home/u',
  installRoot: '/home/u/.cache/dsh-antigravity-host',
  cwd: '/home/u/.cache/dsh-antigravity-host/1.4.0/extract-1.4.0',
}

const SYSTEM_LINKS = { '/bin': 'usr/bin', '/sbin': 'usr/sbin', '/lib': 'usr/lib', '/lib64': 'usr/lib64' }

/** 探针：existing 里的路径存在；links 里的路径是符号链接。 */
function probe(existing: readonly string[], links: Record<string, string> = SYSTEM_LINKS): SandboxFsProbe {
  return {
    exists: (path) => existing.includes(path) || Object.hasOwn(links, path),
    readlink: (path) => links[path],
  }
}

function argvOf(existing: readonly string[] = ['/usr', '/etc', '/sys', '/home', '/run/systemd/resolve']): string[] {
  return buildSandboxArgv({
    bwrapPath: '/usr/bin/bwrap',
    executable: paths.cwd + '/agy_acp_server.par',
    args: ['--uid='],
    probe: probe(existing),
    ...paths,
  })
}

describe('buildSandboxArgv', () => {
  it('白名单挂载：私有 /tmp、只读 /usr 与 /etc，从不用 --ro-bind / /', () => {
    const argv = argvOf()
    expect(argv.slice(0, 10)).toEqual([
      '/usr/bin/bwrap',
      '--dev', '/dev',
      '--proc', '/proc',
      '--tmpfs', '/tmp',
      '--ro-bind', '/usr', '/usr',
    ])
    expect(argv).not.toContain('/')
    expect(argv.slice(argv.indexOf('--ro-bind'), argv.indexOf('--ro-bind') + 3)).toEqual(['--ro-bind', '/usr', '/usr'])
    expect(argv).toContain('/etc')
    // tcmalloc 数 CPU 需要 /sys（只读），缺了官方进程会 CHECK abort。
    const sysAt = argv.indexOf('/sys')
    expect(argv.slice(sysAt - 1, sysAt + 2)).toEqual(['--ro-bind', '/sys', '/sys'])
  })

  it('发行版符号链接按目标重建；不是链接时退回只读 bind', () => {
    const argv = argvOf()
    expect(argv.slice(argv.indexOf('--symlink'), argv.indexOf('--symlink') + 3)).toEqual(['--symlink', 'usr/bin', '/bin'])
    expect(argv).toContain('/lib64')
    const oldStyle = buildSandboxArgv({
      bwrapPath: '/usr/bin/bwrap',
      executable: '/x/agy',
      probe: probe(['/usr', '/etc', '/bin'], {}),
      home: '/home/u',
      installRoot: '/home/u/.cache/x',
      cwd: '/home/u/.cache/x',
    })
    expect(oldStyle.filter((value) => value === '/bin')).toHaveLength(2)
    expect(oldStyle).not.toContain('--symlink')
  })

  it('home 只暴露 .gemini 与安装根，遮蔽层随后 remount 成只读', () => {
    const argv = argvOf()
    const binds: string[] = []
    argv.forEach((value, index) => {
      if (value === '--bind') binds.push(argv[index + 1]!)
    })
    expect(binds).toEqual(['/home/u/.gemini', paths.installRoot])
    expect(argv).not.toContain('/home/u')
    // 遮蔽层：/home 用空 tmpfs 顶掉，bind 完成后再 remount 成只读。
    expect(argv[argv.indexOf('--tmpfs', argv.indexOf('--tmpfs') + 1) + 1]).toBe('/home')
    const remount = argv.indexOf('--remount-ro')
    expect(argv[remount + 1]).toBe('/home')
    expect(remount).toBeGreaterThan(argv.lastIndexOf('--bind'))
  })

  it('systemd-resolved stub 目录存在才挂载（DNS 依赖它）', () => {
    expect(argvOf(['/usr', '/etc'])).not.toContain('/run/systemd/resolve')
    expect(argvOf(['/usr', '/etc', '/run/systemd/resolve'])).toContain('/run/systemd/resolve')
  })

  it('不 unshare 网络（生成与 OAuth 要出网），隔离 PID/IPC/UTS 并丢能力', () => {
    const argv = argvOf()
    expect(argv).not.toContain('--unshare-net')
    expect(argv).toContain('--unshare-pid')
    expect(argv).toContain('--unshare-ipc')
    expect(argv).toContain('--unshare-uts')
    expect(argv.slice(argv.indexOf('--cap-drop'), argv.indexOf('--cap-drop') + 2)).toEqual(['--cap-drop', 'ALL'])
  })

  it('用 --die-with-parent 与 --chdir，并把官方参数原样放在 -- 之后', () => {
    const argv = argvOf()
    expect(argv).toContain('--die-with-parent')
    expect(argv.slice(argv.indexOf('--chdir'), argv.indexOf('--chdir') + 2)).toEqual(['--chdir', paths.cwd])
    const separator = argv.indexOf('--')
    expect(separator).toBeGreaterThan(argv.indexOf('--chdir'))
    expect(argv.slice(separator + 1)).toEqual([paths.cwd + '/agy_acp_server.par', '--uid='])
  })

  it('宿主缺少 /usr 时直接报错，不产出半残 argv', () => {
    expect(() => buildSandboxArgv({
      bwrapPath: '/usr/bin/bwrap',
      executable: '/x/agy',
      probe: probe([]),
      home: '/home/u',
      installRoot: '/home/u/.cache/x',
      cwd: '/home/u/.cache/x',
    })).toThrow('/usr')
  })
})

describe('sandboxRequested', () => {
  it('Linux 默认开启，非 Linux 一律关闭', () => {
    expect(sandboxRequested({}, { platform: 'linux', env: {} })).toBe(true)
    expect(sandboxRequested({ sandbox: true }, { platform: 'linux', env: {} })).toBe(true)
    expect(sandboxRequested({}, { platform: 'darwin', env: {} })).toBe(false)
    expect(sandboxRequested({}, { platform: 'win32', env: {} })).toBe(false)
  })

  it('配置兜底关，紧急环境变量也关', () => {
    expect(sandboxRequested({ sandbox: false }, { platform: 'linux', env: {} })).toBe(false)
    expect(sandboxRequested({}, { platform: 'linux', env: { [SANDBOX_DISABLE_ENV]: '1' } })).toBe(false)
    expect(sandboxRequested({}, { platform: 'linux', env: { [SANDBOX_DISABLE_ENV]: 'true' } })).toBe(false)
    expect(sandboxRequested({}, { platform: 'linux', env: { [SANDBOX_DISABLE_ENV]: '0' } })).toBe(true)
  })
})

describe('resolveBwrapPath', () => {
  it('AGY_ACP_BWRAP 优先；不存在的覆盖值不回退到 PATH', () => {
    expect(resolveBwrapPath({ [BWRAP_PATH_ENV]: '/opt/bin/bwrap', PATH: '/usr/bin' }, (p) => ['/opt/bin/bwrap', '/usr/bin/bwrap'].includes(p))).toBe('/opt/bin/bwrap')
    expect(resolveBwrapPath({ [BWRAP_PATH_ENV]: '/missing/bwrap', PATH: '/usr/bin' }, (p) => p === '/usr/bin/bwrap')).toBeUndefined()
  })

  it('其次按 PATH 顺序找 bwrap，最后兜底常见位置', () => {
    expect(resolveBwrapPath({ PATH: '/a:/b' }, (p) => p === '/b/bwrap')).toBe('/b/bwrap')
    expect(resolveBwrapPath({ PATH: '' }, (p) => p === '/usr/bin/bwrap')).toBe('/usr/bin/bwrap')
    expect(resolveBwrapPath({ PATH: '' }, () => false)).toBeUndefined()
  })
})

it('extraReadOnlyBinds 把 CLI 目录只读挂进去，跳过重复与安装根内路径', () => {
  const cliDir = '/home/u/.dsh/cache/antigravity-cli/1.5.14'
  const argv = buildSandboxArgv({
    bwrapPath: '/usr/bin/bwrap',
    executable: cliDir + '/agy',
    args: ['acp'],
    home: '/home/u',
    installRoot: paths.installRoot,
    cwd: paths.installRoot + '/workspace',
    extraReadOnlyBinds: [cliDir, cliDir, paths.installRoot + '/1.4.0/extract-1.4.0'],
    probe: probe(['/usr', '/etc', '/home', '/sys', cliDir]),
  })
  const roBinds: string[] = []
  argv.forEach((value, index) => { if (value === '--ro-bind') roBinds.push(argv[index + 1]!) })
  expect(roBinds).toContain(cliDir)
  expect(roBinds.filter((path) => path === cliDir)).toHaveLength(1)
  expect(roBinds).not.toContain(paths.installRoot + '/1.4.0/extract-1.4.0')
})

it('沙箱会话工作目录落在安装根内（真实项目目录在沙箱里不可见）', () => {
  expect(sandboxSessionCwd('/home/u/.cache/dsh-antigravity-host')).toBe('/home/u/.cache/dsh-antigravity-host/workspace')
})

it('沙箱错误码沿用 AGY_ 前缀，便于日志区分', () => {
  expect(AGY_SANDBOX_ERROR.UNAVAILABLE).toBe('AGY_SANDBOX_UNAVAILABLE')
})
