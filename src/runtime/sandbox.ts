/**
 * Linux bwrap 沙箱：把官方 Antigravity ACP 进程关进严格白名单。
 *
 * 设计目标是「白名单内能活，白名单外看不见」：
 * - 只挂载运行所需的系统目录（/usr 只读、/etc 只读、发行版的 /bin /sbin /lib
 *   符号链接、systemd-resolved 的 stub 配置）与私有 /tmp；
 * - home 完全不挂载，只把 ~/.gemini（登录态）和可执行文件安装根 bind 回来；
 * - PID / IPC / UTS 与宿主隔离，能力全丢。
 *
 * 为什么不直接 --ro-bind / / 再遮蔽 home：bwrap 0.13 实测下，--ro-bind / / 之后
 * 同一棵树里的 --bind 仍然只读（bind 继承来源挂载的 RO 标志），而 remount-ro 也
 * 不再递归；白名单挂载从根上绕开这个坑，同时更小、更可审计。
 *
 * 边界（如实记录）：
 * - 网络保留：生成、额度与 OAuth 都要出网，域名级过滤不在这一层做。
 * - 系统目录只读且限于 /usr、/etc 与发行版必需符号链接；/home、/var、/opt、/srv
 *   等都不进沙箱。
 * - exebox（官方自带的终端沙箱）在 DSH 里用不到：内置工具经 enabledTools: [] 关闭。
 * - 退出沙箱只有两条：配置 sandbox: false，或环境变量 AGY_ACP_NO_SANDBOX=1（排障）。
 */
import { accessSync, constants as fsConstants, lstatSync, readlinkSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { delimiter, dirname, join, resolve } from 'node:path'

/** 沙箱不可用的错误码（llmError 沿用 AGY_* 前缀）。 */
export const AGY_SANDBOX_ERROR = {
  /** 需要沙箱但找不到可用的 bwrap；此时必须拒绝启动，不能悄悄降级成无沙箱。 */
  UNAVAILABLE: 'AGY_SANDBOX_UNAVAILABLE',
} as const

/** 覆盖 bwrap 可执行文件路径的环境变量。 */
export const BWRAP_PATH_ENV = 'AGY_ACP_BWRAP'
/** 紧急关闭沙箱的环境变量（值 1/true），等价于配置 sandbox: false。 */
export const SANDBOX_DISABLE_ENV = 'AGY_ACP_NO_SANDBOX'

/** 只读探测某个路径是否存在（测试可注入）。 */
export type PathExists = (path: string) => boolean

/** 宿主文件系统探针：是否存在 / 是否是符号链接、指向哪里。 */
export interface SandboxFsProbe {
  exists: PathExists
  /** 符号链接目标；不存在或不是链接时返回 undefined。 */
  readlink: (path: string) => string | undefined
}

/** 默认探测：存在且带执行位。 */
export function executableExists(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/** 默认文件系统探针（只读，无副作用）。 */
export function createSandboxFsProbe(): SandboxFsProbe {
  return {
    exists: (path) => {
      try {
        lstatSync(path)
        return true
      } catch {
        return false
      }
    },
    readlink: (path) => {
      try {
        return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : undefined
      } catch {
        return undefined
      }
    },
  }
}

/**
 * 解析 bwrap：AGY_ACP_BWRAP 优先，其次 PATH，最后常见安装位置。
 * 找不到时返回 undefined，由调用方决定拒绝启动。
 */
export function resolveBwrapPath(
  env: NodeJS.ProcessEnv = process.env,
  exists: PathExists = executableExists,
): string | undefined {
  const override = env[BWRAP_PATH_ENV]?.trim()
  if (override) return exists(override) ? override : undefined
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, 'bwrap')
    if (exists(candidate)) return candidate
  }
  for (const fallback of ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap']) {
    if (exists(fallback)) return fallback
  }
  return undefined
}

/**
 * 是否应当启用沙箱。非 Linux 一律不启用（macOS/Windows 没有 bwrap）；
 * Linux 默认启用，可由配置或环境变量关闭。
 */
export function sandboxRequested(
  config: { sandbox?: boolean | undefined },
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): boolean {
  const env = options.env ?? process.env
  const flag = env[SANDBOX_DISABLE_ENV]?.trim().toLowerCase()
  if (flag === '1' || flag === 'true') return false
  if ((options.platform ?? process.platform) !== 'linux') return false
  return config.sandbox ?? true
}

/** 沙箱需要的宿主路径；在沙箱内保持同名。 */
export interface SandboxPaths {
  /** 宿主 HOME；home 本身不挂载，只把 .gemini 与安装根 bind 回去。 */
  home: string
  /** 可执行文件安装根；TMPDIR（runtime 实例目录）在它下面。 */
  installRoot: string
  /** 官方进程工作目录（二进制所在目录），沙箱内用 --chdir 进入。 */
  cwd: string
}

export interface SandboxCommand extends SandboxPaths {
  /** bwrap 可执行文件路径。 */
  bwrapPath: string
  /** 官方 ACP server 可执行文件。 */
  executable: string
  /** 传给官方进程的参数（--uid= 等），原样放在 -- 之后。 */
  args?: readonly string[] | undefined
  /** 宿主文件系统探针，测试注入。 */
  probe?: SandboxFsProbe | undefined
}

/** 发行版把 /bin、/lib 等做成指向 /usr 的符号链接；沙箱里要原样重建。 */
const SYSTEM_SYMLINKS = ['/bin', '/sbin', '/lib', '/lib64'] as const

/**
 * 组装完整 argv：bwrap + 严格白名单挂载 + --chdir + -- 官方进程。
 *
 * 白名单：/usr（只读）、/etc（只读）、发行版系统符号链接、systemd-resolved 的
 * stub 目录（只读）、~/.gemini 与安装根（可写）、私有 /tmp、/dev、/proc。
 */
export function buildSandboxArgv(command: SandboxCommand): string[] {
  const probe = command.probe ?? createSandboxFsProbe()
  const home = resolve(command.home)
  const gemini = join(home, '.gemini')
  const installRoot = resolve(command.installRoot)
  if (!probe.exists('/usr')) throw new Error('宿主机缺少 /usr，无法为 ACP 沙箱提供只读系统目录')

  const argv: string[] = [
    command.bwrapPath,
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    '--ro-bind', '/usr', '/usr',
  ]
  if (probe.exists('/etc')) argv.push('--ro-bind', '/etc', '/etc')
  for (const path of SYSTEM_SYMLINKS) {
    const link = probe.readlink(path)
    if (link) argv.push('--symlink', link, path)
    else if (probe.exists(path)) argv.push('--ro-bind', path, path)
  }
  // systemd-resolved 的 stub 配置是 /etc/resolv.conf 的符号链接目标；缺了它 DNS 会断。
  const resolveDir = '/run/systemd/resolve'
  if (probe.exists(resolveDir)) argv.push('--ro-bind', resolveDir, resolveDir)
  // home 父目录给一个空的 tmpfs，再把两个可写子树 bind 上去，最后把遮蔽层
  // remount 成只读（--remount-ro 不递归，两个 bind 仍然可写）：沙箱进程即兴往
  // 家目录写文件只会撞 EROFS，不会在私有 tmpfs 里无限吃宿主内存。
  const homeParent = dirname(home)
  const maskHome = homeParent !== '/' && home !== '/' && probe.exists(homeParent)
  if (maskHome) argv.push('--tmpfs', homeParent)
  argv.push('--bind', gemini, gemini)
  argv.push('--bind', installRoot, installRoot)
  if (maskHome) argv.push('--remount-ro', homeParent)
  argv.push(
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--cap-drop', 'ALL',
    '--die-with-parent',
    '--new-session',
    '--chdir', command.cwd,
    '--',
    command.executable,
    ...(command.args ?? []),
  )
  return argv
}

/**
 * 建好 bind 源：~/.gemini 必须存在，否则 bwrap 直接报 source path 不存在。
 * 登录态与 acp_token.json 都落在这里，保持 0700。
 */
export async function prepareSandboxBinds(paths: SandboxPaths): Promise<void> {
  await mkdir(join(paths.home, '.gemini'), { recursive: true, mode: 0o700 })
}
