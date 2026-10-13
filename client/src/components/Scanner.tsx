import { useEffect, useRef, useState } from 'react'
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode'

/**
 * 手机扫标签二维码。
 *
 * 只扫 QR 格式；扫到就交给 onScan 处理（自己不做业务判断）。
 * 摄像头权限被拒 / 没有摄像头，都会给一句中文提示，不让用户对着黑屏猜。
 *
 * 注意：getUserMedia 只在「安全上下文」可用 ——
 *   http://localhost 算安全上下文，能开；
 *   用局域网 IP（http://192.168.x.x）打开就不算，浏览器会直接拒绝。
 */
const VIEW_ID = 'scanner-view'

export default function Scanner({
  open,
  onClose,
  onScan,
}: {
  open: boolean
  /** 关弹窗（会把摄像头关掉） */
  onClose: () => void
  /** 扫到码：抛异常就当作这一码没处理成功 */
  onScan: (code: string) => Promise<void> | void
}) {
  const [error, setError] = useState('')
  const [starting, setStarting] = useState(false)
  const scannerRef = useRef<Html5Qrcode | null>(null)
  const lastRef = useRef({ code: '', at: 0 })
  const onScanRef = useRef(onScan)
  onScanRef.current = onScan

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setError('')
    setStarting(true)

    const scanner = new Html5Qrcode(VIEW_ID, {
      formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
      verbose: false,
    })
    scannerRef.current = scanner

    scanner
      .start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 220, height: 220 } },
        (decoded) => {
          const now = Date.now()
          // 同一个码 2 秒内不重复回调（摄像头会连续识别）
          if (decoded === lastRef.current.code && now - lastRef.current.at < 2000) {
            return
          }
          lastRef.current = { code: decoded, at: now }
          void onScanRef.current(decoded)
        },
        () => {
          // 单帧识别失败很正常，不用打扰用户
        },
      )
      .then(() => {
        if (!cancelled) setStarting(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setStarting(false)
        /**
         * html5-qrcode 会把原始错误重新包一层（name 变成 Error），
         * 真正的原因只出现在 message 里，所以这里连 message 一起判断。
         */
        const text =
          err && typeof err === 'object' && 'message' in err
            ? String((err as { message?: string }).message ?? '')
            : String(err)
        if (/NotAllowedError|PermissionDeniedError|Permission|permission denied/i.test(text)) {
          setError('请在浏览器设置里允许摄像头权限')
        } else if (/NotFoundError|DevicesNotFoundError|Requested device not found/i.test(text)) {
          setError('没找到可用的摄像头')
        } else if (/NotReadableError|TrackStartError|Could not start video source/i.test(text)) {
          setError('摄像头被别的程序占用了，关掉再试一次')
        } else {
          setError(
            '打不开摄像头：' +
              text +
              '（http 页面只有 localhost 能用摄像头，局域网 IP 需要 https）',
          )
        }
      })

    return () => {
      cancelled = true
      const instance = scannerRef.current
      scannerRef.current = null
      if (!instance) return
      instance
        .stop()
        .then(() => instance.clear())
        .catch(() => {
          // 还没 start 成功就关了，忽略
        })
    }
  }, [open])

  if (!open) return null

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal modal-narrow" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h2 className="modal-title">扫一扫</h2>
          <button className="btn btn-sm btn-quiet" onClick={onClose}>
            关闭
          </button>
        </div>
        <p className="hint" style={{ marginTop: 0 }}>
          对着包上的二维码标签扫，扫到会自动加进明细（可以连着扫多包）
        </p>
        <div className="scanner-box">
          {/* html5-qrcode 自己往这个 div 里塞 video */}
          <div id={VIEW_ID} className="scanner-view" />
        </div>
        {starting && !error && <p className="muted">正在打开摄像头…</p>}
        {error && <p className="login-error">{error}</p>}
      </div>
    </div>
  )
}
