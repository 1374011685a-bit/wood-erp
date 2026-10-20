import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { askAi, type AiMessage } from '../api'

type ChatMessage = AiMessage & {
  id: string
  tools?: string[]
}

type TypingState = {
  id: string
  shown: number
  total: number
}

type QuickQuestion = {
  text: string
  icon: 'box' | 'doc' | 'chart' | 'search'
}

const SESSION_KEY = 'wood-erp-ai-pc-session'
const HEADING_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const

const QUICK_QUESTIONS: QuickQuestion[] = [
  { text: '樟子松库存还有多少？', icon: 'box' },
  { text: '今天出库了几单？', icon: 'doc' },
  { text: '最近一周入库情况', icon: 'chart' },
  { text: 'TEST-001 这个合同到货多少了？', icon: 'search' },
  { text: '最近一个月经营情况', icon: 'chart' },
  { text: '哪些规格库存偏低？', icon: 'box' },
]

const TOOL_TEXT: Record<string, string> = {
  库存: '实时库存',
  码单: '码单',
  单据: '单据',
  经营快照: '经营快照',
  合同: '合同进度',
}

const nextId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`

const readSession = (): ChatMessage[] => {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (message): message is ChatMessage =>
        message &&
        (message.role === 'user' || message.role === 'assistant') &&
        typeof message.content === 'string' &&
        typeof message.id === 'string',
    )
  } catch {
    return []
  }
}

function QuickIcon({ name }: { name: QuickQuestion['icon'] }) {
  if (name === 'doc') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M7 3.8h6.8L18 8v12.2H7z" />
        <path d="M13.5 3.8V8H18M9.7 12h5.6M9.7 15.5h5.6" />
      </svg>
    )
  }
  if (name === 'chart') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 19.5h16M6.5 17V11M11.5 17V6.2M16.5 17V9" />
        <path d="m5 7.5 5-3 4 2 5-3" />
      </svg>
    )
  }
  if (name === 'search') {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="10.5" cy="10.5" r="6.2" />
        <path d="m15.2 15.2 4.3 4.3" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m4 7 8-4 8 4-8 4zM4 7v10l8 4 8-4V7M12 11v10" />
    </svg>
  )
}

function AssistantAvatar({ compact = false }: { compact?: boolean }) {
  return (
    <span className={compact ? 'pc-ai-avatar is-small' : 'pc-ai-avatar'} aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none">
        <path d="M12 3.7 14 9l5.3 2-5.3 2-2 5.3-2-5.3-5.3-2 5.3-2z" />
        <path d="m18.4 16.4.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />
      </svg>
    </span>
  )
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text))) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index))
    const token = match[0]
    if (token.startsWith('**')) {
      nodes.push(<strong key={`${match.index}-strong`}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('`')) {
      nodes.push(<code key={`${match.index}-code`}>{token.slice(1, -1)}</code>)
    } else {
      const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(token)
      nodes.push(
        link ? (
          <a key={`${match.index}-link`} href={link[2]} target="_blank" rel="noreferrer">
            {link[1]}
          </a>
        ) : (
          token
        ),
      )
    }
    cursor = match.index + token.length
  }

  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

function tableCells(line: string) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

function isTableSeparator(line: string) {
  const cells = tableCells(line)
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

function isBlockStart(lines: string[], index: number) {
  const line = lines[index] ?? ''
  return (
    /^```/.test(line) ||
    /^#{1,6}\s+/.test(line) ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+\.\s+/.test(line) ||
    /^>\s?/.test(line) ||
    (line.includes('|') && isTableSeparator(lines[index + 1] ?? ''))
  )
}

function MarkdownContent({ text }: { text: string }) {
  const lines = text.replace(/\r/g, '').split('\n')
  const blocks: ReactNode[] = []

  for (let index = 0; index < lines.length; ) {
    const line = lines[index]

    if (!line.trim()) {
      index += 1
      continue
    }

    if (/^```/.test(line)) {
      const language = line.slice(3).trim()
      const code: string[] = []
      index += 1
      while (index < lines.length && !/^```/.test(lines[index])) {
        code.push(lines[index])
        index += 1
      }
      if (index < lines.length) index += 1
      blocks.push(
        <pre className="pc-ai-code" key={`code-${index}`}>
          {language ? <span className="pc-ai-code-lang">{language}</span> : null}
          <code>{code.join('\n')}</code>
        </pre>,
      )
      continue
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line)
    if (heading) {
      const level = Math.min(6, heading[1].length)
      const Tag = HEADING_TAGS[level - 1]
      blocks.push(<Tag key={`heading-${index}`}>{renderInline(heading[2])}</Tag>)
      index += 1
      continue
    }

    if (line.includes('|') && isTableSeparator(lines[index + 1] ?? '')) {
      const headers = tableCells(line)
      const rows: string[][] = []
      index += 2
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(tableCells(lines[index]))
        index += 1
      }
      blocks.push(
        <div className="pc-ai-table-wrap" key={`table-${index}`}>
          <table className="pc-ai-table">
            <thead>
              <tr>
                {headers.map((cell, cellIndex) => (
                  <th key={`${cell}-${cellIndex}`}>{renderInline(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={`row-${rowIndex}`}>
                  {headers.map((_, cellIndex) => (
                    <td key={`cell-${rowIndex}-${cellIndex}`}>
                      {renderInline(row[cellIndex] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      continue
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = []
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*+]\s+/, ''))
        index += 1
      }
      blocks.push(
        <ul key={`ul-${index}`}>
          {items.map((item, itemIndex) => (
            <li key={`${itemIndex}-${item}`}>{renderInline(item)}</li>
          ))}
        </ul>,
      )
      continue
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+\.\s+/, ''))
        index += 1
      }
      blocks.push(
        <ol key={`ol-${index}`}>
          {items.map((item, itemIndex) => (
            <li key={`${itemIndex}-${item}`}>{renderInline(item)}</li>
          ))}
        </ol>,
      )
      continue
    }

    if (/^>\s?/.test(line)) {
      const quote: string[] = []
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^>\s?/, ''))
        index += 1
      }
      blocks.push(<blockquote key={`quote-${index}`}>{renderInline(quote.join('\n'))}</blockquote>)
      continue
    }

    const paragraph: string[] = [line]
    index += 1
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines, index)) {
      paragraph.push(lines[index])
      index += 1
    }
    blocks.push(<p key={`paragraph-${index}`}>{renderInline(paragraph.join('\n'))}</p>)
  }

  return <div className="pc-ai-markdown">{blocks}</div>
}

export default function Ai() {
  const [messages, setMessages] = useState<ChatMessage[]>(readSession)
  const [draft, setDraft] = useState('')
  const [asking, setAsking] = useState(false)
  const [typing, setTyping] = useState<TypingState | null>(null)
  const [error, setError] = useState('')
  const [copiedId, setCopiedId] = useState('')
  const listRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const requestSeqRef = useRef(0)
  const retryConversationRef = useRef<AiMessage[]>([])

  useEffect(() => {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(messages))
  }, [messages])

  useEffect(() => {
    const box = listRef.current
    if (box) box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' })
  }, [messages, asking, typing?.shown])

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 156)}px`
  }, [draft])

  useEffect(() => {
    const timer = window.setTimeout(() => inputRef.current?.focus(), 80)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (!typing) return
    if (typing.shown >= typing.total) {
      const timer = window.setTimeout(() => setTyping(null), 80)
      return () => window.clearTimeout(timer)
    }
    const timer = window.setTimeout(() => {
      setTyping((previous) => {
        if (!previous) return previous
        const step = 2 + (previous.shown % 3)
        return { ...previous, shown: Math.min(previous.total, previous.shown + step) }
      })
    }, 20)
    return () => window.clearTimeout(timer)
  }, [typing])

  const finishTyping = (id?: string) => {
    setTyping((previous) =>
      previous && (!id || previous.id === id) ? { ...previous, shown: previous.total } : previous,
    )
  }

  const requestReply = async (conversation: AiMessage[]) => {
    const requestId = (requestSeqRef.current += 1)
    retryConversationRef.current = conversation
    setAsking(true)
    setError('')
    try {
      const result = await askAi(conversation)
      if (requestId !== requestSeqRef.current) return
      const assistant: ChatMessage = {
        id: nextId(),
        role: 'assistant',
        content: result.reply,
        tools: result.tools ?? [],
      }
      setMessages((previous) => [...previous, assistant])
      setTyping({ id: assistant.id, shown: 0, total: assistant.content.length })
    } catch (err) {
      if (requestId === requestSeqRef.current) {
        setError(err instanceof Error ? err.message : 'AI 调用失败')
      }
    } finally {
      if (requestId === requestSeqRef.current) setAsking(false)
    }
  }

  const send = (input?: string) => {
    const text = String(input ?? draft).trim()
    if (!text || asking || typing) return
    const user: ChatMessage = { id: nextId(), role: 'user', content: text }
    const next = [...messages, user]
    setMessages(next)
    setDraft('')
    setError('')
    retryConversationRef.current = next
    void requestReply(next)
  }

  const clearConversation = () => {
    requestSeqRef.current += 1
    retryConversationRef.current = []
    setMessages([])
    setDraft('')
    setAsking(false)
    setTyping(null)
    setError('')
    setCopiedId('')
    sessionStorage.removeItem(SESSION_KEY)
    window.setTimeout(() => inputRef.current?.focus(), 60)
  }

  const copyMessage = async (message: ChatMessage) => {
    try {
      await navigator.clipboard.writeText(message.content)
      setCopiedId(message.id)
      window.setTimeout(() => setCopiedId(''), 1400)
    } catch {
      setCopiedId('')
    }
  }

  const onComposerKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  }

  const displayContent = (message: ChatMessage) =>
    typing?.id === message.id ? message.content.slice(0, typing.shown) : message.content

  const hasConversation = messages.length > 0 || asking

  return (
    <section className="pc-ai-page">
      <div className="pc-ai-shell">
        <header className="pc-ai-header">
          <div className="pc-ai-brand">
            <AssistantAvatar compact />
            <div>
              <strong>立川云 AI 助手</strong>
              <span>库存、单据、合同与经营数据，随时问</span>
            </div>
          </div>
          <div className="pc-ai-header-actions">
            <span className="pc-ai-model">
              <i />
              DeepSeek
            </span>
            <button type="button" className="pc-ai-new" onClick={clearConversation}>
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
              新对话
            </button>
          </div>
        </header>

        <div
          className={hasConversation ? 'pc-ai-body' : 'pc-ai-body is-welcome'}
          ref={listRef}
          role="log"
          aria-live="polite"
        >
          {!hasConversation ? (
            <div className="pc-ai-welcome">
              <div className="pc-ai-welcome-mark">
                <img src="/logo.png" alt="立川云" />
                <span className="pc-ai-welcome-spark">
                  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M12 3.7 14 9l5.3 2-5.3 2-2 5.3-2-5.3-5.3-2 5.3-2z" />
                  </svg>
                </span>
              </div>
              <h1>有什么可以帮你？</h1>
              <p>可以直接查实时库存、单据进度和合同到货情况</p>
              <div className="pc-ai-quick-grid">
                {QUICK_QUESTIONS.map((question) => (
                  <button
                    type="button"
                    className="pc-ai-quick"
                    key={question.text}
                    onClick={() => send(question.text)}
                  >
                    <span className="pc-ai-quick-icon">
                      <QuickIcon name={question.icon} />
                    </span>
                    <span>{question.text}</span>
                    <svg className="pc-ai-quick-arrow" viewBox="0 0 24 24" fill="none">
                      <path d="m9 5 7 7-7 7" />
                    </svg>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="pc-ai-thread">
              {messages.map((message) => (
                <article
                  className={`pc-ai-message is-${message.role}`}
                  key={message.id}
                  onClick={() => {
                    if (typing?.id === message.id) finishTyping(message.id)
                  }}
                >
                  {message.role === 'assistant' ? (
                    <AssistantAvatar compact />
                  ) : (
                    <span className="pc-ai-user-avatar" aria-hidden="true">
                      我
                    </span>
                  )}
                  <div className="pc-ai-message-main">
                    <div className="pc-ai-message-meta">
                      <span>{message.role === 'assistant' ? '立川云 AI' : '你'}</span>
                      {message.role === 'assistant' ? (
                        <button
                          type="button"
                          className="pc-ai-copy"
                          onClick={(event) => {
                            event.stopPropagation()
                            void copyMessage(message)
                          }}
                        >
                          {copiedId === message.id ? '已复制' : '复制'}
                        </button>
                      ) : null}
                    </div>
                    {message.role === 'assistant' &&
                    message.tools &&
                    message.tools.length > 0 ? (
                      <div className="pc-ai-tool-tags">
                        {message.tools.map((tool) => (
                          <span key={tool}>
                            <i />
                            已查询：{TOOL_TEXT[tool] ?? tool}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    <div className="pc-ai-bubble">
                      {message.role === 'assistant' ? (
                        <MarkdownContent text={displayContent(message)} />
                      ) : (
                        <p>{message.content}</p>
                      )}
                      {typing?.id === message.id && typing.shown < typing.total ? (
                        <span className="pc-ai-caret" aria-hidden="true" />
                      ) : null}
                    </div>
                  </div>
                </article>
              ))}

              {asking ? (
                <article className="pc-ai-message is-assistant is-thinking">
                  <AssistantAvatar compact />
                  <div className="pc-ai-message-main">
                    <div className="pc-ai-message-meta">
                      <span>立川云 AI</span>
                    </div>
                    <div className="pc-ai-bubble pc-ai-thinking" aria-label="正在思考">
                      <span />
                      <span />
                      <span />
                    </div>
                  </div>
                </article>
              ) : null}
            </div>
          )}
        </div>

        {error ? (
          <div className="pc-ai-error" role="alert">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => {
                if (retryConversationRef.current.length > 0) {
                  void requestReply(retryConversationRef.current)
                }
              }}
            >
              重试
            </button>
          </div>
        ) : null}

        <footer className="pc-ai-composer-wrap">
          <div className="pc-ai-composer">
            <textarea
              ref={inputRef}
              className="pc-ai-input"
              rows={1}
              value={draft}
              disabled={asking || Boolean(typing)}
              placeholder="输入你的问题，例如：上周樟子松出了多少方？"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onComposerKeyDown}
            />
            <button
              type="button"
              className="pc-ai-send"
              aria-label="发送"
              disabled={asking || Boolean(typing) || draft.trim() === ''}
              onClick={() => send()}
            >
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 19V5m0 0-6 6m6-6 6 6" />
              </svg>
            </button>
          </div>
          <div className="pc-ai-composer-hint">
            <span>Enter 发送</span>
            <span>Shift + Enter 换行</span>
            <span>AI 查询的是当前系统实时数据</span>
          </div>
        </footer>
      </div>
    </section>
  )
}
