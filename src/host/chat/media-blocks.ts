/**
 * 助手正文里的**媒体引用** → 结构化块（issue「助手回复里的图片/视频路径，手机端看不到」）。
 *
 * ## 为什么桥要做这件事，而不是让客户端自己解析
 *
 * 模型回复里出现图片/视频路径的方式至少三种（markdown 图片、markdown 链接、正文裸路径），
 * 各客户端的 markdown 渲染器能力又不同：`host-Chat` 的 Flutter 渲染器**没有图片能力**
 * （`app/lib/ui/md_view.dart` 全文无 image），鸿蒙那边同理。让每个客户端各自解析一遍
 * 路径 = 同一套规则写两遍、还都是"只认 `/` 开头的绝对路径"那种半吊子实现
 * （`app/lib/ui/workspace_link.dart:44` 就是这么把 Windows 的 `D:/…` 判成相对路径的）。
 *
 * 桥在**出网前一次**把路径变成 `{type:'media', mediaType, path, name}`，客户端
 * 只需按 `mediaType` 选渲染器、按 `path` 走已有的 `/roots/resolve` → `/roots/{id}/content`
 * 取字节。一处实现，所有客户端受益。
 *
 * ## 边界（都是刻意的）
 *
 * - **不碰文件系统**：投影是**纯文本变换**，不 `stat`、不探测、不读任何文件。
 *   这一条是安全性的地基，三件事同时成立才敢这么写：① 桥的事件泵是**全局**的
 *   （`access.ts` 的 `startEvents` 一次映射、按订阅者扇出，根本不知道"现在是谁在看"），
 *   在那里 `stat` 就等于**替所有设备去探任意路径**，探测结果（存在性、大小）还会
 *   随帧发给没有该根授权的设备；② 映射是同步纯函数，一次 `statSync` 落在慢盘或
 *   掉线的网络映射盘上会把整个事件循环卡住；③ 块里**不该有任何"只有碰了盘才知道"
 *   的信息 —— 块只复述模型自己写出来的那个路径**,客户端要大小就走 `/roots/resolve`
 *   （那条路由本来就会返回 `size`/`modifiedAt`，且过了授权）。
 * - **只认白名单扩展名**：见 `MEDIA_TYPES`。不在表里的一律不当媒体 —— 宁可少给一个块，
 *   也不要把 `main.ts` 当"未知媒体"塞给客户端。
 * - **只认绝对路径**：相对路径的基准是会话 cwd，而历史里没有任何地方写着"这条消息当时的
 *   cwd 是什么"（会话可以换根，见 `access.ts` 的会话根缓存注释）。按今天的 cwd 去猜
 *   昨天的相对路径，会给出一个**看起来能点、点开却是别的文件**的块 —— 比不给更坏。
 * - **不搬文件、不复制**：`path` 指回原文件。搬进会话目录会复制大文件，而用户要的是
 *   "看到它"，不是"多一份"。
 * - **失败一律静默**：投影是**锦上添花**，不许因为它让整条历史读不出来。
 *   文件不存在/超权限都由客户端在取字节那一步发现（`PATH_NOT_FOUND`/`PATH_OUTSIDE_ROOTS`），
 *   桥不预判、不缓存判断结果。
 * - **`path` 是服务器绝对路径**：与既有的 `deliverables/presented.files[].path`、
 *   `[Image: source: …]` 占位同口径（本插件一直这么传，客户端用 `/roots/resolve` 换 rootId，
 *   那条路由刻意不回绝对根路径，见 `routes/files.ts:23-47`）。这也意味着**授权根外的路径
 *   客户端取不到字节**：块照给，客户端按 `PATH_OUTSIDE_ROOTS` 显示"无法读取"即可。
 */

/** 视为「媒体」的扩展名 → wire 上的 `mediaType`（客户端靠它选渲染器）。 */
const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
}

/**
 * 单条消息最多投影这么多块。
 *
 * 为什么要有上限：识别是**对每条助手消息的正文做正则扫描**，而历史一次可能返回上百条
 * 消息。模型偶尔会吐一大段路径清单（比如 `ls` 的输出），不设闸就是一条消息几十个块、
 * 读一次历史多出几百个块，白白挤占 2 MiB 的历史字节预算。
 */
export const MEDIA_BLOCK_MAX_PER_MESSAGE = 8

/** 投影出来的媒体块（wire 形状，见 `API.md` 的「媒体块」一节）。 */
export interface MediaBlockView {
  type: 'media'
  mediaType: string
  path: string
  name: string
}

/**
 * 从正文里挑出**媒体候选路径**（未做 stat，纯文本层）。
 *
 * 三种写法都认：
 * 1. markdown 图片 `![alt](path)` / `![alt](<path with space>)`；
 * 2. markdown 链接 `[text](path)`（只有扩展名命中白名单才算）；
 * 3. 正文裸路径（`D:/…`、`C:\…`、`/…`），前后必须是空白或标点边界。
 *
 * URL（`http://…`）一律不算 —— 那是网络资源，客户端不该拿它去 `/roots/resolve`。
 */
export function mediaRefsInText(text: string): string[] {
  const found: string[] = []
  const push = (raw: string): void => {
    const cleaned = cleanupCandidate(raw)
    if (cleaned !== undefined && !found.includes(cleaned)) found.push(cleaned)
  }

  // ① / ② markdown 的链接目标：`]( … )`，允许 `<…>` 包裹（含空格的路径必须这么写）。
  for (const match of text.matchAll(/!?\[[^\]]*\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)/g)) {
    push(match[1] ?? match[2] ?? '')
  }

  // ③ 裸路径：前后是行首/空白/常见定界符。左定界符里刻意**没有**半角冒号：
  //    加了它 `https://host/a.png` 的 `/host/a.png` 会混进来；全角 `：` 必须有，
  //    中文正文写「图：D:/…」太常见。
  for (const match of text.matchAll(/(?:^|[\s"'`(（【「[｜|：])((?:[A-Za-z]:[\\/]|\/)[^\s"'`()<>[\]（）【】「」，。；、]*)/g)) {
    push(match[1] ?? '')
  }

  // ④ `file://` 前缀的写法（`file:///D:/x.png`）。必须单列一条，因为裸路径那支的
  //    左定界符是空白/引号：`file:` 后面的 `/` 前面是 `:`，那支匹配不到；而把 `:`
  //    加进左定界符又会让 `https://host/a.png` 的 `/host/a.png` 混进来。
  for (const match of text.matchAll(/file:\/\/[^\s"'`()<>[\]（）【】「」，。；、]+/gi)) {
    push(match[0])
  }

  return found.filter(isMediaPath)
}

/** 候选串的清理：去掉 `file://` 前缀、尾随标点，反斜杠归一成 `/`。 */
function cleanupCandidate(raw: string): string | undefined {
  let value = raw.trim()
  if (value === '') return undefined
  if (value.toLowerCase().startsWith('file://')) {
    value = value.slice('file://'.length)
    // URL 的路径段按 URL 规则编码过：`pathToFileURL('C:/Users/RUNNER~1/a.png')` 给出的是
    // `file:///C:/Users/RUNNER%7E1/a.png`。要还原成文件系统路径，就得先解码；解不开
    // （正文里写着 `file:///C:/100%.png`，`%` 后面不是合法转义）就原样留着。
    value = decodePercentEscapes(value)
    // `file://` 之后若是已经带前导斜杠的路径（POSIX 全是这种：`file://` + `/tmp/x.png`），
    // 拼出来就是 `file:////tmp/x.png`，剥前缀后剩 `//tmp/x.png` —— 与 `/tmp/x.png` 不等，
    // 于是正文里那种写法一个都认不出来。统一折成一个前导斜杠。
    value = value.replace(/^\/+/, '/')
  }
  // `file:///D:/x` → `/D:/x`，Windows 上这种多一个斜杠的写法必须还原。
  value = value.replace(/^\/([A-Za-z]:[\\/])/, '$1')
  // 尾随标点：句号/逗号/分号/右括号等在正文里很常见，但不属于路径。
  value = value.replace(/[.,;:!?]+$/, '')
  if (value === '') return undefined
  return value.replace(/\\/g, '/')
}

/**
 * 百分号解码，解不开就原样返回。
 *
 * `decodeURIComponent` 遇到孤立的 `%`（正文里写 `100%.png`、日志里 `%` 被当占位符）会抛
 * `URIError` —— 一个坏字符不该让整条消息的识别失败，所以吞掉异常退回原串。
 */
function decodePercentEscapes(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** 绝对路径 + 扩展名命中媒体白名单。 */
function isMediaPath(path: string): boolean {
  if (path.includes('://')) return false
  if (!(path.startsWith('/') || /^[A-Za-z]:\//.test(path))) return false
  return mediaTypeForName(path) !== undefined
}

/** 按扩展名给媒体类型；不在白名单里返回 `undefined`。 */
export function mediaTypeForName(name: string): string | undefined {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return undefined
  return MEDIA_TYPES[name.slice(dot).toLowerCase()]
}

/** 路径的最后一段（`name` 字段，客户端拿它显示标题）。两种分隔符都认。 */
export function baseNameOf(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const at = normalized.lastIndexOf('/')
  return at < 0 ? normalized : normalized.slice(at + 1)
}

/**
 * 把候选路径变成媒体块：**纯文本层**完成，不碰文件系统（理由见文件头「不碰文件系统」）。
 *
 * 于是「文件不存在」「没权限」「是个 100 GB 的视频」都不在这里判 —— 这些由客户端
 * 取字节那一步的授权与上限去卡（`/roots/resolve` 回 `PATH_NOT_FOUND`，`file-download`
 * 回 `file-too-large`）。桥只保证一件事：**块里每个字都能在正文里找到出处**。
 */
export function mediaBlocksOfText(
  text: string,
  options: { maxBlocks?: number } = {},
): MediaBlockView[] {
  const maxBlocks = options.maxBlocks ?? MEDIA_BLOCK_MAX_PER_MESSAGE
  const blocks: MediaBlockView[] = []
  for (const path of mediaRefsInText(text)) {
    if (blocks.length >= maxBlocks) break
    const mediaType = mediaTypeForName(path)
    if (mediaType === undefined) continue
    blocks.push({ type: 'media', mediaType, path, name: baseNameOf(path) })
  }
  return blocks
}

/**
 * 一条助手消息 → 媒体块。只读 `content` 里的 `text` 块（`reasoning` 不算：
 * 那是模型的思考过程，里面的路径往往是它**打算**写、最终没写的）。
 */
export function mediaBlocksOfMessage(
  message: unknown,
  options: { maxBlocks?: number } = {},
): MediaBlockView[] {
  if (message === null || typeof message !== 'object') return []
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return mediaBlocksOfText(content, options)
  if (!Array.isArray(content)) return []
  const texts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const record = block as { type?: unknown; kind?: unknown; text?: unknown }
    const kind = typeof record.type === 'string' ? record.type : record.kind
    if (kind === 'text' && typeof record.text === 'string') texts.push(record.text)
  }
  if (texts.length === 0) return []
  return mediaBlocksOfText(texts.join('\n\n'), options)
}

/**
 * 历史投影：给每条 `assistant/message` 的 `content` **追加**媒体块。
 *
 * 幂等：已经带同 `path` 的 `media` 块不再追加（客户端重复拉同一页、
 * 或者这段历史被投影两次都不会长出重复块）。
 *
 * 不改原对象：内核回的那份 `events` 还可能被别处读到（预算/摘要都基于它），
 * 因此逐层浅拷贝，只替换真正被改到的那一层。
 */
export function projectMediaIntoHistory<T extends { events: unknown[] }>(
  page: T,
  options: { maxBlocks?: number } = {},
): T {
  let changed = false
  const events = page.events.map((event) => {
    const projected = projectIntoEvent(event, options)
    if (projected === event) return event
    changed = true
    return projected
  })
  // `as T`：只换了 `events` 数组（元素形状不变），泛型收窄不了「元素类型没变」这件事，
  // 于是显式断言 —— 不用 `any`，也不用把整个函数退化成非泛型。
  return changed ? ({ ...page, events } as T) : page
}

function projectIntoEvent(event: unknown, options: { maxBlocks?: number }): unknown {
  if (event === null || typeof event !== 'object') return event
  const record = event as { type?: unknown; data?: unknown }
  if (record.type !== 'assistant/message') return event
  const data = record.data
  if (data === null || typeof data !== 'object') return event
  const message = (data as { message?: unknown }).message
  if (message === null || typeof message !== 'object') return event
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return event

  const existing = new Set<string>()
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const candidate = block as { type?: unknown; path?: unknown }
    if (candidate.type === 'media' && typeof candidate.path === 'string') existing.add(candidate.path)
  }
  const fresh = mediaBlocksOfMessage(message, options).filter(block => !existing.has(block.path))
  if (fresh.length === 0) return event

  return {
    ...record,
    data: {
      ...(data as Record<string, unknown>),
      message: { ...(message as Record<string, unknown>), content: [...content, ...fresh] },
    },
  }
}
