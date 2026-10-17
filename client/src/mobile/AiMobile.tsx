import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { askAi, type AiMessage } from '../api'
import {
  MobileIcon,
  MobileToastHost,
  MobileTopbarActions,
  MobileTopbarButton,
  useAutoDismiss,
  type MobileToastItem,
} from './components'

type ChatMessage = AiMessage & {
  id: string
  tools?: string[]
}

type TypingState = {
  id: string
  shown: number
  total: number
}

const SESSION_KEY = 'wood-erp-ai-mobile-session'

const QUICK_QUESTIONS: Array<{
  text: string
  icon: 'box' | 'doc' | 'chart' | 'search'
}> = [
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
      (one): one is ChatMessage =>
        one &&
        (one.role === 'user' || one.role === 'assistant') &&
        typeof one.content === 'string' &&
        typeof one.id === 'string',
    )
  } catch {
    return []
  }
}

export default function AiMobile() {
  const [messages, setMessages] = useState<ChatMessage[]>(readSession)
  const [draft, setDraft] = useState('')
  const [asking, setAsking] = useState(false)
  const [typing, setTyping] = useState<TypingState | null>(null)
  const [error, setError] = useState('')
  const [keyboardOffset, setKeyboardOffset] = useState(0)
  const [toast, setToast] = useState<MobileToastItem | null>(null)
  useAutoDismiss(toast, () => setToast(null))
  const listRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const lastScrollRef = useRef(0)
  const pressTimerRef = useRef<number | null>(null)
  const retryConversationRef = useRef<AiMessage[]>([])
  const requestSeqRef = useRef(0)

  useEffect(() => {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(messages))
  }, [messages])

  const scrollToBottom = useCallback((force = false) => {
    const box = listRef.current
    if (!box) return
    const now = performance.now()
    if (!force && now - lastScrollRef.current < 80) return
    lastScrollRef.current = now
    box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' })
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [messages, asking, typing?.shown, scrollToBottom])

  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const update = () => {
      const layoutHeight = document.documentElement.clientHeight
      const keyboard = Math.max(
        0,
        Math.round(layoutHeight - viewport.height - viewport.offsetTop),
      )
      setKeyboardOffset(keyboard)
      if (keyboard > 0) scrollToBottom(true)
    }
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    update()
    return () => {
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
      setKeyboardOffset(0)
    }
  }, [scrollToBottom])

  useEffect(() => {
    if (keyboardOffset > 0) scrollToBottom(true)
  }, [keyboardOffset, scrollToBottom])

  useEffect(() => {
    if (!typing) return
    if (typing.shown >= typing.total) {
      const timer = window.setTimeout(() => setTyping(null), 20)
      return () => window.clearTimeout(timer)
    }
    const timer = window.setTimeout(() => {
      setTyping((prev) => {
        if (!prev) return prev
        const step = 2 + (prev.shown % 3)
        return { ...prev, shown: Math.min(prev.total, prev.shown + step) }
      })
    }, 20)
    return () => window.clearTimeout(timer)
  }, [typing])

  const finishTyping = () => {
    if (!typing) return
    setTyping((prev) => (prev ? { ...prev, shown: prev.total } : prev))
  }

  const requestReply = async (conversation: AiMessage[]) => {
    const requestId = (requestSeqRef.current += 1)
    setAsking(true)
    setError('')
    retryConversationRef.current = conversation
    try {
      const result = await askAi(conversation)
      if (requestId !== requestSeqRef.current) return
      const assistant: ChatMessage = {
        id: nextId(),
        role: 'assistant',
        content: result.reply,
        tools: result.tools ?? [],
      }
      setMessages((prev) => [...prev, assistant])
      setTyping({ id: assistant.id, shown: 0, total: assistant.content.length })
    } catch (err) {
      if (requestId !== requestSeqRef.current) return
      setError(err instanceof Error ? err.message : 'AI 调用失败')
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
    if (pressTimerRef.current) window.clearTimeout(pressTimerRef.current)
    setMessages([])
    setDraft('')
    setAsking(false)
    setTyping(null)
    setError('')
    retryConversationRef.current = []
    sessionStorage.removeItem(SESSION_KEY)
    window.setTimeout(() => inputRef.current?.focus(), 60)
  }

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      document.execCommand('copy')
      area.remove()
    }
    setToast({ id: `copy-${Date.now()}`, message: '已复制' })
  }

  const startPress = (message: ChatMessage) => {
    if (pressTimerRef.current) window.clearTimeout(pressTimerRef.current)
    pressTimerRef.current = window.setTimeout(() => {
      pressTimerRef.current = null
      void copyText(message.content)
    }, 500)
  }

  const stopPress = () => {
    if (!pressTimerRef.current) return
    window.clearTimeout(pressTimerRef.current)
    pressTimerRef.current = null
  }

  const displayContent = (message: ChatMessage) =>
    typing?.id === message.id ? message.content.slice(0, typing.shown) : message.content

  return (
    <div
      className="m-ai-page"
      style={{ '--m-ai-kb': `${keyboardOffset}px` } as CSSProperties}
    >
      <MobileTopbarActions>
        <MobileTopbarButton label="新对话" onClick={clearConversation} />
      </MobileTopbarActions>

      <div className="m-ai-list" ref={listRef}>
        {messages.length === 0 && !asking ? (
          <div className="m-ai-welcome">
            <img src="/logo.png" alt="立川云" />
            <h1>立川云 AI 助手</h1>
            <p>有什么可以帮你？</p>
            <div className="m-ai-quick-list">
              {QUICK_QUESTIONS.map((question) => (
                <button
                  type="button"
                  className="m-ai-quick"
                  key={question.text}
                  onClick={() => send(question.text)}
                >
                  <span className="m-ai-quick-icon">
                    <MobileIcon name={question.icon} size={20} />
                  </span>
                  <span>{question.text}</span>
                  <span className="m-ai-quick-arrow">›</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="m-ai-thread">
            {messages.map((message) => (
              <div
                className={`m-ai-message is-${message.role}`}
                key={message.id}
                onPointerDown={() => {
                  if (typing?.id !== message.id) startPress(message)
                }}
                onPointerUp={stopPress}
                onPointerCancel={stopPress}
                onPointerLeave={stopPress}
                onClick={() => {
                  if (typing?.id === message.id) finishTyping()
                }}
              >
                {message.role === 'assistant' && message.tools && message.tools.length > 0 ? (
                  <div className="m-ai-tool-tags">
                    {message.tools.map((tool) => (
                      <span key={tool}>已查询：{TOOL_TEXT[tool] ?? tool}</span>
                    ))}
                  </div>
                ) : null}
                <div className="m-ai-bubble">
                  {displayContent(message)}
                  {typing?.id === message.id && typing.shown < typing.total ? (
                    <span className="m-ai-caret" />
                  ) : null}
                </div>
              </div>
            ))}

            {asking ? (
              <div className="m-ai-message is-assistant">
                <div className="m-ai-bubble m-ai-thinking" aria-label="正在思考">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            ) : null}

            {error ? (
              <button
                type="button"
                className="m-ai-retry"
                onClick={() => {
                  if (retryConversationRef.current.length > 0) {
                    void requestReply(retryConversationRef.current)
                  }
                }}
              >
                网络开小差了，点我重试
              </button>
            ) : null}
          </div>
        )}
      </div>

      <div className="m-ai-composer">
        <div className="m-ai-input-wrap">
          <textarea
            ref={inputRef}
            className="m-ai-input"
            rows={1}
            value={draft}
            disabled={asking || Boolean(typing)}
            enterKeyHint="send"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                send()
              }
            }}
          />
          <button
            type="button"
            className="m-ai-send"
            aria-label="发送"
            disabled={asking || Boolean(typing) || draft.trim() === ''}
            onClick={() => send()}
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M12 19V5m0 0-6 6m6-6 6 6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>

      <MobileToastHost items={[toast]} />
    </div>
  )
}
