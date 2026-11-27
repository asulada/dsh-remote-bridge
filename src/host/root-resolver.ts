import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { StoredRoot } from './database.ts'
import { ApiError } from './errors.ts'
import { resolveAuthorizedPath, wireRelative } from './path-policy.ts'

/**
 * 把「服务器上的绝对路径」解析成「它属于哪个授权根、相对路径是什么」。
 *
 * ## 为什么需要它
 *
 * 会话事件里出现的文件路径是**服务器绝对路径**（例如 agent 工具调用里的
 * `data.meta.diffs[].path`）。用户想点开它，但客户端的处境是：
 *
 * - `/api/v1/roots` 只返回 `{ id, label, createdAt }` —— **刻意不含根的绝对路径**
 *   （这是既有的安全设计，不该破坏）；
 * - 于是客户端手里只有「一个绝对路径」和「一个 rootId」，**中间缺的那一环它永远拿不到**。
 *
 * 因此必须由服务端做一次转换。转换的产物**只包含 rootId 与相对路径**，
 * 依然不透露根的绝对路径 —— 安全性没有被削弱。
 *
 * ## 为什么不直接把绝对路径传给 `roots/:id/content`
 *
 * 实测：`GET /api/v1/roots/<id>/content?path=/media/...` 返回 `400 PATH_INVALID`，
 * 接口明确只接受相对路径（`../` 逃逸同样被拦为 400）。所以这条路是封死的，
 * 不是配置问题。
 */

/** 路径落在哪个授权根内。 */
export interface RootMatch {
  rootId: string
  /** 相对该根的 wire 路径（正斜杠分隔）；空串表示根本身。 */
  path: string
}

/**
 * 在授权根集合里找出包含该绝对路径的那一个（**纯字符串匹配，不触碰文件系统**）。
 *
 * 多个根相互嵌套时取**最长**的那个 —— 否则外层根会把内层根下的文件解析成更长的相对路径，
 * 虽然仍能读到同一文件，但会绕过内层根更严格的授权语义。
 *
 * 注意这只是粗筛：字符串前缀相等不代表真实落在根内（根内可能存在指向外部的符号链接）。
 * 真正的安全校验由 [inspectResolvedPath] 经 `resolveAuthorizedPath` 完成。
 */
export function matchAuthorizedRoot(
  absolutePath: string,
  roots: readonly Pick<StoredRoot, 'id' | 'realPath'>[],
): RootMatch | undefined {
  let best: { root: Pick<StoredRoot, 'id' | 'realPath'>; relative: string } | undefined
  for (const root of roots) {
    const relative = wireRelative(root.realPath, absolutePath)
    if (relative === undefined) continue
    if (best === undefined || root.realPath.length > best.root.realPath.length) {
      best = { root, relative }
    }
  }
  return best === undefined ? undefined : { rootId: best.root.id, path: best.relative }
}

/**
 * 与 [matchAuthorizedRoot] 相同，但**两侧都做 realpath 归一**再比较。
 *
 * ## 为什么需要它
 *
 * 授权根在入库时走了 `canonicalRoot()`（`database.ts` 的 addRoot），存的是**解析过
 * 符号链接**的路径；而客户端请求里的路径通常**没解析**。两者字面不同就匹配不上，
 * 结果是「明明在授权根内」却报 404 `PATH_OUTSIDE_ROOTS`。
 *
 * 最常见的触发场景就是 **macOS 的临时目录**：`os.tmpdir()` 给的是
 * `/var/folders/...`，而它是指向 `/private/var/folders/...` 的**符号链接**。
 * 于是测试里 `mkdtemp(os.tmpdir())` 造出的根与请求路径字面不一致 → 404。
 * 2026-10-20 CI 在 macOS runner 上实锤（Linux 上 tmpdir 不带 symlink，所以只在 macOS 炸）。
 *
 * 这不只是测试问题：用户给一个经 symlink 的路径加授权根、或客户端用 symlink 别名
 * 请求，都会踩到。**归一后两侧是同一条真实路径**，语义也就正确了。
 *
 * ## 安全边界不变
 *
 * 归一只解决「同一个目录的两种写法」，**不放宽**任何权限：
 * 真正的越权校验仍由 [inspectResolvedPath] → `resolveAuthorizedPath` 逐段做
 * （它会拒绝指向根外的符号链接）。这里只是把「找哪个根」这一步做准。
 */
export async function matchAuthorizedRootResolved(
  absolutePath: string,
  roots: readonly Pick<StoredRoot, 'id' | 'realPath'>[],
): Promise<RootMatch | undefined> {
  const candidate = await canonicalOrSelf(absolutePath)
  let best: { root: Pick<StoredRoot, 'id' | 'realPath'>; relative: string } | undefined
  for (const root of roots) {
    const canonicalRoot = await canonicalOrSelf(root.realPath)
    const relative = wireRelative(canonicalRoot, candidate)
    if (relative === undefined) continue
    if (best === undefined || canonicalRoot.length > best.root.realPath.length) {
      best = { root, relative }
    }
  }
  return best === undefined ? undefined : { rootId: best.root.id, path: best.relative }
}

/** 取路径的真实形式；取不到（路径不存在、无权限等）就原样返回。 */
async function canonicalOrSelf(target: string): Promise<string> {
  try {
    return await realpath(target)
  } catch {
    return target
  }
}

/** 解析结果里允许外传的字段 —— 刻意不含任何绝对路径。 */
export interface ResolvedEntry {
  rootId: string
  path: string
  kind: 'file' | 'directory'
  size: number | null
  modifiedAt: number | null
  contentType: string | null
}

const CONTENT_TYPES: Record<string, string> = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.kt': 'text/plain',
  '.ts': 'text/plain',
  '.js': 'text/plain',
  '.yml': 'text/plain',
  '.yaml': 'text/plain',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
}

function contentTypeFor(wirePath: string): string | null {
  return CONTENT_TYPES[path.extname(wirePath).toLowerCase()] ?? null
}

/**
 * 确认该路径确实可访问，并返回可外传的元数据。
 *
 * 安全校验交给 `resolveAuthorizedPath`（它逐段 `lstat` 并拒绝路径中的符号链接），
 * 因此这里既不重复实现校验，也不会因为字符串匹配的局限而放行越界访问。
 *
 * 不存在 → `404 PATH_NOT_FOUND`；目录不会被当成错误（会话里提到的路径可能是目录，
 * 用户点开它远比收到一个 400 更合理）。
 */
export async function inspectResolvedPath(root: StoredRoot, wirePath: string): Promise<ResolvedEntry> {
  const resolved = await resolveAuthorizedPath(root.realPath, wirePath)
  const info = await lstat(resolved.absolutePath)

  if (info.isDirectory()) {
    return {
      rootId: root.id,
      path: wirePath,
      kind: 'directory',
      size: null,
      modifiedAt: info.mtimeMs,
      contentType: null,
    }
  }

  if (!info.isFile()) {
    // 设备文件、FIFO、socket 之类：既不是可读文件也不是目录，如实拒绝。
    throw new ApiError(400, 'PATH_NOT_FILE', 'Only regular files and directories can be resolved.')
  }

  return {
    rootId: root.id,
    path: wirePath,
    kind: 'file',
    size: info.size,
    modifiedAt: info.mtimeMs,
    contentType: contentTypeFor(wirePath),
  }
}

/**
 * 会话侧用的根匹配：返回**那个根对象本身**与相对路径。
 *
 * 与 [matchAuthorizedRoot] 的区别只有两点：第一个匹配就返回（不取最长）、回来的
 * 是 `StoredRoot` 而不只是 `rootId` —— 会话要知道根的全貌（label、realPath）。
 */
export function matchRoot(roots: StoredRoot[], cwd: string): { root: StoredRoot; relative: string } | undefined {
  for (const root of roots) {
    const relative = wireRelative(root.realPath, cwd)
    if (relative !== undefined) return { root, relative }
  }
  return undefined
}

/**
 * [matchRoot] 的 realpath 归一版：**先解析候选路径再去比**。
 *
 * 授权根入库时（`roots.addRoot`）解析过符号链接，存的是真实路径；而内核/调用方给的路径
 * 往往是「当初用的那个字符串」，未必解析过。两边直接比字符串会在两类机器上整片失配：
 * - macOS：`os.tmpdir()` 是 `/var/folders/…`，realpath 后是 `/private/var/folders/…`；
 * - Windows：8.3 短名（`C:\Users\RUNNER~1\…`）realpath 后是长名。
 *
 * 2026-11-27 的 CI 就是这么红的：`workspaces` 帧返回空数组，fixture 对拍立刻发现
 * （本机长名一致，所以只在 CI 现形）。
 *
 * 只做「realpath 失败就退回原串」不够 —— 候选是 `根内/还没建出来的文件` 时 realpath
 * 必然抛 ENOENT，退回原串等于拿未解析的写法去比已解析的根，于是同一个文件「存在时可见、
 * 尚未创建时不可见」（同一天的 CI 抓到了这半截，macOS 与 Windows 各红一条用例）。
 * 所以这里解析**最深的已存在祖先**，再把剩下的段落拼回去：末段不存在不再是失配的理由。
 *
 * 连盘符/根都解析不出来时退回原串比较：宁可判不可见，也不要因为一次 stat 失败把整条
 * 列表打崩。
 */
export async function matchRootResolved(
  roots: StoredRoot[],
  candidate: string,
): Promise<{ root: StoredRoot; relative: string } | undefined> {
  const resolved = await resolveExistingPrefix(candidate)
  return matchRoot(roots, resolved ?? candidate)
}

/**
 * 把路径的**最深已存在祖先**解析成真实路径，再把不存在的尾段拼回去。
 *
 * 全都不存在（连盘符/根都没有）时返回 `undefined`，交给调用方退回原串比较。
 */
async function resolveExistingPrefix(candidate: string): Promise<string | undefined> {
  const missing: string[] = []
  let current = candidate
  for (;;) {
    try {
      const resolved = await realpath(current)
      return missing.length === 0 ? resolved : path.join(resolved, ...missing.slice().reverse())
    } catch {
      const parent = path.dirname(current)
      // 到顶了（`/` 或 `C:\`）：连根都不存在，没有可解析的祖先。
      if (parent === current) return undefined
      missing.push(path.basename(current))
      current = parent
    }
  }
}
