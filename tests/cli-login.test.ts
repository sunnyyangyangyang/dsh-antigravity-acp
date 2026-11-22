/**
 * CliLoginManager：从沙箱内 agy 的输出里抓授权链接、回填 code、判定登录态。
 * 用假 subprocess，不启动真实进程。
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CliLoginManager } from '../src/runtime/cli-login.js'

const STREAM = 'Open this link in a browser:\n\nhttps://accounts.google.com/o/oauth2/auth?client_id=abc&state=xyz\n\nThen paste the code:\n'

function fakeSpawn(outputs: string[]) {
  let reads = 0
  const written: string[] = []
  const handle = {
    stdin: { write: (chunk: string) => { written.push(chunk); return true } },
    collected: {
      stdout: { readFrom: (offset: number) => { const text = outputs[reads] ?? ''; reads += 1; return { text, nextOffset: offset + text.length } } },
      stderr: { readFrom: (offset: number) => ({ text: '', nextOffset: offset }) },
    },
    done: new Promise(() => {}),
    terminate: () => undefined,
  }
  return { handle, written }
}

describe('CliLoginManager', () => {
  it('抓到链接后立刻返回并打开浏览器', async () => {
    const { handle } = fakeSpawn(['', '', STREAM])
    const openUrl = vi.fn(() => true)
    const manager = new CliLoginManager({
      subprocess: { spawn: () => handle as never },
      resolveCliPath: () => '/fake/agy',
      openUrl,
      startupTimeoutMs: 3_000,
    })
    const snapshot = await manager.start()
    expect(snapshot.phase).toBe('waiting-code')
    expect(snapshot.url).toContain('accounts.google.com/o/oauth2/auth')
    expect(openUrl).toHaveBeenCalledTimes(1)
    await manager.cancel()
  })

  it('找不到 agy 时给出可读错误，不 spawn', async () => {
    const spawn = vi.fn()
    const manager = new CliLoginManager({ subprocess: { spawn: spawn as never }, resolveCliPath: () => undefined })
    const snapshot = await manager.start()
    expect(snapshot.phase).toBe('failed')
    expect(snapshot.message).toContain('agy')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('提交 code 后按登录态文件判定成功', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agy-cli-login-'))
    try {
      const { handle, written } = fakeSpawn(['', STREAM])
      // done 立即完成，模拟 code 被接受后进程退出
      handle.done = Promise.resolve({ exitCode: 0, signal: null })
      const manager = new CliLoginManager({
        subprocess: { spawn: () => handle as never },
        resolveCliPath: () => '/fake/agy',
        openUrl: () => true,
        startupTimeoutMs: 3_000,
        verifyTimeoutMs: 2_000,
        home: () => home,
      })
      await manager.start()
      await mkdir(join(home, '.config', 'antigravity'), { recursive: true })
      await writeFile(join(home, '.config', 'antigravity', 'plugin-secrets.json'), '{}')
      const snapshot = await manager.submit('4/0Abc')
      expect(written.join('')).toContain('4/0Abc')
      expect(snapshot.phase).toBe('signed-in')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
