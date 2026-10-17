/**
 * 错误三段式：**原因 + 怎么办 + 错误码**。
 *
 * 现在全站只把服务端那一句人话弹出来（「服务器开小差了」「包号 P1 已经存在」），
 * 用户看完还是不知道下一步该干嘛，截图发管理员时也没个定位依据。
 * 这里把三种错误归一化：
 *   - 网络层（fetch 挂了 / 断网）→ 让用户检查网络，可以重试
 *   - 服务端业务错（4xx）→ 原样展示，告诉用户"照提示改一下"，不用重试
 *   - 服务端故障（5xx）→ 告诉用户"稍后重试"，并带上 HTTP 码
 */
export type ErrorInfo = {
  /** 一句话原因（服务端原文优先） */
  title: string
  /** 怎么办 */
  hint: string
  /** 错误码：HTTP 500 / 网络中断 / 空串表示没有可展示的码 */
  code: string
  /** 值不值得给「重试」按钮 */
  canRetry: boolean
}

const NETWORK_HINT = '检查一下网络，或者稍后再试'

export function describeError(err: unknown): ErrorInfo {
  const raw = err instanceof Error ? err.message : String(err ?? '')
  const message = raw.trim() || '操作没成功'
  const status = (err as { status?: number } | null)?.status

  // 网络层：fetch 抛 TypeError（Failed to fetch / Load failed）
  if (err instanceof TypeError || /Failed to fetch|Load failed|NetworkError|ERR_/i.test(raw)) {
    return { title: '网络不可用', hint: NETWORK_HINT, code: '网络中断', canRetry: true }
  }

  if (typeof status === 'number') {
    if (status >= 500) {
      return {
        title: message,
        hint: '这是服务端的问题，稍后重试；一直不行请联系管理员',
        code: `HTTP ${status}`,
        canRetry: true,
      }
    }
    if (status === 403) {
      return { title: message, hint: '这个账号没有该操作的权限', code: 'HTTP 403', canRetry: false }
    }
    if (status === 401) {
      return { title: message, hint: '登录状态过期了，重新登录一下', code: 'HTTP 401', canRetry: false }
    }
    // 其它 4xx：业务校验，照着提示改
    return { title: message, hint: '按上面的提示改一下再存', code: `HTTP ${status}`, canRetry: false }
  }

  return { title: message, hint: '稍后再试一次', code: '', canRetry: true }
}
