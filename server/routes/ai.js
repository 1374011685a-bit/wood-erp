import express from 'express'
import { writeLog } from '../boot-log.js'
import { TOOL_LABELS, TOOL_SPECS, runTool } from '../aiTools.js'
import { seesMoney } from '../permissions.js'

const router = express.Router()

/**
 * AI 助手 —— 接 DeepSeek（走的是 OpenAI 兼容协议，换别的兼容服务也能用）。
 *
 * 一问一答 + **只读查询工具**：前端把最近的几条对话发过来，这里转发给 DeepSeek；
 * 模型如果决定要查数据，会回一个 `tool_calls`，我们跑完再把结果塞回去让它继续答。
 * 最多来回 3 轮，避免模型钻牛角尖把接口拖死。没有会话持久化、没有流式输出。
 *
 * 配置全在读环境变量（本地写在 `server/.env`，已 gitignore）：
 *   DEEPSEEK_API_KEY   必填，没配就返回一句中文提示，不是 500
 *   DEEPSEEK_BASE_URL  选填，默认官方 https://api.deepseek.com
 *   DEEPSEEK_MODEL     选填，默认 deepseek-chat
 */
const baseUrl = () =>
  String(process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '')
const model = () => String(process.env.DEEPSEEK_MODEL || 'deepseek-chat')

const SYSTEM_PROMPT = `你是「立川云木材管理系统」里的助手，服务的是木材贸易公司（樟子松、落叶松这类）。

回答要求：
- 用简体中文，直接给结论，别啰嗦；数字带上单位。
- **凡是要具体数据（库存多少方、某包多大、某张单什么情况），必须先调工具查**，不要凭印象编。
- 查不到就说查不到，别猜。工具返回空的时候，如实说「没有符合条件的记录」。
- 用户问「现在什么情况 / 该注意什么 / 给我点建议 / 最近怎么样」这类问题时：
  **先调 query_overview** 拿经营快照，再基于里面的真实数字给建议。
- **可以也应该给建议** —— 但要满足两条：① 建议要引用你查到的数字（「樟子松压了 X 方」
  而不是「注意库存积压」）；② 给具体的下一步（先出哪个规格、该催哪张合同），
  不要只讲大道理。拿不准的地方明说不确定，别硬编一个理由。
- 只回答和本系统业务（采购入库、出库、库存、改包、码单、合同）相关的问题；
  无关的闲聊礼貌带过。
- 工具结果里的字段名是中文，直接引用即可。立方保留 4 位小数、金额 2 位。`

/** 一次最多带多少轮上下文（用户 + 助手算两条） */
const MAX_MESSAGES = 20
/** 工具来回最多几轮 */
const MAX_ROUNDS = 3

/** 调一次 DeepSeek，返回解析好的 JSON */
async function callDeepSeek(apiKey, messages) {
  const response = await fetch(`${baseUrl()}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model(),
      messages,
      tools: TOOL_SPECS,
      // 允许模型自己决定要不要查；查了就必须查完再答
      tool_choice: 'auto',
    }),
    // 别让一个卡住的请求把连接占死
    signal: AbortSignal.timeout(60000),
  })

  const text = await response.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  return { response, data, text }
}

router.post('/chat', async (req, res) => {
  const apiKey = String(process.env.DEEPSEEK_API_KEY ?? '').trim()
  if (!apiKey) {
    return res.status(400).json({
      error:
        '还没配 DeepSeek 的 Key：在 server/.env 里加一行 DEEPSEEK_API_KEY=sk-xxx，重启后端即可。',
    })
  }

  const raw = Array.isArray(req.body?.messages) ? req.body.messages : []
  const messages = raw
    .map((one) => ({
      role: one?.role === 'assistant' ? 'assistant' : 'user',
      content: String(one?.content ?? '').trim(),
    }))
    .filter((one) => one.content !== '')
    .slice(-MAX_MESSAGES)
  if (messages.length === 0) {
    return res.status(400).json({ error: '说点什么再发吧' })
  }

  try {
    /**
     * 金额按角色裁：看不到金额的角色，工具返回的 JSON 里就没有金额字段 ——
     * 模型看不到，也就无从说出口（不是"让它别说"）。
     */
    const money = seesMoney(req.user?.role)
    const convo = [{ role: 'system', content: SYSTEM_PROMPT }, ...messages]
    const usedTools = []
    let reply = ''
    let usedModel = model()

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const { response, data, text } = await callDeepSeek(apiKey, convo)

      if (!response.ok) {
        // 原始报文只进服务端日志，回给前端的是一句人话
        const detail = String(data?.error?.message ?? text ?? '').slice(0, 300)
        writeLog(`[ai] DeepSeek ${response.status}：${detail}`)
        return res
          .status(502)
          .json({ error: `DeepSeek 调用失败（${response.status}）：${detail || '没有详细信息'}` })
      }

      usedModel = data?.model ?? usedModel
      const message = data?.choices?.[0]?.message
      if (!message) break

      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
      if (calls.length === 0) {
        reply = String(message.content ?? '').trim()
        break
      }

      // 带上 tool_calls 的 assistant 消息必须原样回填，否则下一轮对不上号
      convo.push(message)
      for (const call of calls) {
        const name = String(call?.function?.name ?? '')
        let args = {}
        try {
          args = JSON.parse(call?.function?.arguments || '{}')
        } catch {
          args = {}
        }
        const result = runTool(name, args, { seesMoney: money })
        writeLog(`[ai] 查了 ${name}(${JSON.stringify(args)}) → ${JSON.stringify(result).slice(0, 200)}`)
        if (TOOL_LABELS[name] && !usedTools.includes(TOOL_LABELS[name])) {
          usedTools.push(TOOL_LABELS[name])
        }
        convo.push({
          role: 'tool',
          tool_call_id: call?.id ?? '',
          content: JSON.stringify(result).slice(0, 8000),
        })
      }
    }

    if (!reply) {
      return res
        .status(502)
        .json({ error: 'AI 绕了几圈也没给出结果，换个问法再试一次吧' })
    }

    res.json({ reply, model: usedModel, tools: usedTools })
  } catch (err) {
    writeLog(`[ai] 调用异常：${err?.stack ?? err}`)
    const reason = err?.name === 'TimeoutError' ? '请求超时（60 秒）' : err?.message ?? err
    res.status(502).json({ error: `连不上 DeepSeek：${reason}` })
  }
})

export default router
