import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { matchRoot, matchRootResolved } from '../src/host/chat-contracts.ts'
import type { StoredRoot } from '../src/host/database.ts'

/**
 * 授权根匹配的 realpath 归一（`matchRootResolved`）。
 *
 * 起因是 2026-11-27 CI 上 `workspaces` 帧返回空数组、fixture 对拍报「帧形状漂移」：
 * 授权根入库时（`roots.addRoot`）解析过符号链接，存的是**真实路径**；而内核给的
 * `workspace.path` / `session.cwd` 是它当初用的那个字符串，未必解析过。
 *
 * 两类机器上必然踩到：macOS 的 `/var/folders/…`（realpath 后是 `/private/var/…`）、
 * Windows 的 8.3 短名（`C:\Users\RUNNER~1\…`）。本机长名一致，所以只在 CI 现形。
 *
 * 这里用**目录符号链接**复现同一形状（Windows 上建 junction，不需要管理员权限）：
 * 根按真实路径入库，候选走别名路径 —— 旧的纯字符串比较必然失配。
 */

const base = mkdtempSync(join(tmpdir(), 'host-match-root-'))
const real = join(base, 'project')
const alias = join(base, 'alias')
mkdirSync(real)
try {
  symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir')
} catch {
  // 没有建符号链接的权限（容器/受限账户）：这组用例的前提不成立，直接跳过断言。
}

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

const root = (realPath: string): StoredRoot => ({ id: 'root-1', label: 'Project', realPath, createdAt: 0 })

describe('matchRootResolved', () => {
  it('候选是别名路径、根是真实路径时仍能匹配（纯字符串比较会漏）', async () => {
    const roots = [root(await realpath(real))]
    // 旧口径：一眼看得出为什么 CI 会红 —— 同一个目录，两条写法，比不到一起。
    expect(matchRoot(roots, alias)).toBeUndefined()
    const match = await matchRootResolved(roots, alias)
    expect(match?.root.id).toBe('root-1')
    expect(match?.relative).toBe('')
  })

  it('已在根内的子路径解析后仍然落在根内，相对路径不变', async () => {
    const roots = [root(await realpath(real))]
    const child = join(alias, 'sub')
    mkdirSync(join(real, 'sub'), { recursive: true })
    const match = await matchRootResolved(roots, child)
    expect(match?.root.id).toBe('root-1')
    expect(match?.relative).toBe('sub')
  })

  it('路径根本不存在时退回原串比较，不抛错', async () => {
    const roots = [root(await realpath(real))]
    const ghost = join(base, 'not-here', 'x.png')
    await expect(matchRootResolved(roots, ghost)).resolves.toBeUndefined()
    // 但若原串本身就在根内（例如根内一个尚未创建的文件），退回后照样能匹配。
    const inside = join(real, 'not-yet.md')
    const match = await matchRootResolved(roots, inside)
    expect(match?.relative).toBe('not-yet.md')
  })

  it('根外的真实路径一律不匹配（realpath 不能把越界洗白）', async () => {
    const roots = [root(await realpath(real))]
    await expect(matchRootResolved(roots, base)).resolves.toBeUndefined()
  })
})
