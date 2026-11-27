import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  MEDIA_BLOCK_MAX_PER_MESSAGE,
  baseNameOf,
  mediaBlocksOfMessage,
  mediaBlocksOfText,
  mediaRefsInText,
  mediaTypeForName,
  projectMediaIntoHistory,
} from '../src/host/chat/media-blocks.ts'
import { normalizeDshEvent } from '../src/host/chat/access.ts'

/**
 * 媒体块投影（`media-blocks-v1`）。
 *
 * 盯住五件事：识别哪些写法、**不碰文件系统**、历史投影幂等、实时帧带不带 `media`、
 * 以及「块里每个字段都能在正文里找到出处」。
 *
 * 注意这组用例**不建任何文件**：投影是纯文本变换（见 `media-blocks.ts` 文件头的
 * 「不碰文件系统」），所以路径可以指向根本不存在的文件 —— 真要断言"不存在也给块"，
 * 建个临时目录反而是误导。
 */

const sandbox = join(tmpdir(), 'host-media-blocks-fixtures')
const png = join(sandbox, 'frame1s.png')
const mp4 = join(sandbox, 'clip.mp4')
const note = join(sandbox, 'notes.md')

/** 投影输出一律正斜杠（wire 口径），所以断言也要用正斜杠。 */
const fwd = (path: string): string => path.replace(/\\/g, '/')

describe('mediaRefsInText', () => {
  it('picks up markdown images, markdown links and bare absolute paths', () => {
    const text = [
      `看这张：![截图](${png})`,
      `视频在 [clip](${mp4}) 里面`,
      `或者直接 ${mp4}`,
    ].join('\n')
    expect(mediaRefsInText(text)).toEqual([fwd(png), fwd(mp4)])
  })

  it('accepts angle-bracket markdown targets and file:// URLs', () => {
    const spaced = join(sandbox, 'with space.png')
    expect(mediaRefsInText(`![](<${spaced}>)`)).toEqual([fwd(spaced)])
    // 用 `pathToFileURL` 而不是手拼 `file:///${path}`：POSIX 上路径本身以 `/` 开头，
    // 手拼会得到 `file:////tmp/x.png`（多一个斜杠），那是拼 URL 的错，不是被测代码的错。
    expect(mediaRefsInText(pathToFileURL(png).href)).toEqual([fwd(png)])
    // 但正文里真的会出现多斜杠写法，所以也认。这条在 Windows 上走 `/C:/` 还原那支。
    expect(mediaRefsInText(`file:////${fwd(png).replace(/^\/+/, '')}`)).toEqual([fwd(png)])
  })

  it('does not truncate paths at the full-width colon Chinese prose uses', () => {
    expect(mediaRefsInText(`成品：${png}`)).toEqual([fwd(png)])
  })

  it('ignores non-media extensions, http(s) URLs and relative paths', () => {
    expect(mediaRefsInText(`see ${note} and ${sandbox}`)).toEqual([])
    expect(mediaRefsInText('![x](https://example.com/a.png)')).toEqual([])
    expect(mediaRefsInText('![x](assets/a.png)')).toEqual([])
    expect(mediaRefsInText('plain text without paths')).toEqual([])
  })

  it('dedupes the same path mentioned twice', () => {
    expect(mediaRefsInText(`![a](${png}) then ${png} again ${png}`)).toEqual([fwd(png)])
  })
})

describe('mediaTypeForName / baseNameOf', () => {
  it('maps the media whitelist and rejects everything else', () => {
    expect(mediaTypeForName('a.PNG')).toBe('image/png')
    expect(mediaTypeForName('a.mp4')).toBe('video/mp4')
    expect(mediaTypeForName('a.flac')).toBe('audio/flac')
    expect(mediaTypeForName('a.ts')).toBeUndefined()
    expect(mediaTypeForName('noext')).toBeUndefined()
  })

  it('takes the last segment, tolerating both separators', () => {
    expect(baseNameOf('D:/a/b/c.png')).toBe('c.png')
    expect(baseNameOf('D:\\a\\b\\c.png')).toBe('c.png')
    expect(baseNameOf('/tmp/x/')).toBe('x')
  })
})

describe('mediaBlocksOfText', () => {
  it('reports type, absolute path and name — and nothing derived from the filesystem', () => {
    const blocks = mediaBlocksOfText(`![s](${png})`)
    expect(blocks).toEqual([
      { type: 'media', mediaType: 'image/png', path: fwd(png), name: 'frame1s.png' },
    ])
    // `size` 曾经有，2026-11-27 拿掉了：它只能靠 stat 得到，而投影不碰盘。
    expect(blocks[0]).not.toHaveProperty('size')
  })

  it('emits blocks for paths that do not exist — the bridge does not probe the disk', () => {
    const ghost = join(sandbox, 'definitely-not-here', 'missing.mp4')
    expect(mediaBlocksOfText(`![x](${ghost})`)).toEqual([
      { type: 'media', mediaType: 'video/mp4', path: fwd(ghost), name: 'missing.mp4' },
    ])
  })

  it('honours the per-message block cap', () => {
    const many = [png, mp4].map(path => `![x](${path})`).join('\n')
    expect(mediaBlocksOfText(many, { maxBlocks: 1 })).toHaveLength(1)
    expect(MEDIA_BLOCK_MAX_PER_MESSAGE).toBe(8)
  })
})

describe('mediaBlocksOfMessage', () => {
  it('reads text blocks only — reasoning paths do not count', () => {
    const message = {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: `草稿里写了 ${mp4}` },
        { type: 'text', text: `成品在这里 ${png}` },
        { type: 'tool-call', id: 'c1', name: 'bash' },
      ],
    }
    expect(mediaBlocksOfMessage(message).map(block => block.path)).toEqual([fwd(png)])
  })

  it('tolerates string content and garbage input', () => {
    expect(mediaBlocksOfMessage({ content: `${png}` })).toHaveLength(1)
    expect(mediaBlocksOfMessage(undefined)).toEqual([])
    expect(mediaBlocksOfMessage({ content: 42 })).toEqual([])
  })
})

describe('projectMediaIntoHistory', () => {
  const assistantEvent = (): Record<string, unknown> => ({
    type: 'assistant/message',
    seq: 7,
    data: { message: { role: 'assistant', content: [{ type: 'text', text: `图：${png}` }] } },
  })

  it('appends a media block to assistant messages and leaves other events alone', () => {
    const userEvent = { type: 'user/message', seq: 6, data: { message: { role: 'user', content: [{ type: 'text', text: `${mp4}` }] } } }
    const page = { events: [userEvent, assistantEvent()], hasMore: false }
    const projected = projectMediaIntoHistory(page)
    expect(projected.events[0]).toBe(userEvent)
    const content = (projected.events[1] as { data: { message: { content: unknown[] } } }).data.message.content
    expect(content).toHaveLength(2)
    expect(content[1]).toMatchObject({ type: 'media', mediaType: 'image/png', name: 'frame1s.png' })
  })

  it('is idempotent: projecting twice does not duplicate blocks', () => {
    const once = projectMediaIntoHistory({ events: [assistantEvent()], hasMore: false })
    const twice = projectMediaIntoHistory(once)
    const content = (twice.events[0] as { data: { message: { content: unknown[] } } }).data.message.content
    expect(content).toHaveLength(2)
  })

  it('does not mutate the input page and is a no-op when nothing matches', () => {
    const page = { events: [assistantEvent()], hasMore: false }
    const snapshot = JSON.stringify(page)
    projectMediaIntoHistory(page)
    expect(JSON.stringify(page)).toBe(snapshot)

    const quiet = { events: [{ type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: 'hello' }] } } }], hasMore: false }
    expect(projectMediaIntoHistory(quiet)).toBe(quiet)
  })
})

describe('chat.message.committed 带上 media', () => {
  /** `normalizeDshEvent(frame, fallback)`：frame 是 `{rpcId, payload}`，payload 是内核推送壳。 */
  const normalize = (event: Record<string, unknown>): ReturnType<typeof normalizeDshEvent> =>
    normalizeDshEvent({ rpcId: 'r1', payload: { type: 'session/event', sessionId: 'S1', event } }, 'mux', 0)

  it('includes media for an assistant message that points at a media file', () => {
    const committed = normalize({
      type: 'assistant/message',
      seq: 12,
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `成品 ${png}` }] } },
    })
    expect(committed.type).toBe('chat.message.committed')
    const data = committed.data as { media?: unknown[]; hasReplyContent?: boolean }
    expect(data.hasReplyContent).toBe(true)
    expect(data.media).toEqual([
      { type: 'media', mediaType: 'image/png', path: fwd(png), name: 'frame1s.png' },
    ])
  })

  it('omits the field entirely when there is no media', () => {
    const committed = normalize({
      type: 'assistant/message',
      seq: 13,
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '没有媒体' }] } },
    })
    expect(Object.hasOwn(committed.data as object, 'media')).toBe(false)
  })

  it('never adds media to user messages', () => {
    const committed = normalize({
      type: 'user/message',
      seq: 14,
      data: { turn: 1, message: { role: 'user', content: [{ type: 'text', text: `看这个 ${png}` }] } },
    })
    expect(Object.hasOwn(committed.data as object, 'media')).toBe(false)
  })
})
