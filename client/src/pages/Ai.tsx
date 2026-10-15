import { useEffect, useRef, useState } from 'react'
import { askAi, type AiMessage } from '../api'
import { PageHead } from '../components/Ui'

/**
 * AI 助手 —— 最简的一版：一问一答的对话框。
 *
 * 这一版刻意不做的事：不存历史（刷新就没了）、不喂业务数据、不做流式输出。
 * 先把「能通上 DeepSeek」这条链路跑通，后面再往上加。
 */
export default function Ai() {
  /** 助手那条消息额外记一笔「这次查了什么」，用来让用户知道数据是查出来的 */
  const [messages, setMessages] = useState<(AiMessage & { tools?: string[] })[]>([])
  const [draft, setDraft] = useState('')
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState('')
  const listRef = useRef<HTMLDivElement | null>(null)

  // 来新消息就滚到底
  useEffect(() => {
    const box = listRef.current
    if (box) box.scrollTop = box.scrollHeight
  }, [messages, asking])

  const send = async () => {
    const text = draft.trim()
    if (!text || asking) return
    const next: (AiMessage & { tools?: string[] })[] = [
      ...messages,
      { role: 'user', content: text },
    ]
    setMessages(next)
    setDraft('')
    setError('')
    setAsking(true)
    try {
      const result = await askAi(next)
      setMessages([
        ...next,
        { role: 'assistant', content: result.reply, tools: result.tools ?? [] },
      ])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI 调用失败')
    } finally {
      setAsking(false)
    }
  }

  return (
    <section className="ai-page">
      <PageHead
        title="AI 助手"
        subtitle="接的是 DeepSeek。先把问题打进去试试；这一版不会记住历史，刷新就清空"
      />

      <div className="card ai-card">
        <div className="ai-list" ref={listRef}>
          {messages.length === 0 && (
            <p className="ai-empty">
              试着问一句，比如「樟子松一般怎么码放」「出库单要注意什么」。
            </p>
          )}
          {messages.map((one, index) => (
            <div
              key={`${index}-${one.role}`}
              className={one.role === 'user' ? 'ai-bubble ai-bubble-user' : 'ai-bubble'}
            >
              {one.content}
              {one.tools && one.tools.length > 0 && (
                <span className="ai-tools">已查询：{one.tools.join(' / ')}</span>
              )}
            </div>
          ))}
          {asking && <div className="ai-bubble ai-bubble-typing">正在想…</div>}
        </div>

        {error && <p className="ai-error">{error}</p>}

        <div className="ai-compose">
          <textarea
            className="input ai-input"
            rows={2}
            placeholder="问点什么…（Enter 发送，Shift + Enter 换行）"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void send()
              }
            }}
          />
          <button
            type="button"
            className="btn btn-primary ai-send"
            disabled={asking || draft.trim() === ''}
            onClick={() => void send()}
          >
            {asking ? '发送中…' : '发送'}
          </button>
        </div>
      </div>
    </section>
  )
}
