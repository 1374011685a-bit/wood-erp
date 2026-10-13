import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { QRCodeSVG } from 'qrcode.react'
import { fetchBaleDetail } from '../api'
import { formatCubic } from '../utils/num'

/**
 * 打印小标签（不干胶 60×40mm / 80×60mm）。
 *
 * 不是打整单，是每个包一张：左边二维码，右边品名/等级/规格/包号/片数×件数/立方。
 * 二维码内容：MZ|码单号|包号（码单号 = 条码号），出库时用手机扫它。
 *
 * 地址：/label/print?ids=1,2,3&size=60x40
 */
type LabelBale = {
  id: number
  baleNo: string
  barcode: string
  blNo: string
  species: string
  grade: string
  spec: string
  pieces: number
  bundles: number
  cubic: number
}

const SIZES = {
  '100x60': { w: 100, h: 60, label: '100 × 60mm' },
  '60x40': { w: 60, h: 40, label: '60 × 40mm' },
  '80x60': { w: 80, h: 60, label: '80 × 60mm' },
} as const

type SizeKey = keyof typeof SIZES

/** 二维码内容：MZ|码单号|包号 */
const qrOf = (bale: LabelBale) => `MZ|${bale.barcode}|${bale.baleNo}`

export default function LabelPrint() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const idsParam = params.get('ids') ?? ''
  const ids = useMemo(
    () =>
      idsParam
        .split(',')
        .map((one) => Number(one.trim()))
        .filter((id) => Number.isInteger(id) && id > 0),
    [idsParam],
  )

  const [size, setSize] = useState<SizeKey>(
    (params.get('size') ?? '100x60') as SizeKey,
  )
  const [bales, setBales] = useState<LabelBale[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    Promise.all(ids.map((id) => fetchBaleDetail(id)))
      .then((list) => {
        if (cancelled) return
        setBales(
          list.map((bale) => {
            // 规格取包里的第一行（混装包按主规格打；标签上只够写一行）
            const main = bale.items[0]
            return {
              id: bale.id,
              baleNo: bale.bale_no ?? '',
              barcode: bale.barcode ?? '',
              blNo: bale.bl_no ?? '',
              species: main?.species ?? '',
              grade: main?.grade ?? '',
              spec: main
                ? `${main.thickness}×${main.width}×${main.length}`
                : '—',
              pieces: bale.pieces ?? 0,
              bundles: 1,
              cubic: bale.cubic ?? 0,
            }
          }),
        )
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '读取包失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [ids])

  const dim = SIZES[size]

  return (
    <div className="label-page" style={{ ['--label-w' as string]: `${dim.w}mm`, ['--label-h' as string]: `${dim.h}mm` }}>
      {/* 屏幕上才看的工具条：打印时整条不出现 */}
      <div className="label-toolbar no-print">
        <button className="btn btn-sm" onClick={() => navigate(-1)}>
          ← 返回
        </button>
        <span className="label-toolbar-title">打印标签（{bales.length} 张）</span>
        <span className="muted">尺寸</span>
        <div className="seg">
          {(Object.keys(SIZES) as SizeKey[]).map((key) => (
            <button
              key={key}
              type="button"
              className={key === size ? 'seg-item is-active' : 'seg-item'}
              onClick={() => setSize(key)}
            >
              {SIZES[key].label}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <span className="muted">
          一页 A4 排 {Math.floor(200 / dim.w)} 列 × {Math.floor(287 / dim.h)} 行 ={' '}
          {Math.floor(200 / dim.w) * Math.floor(287 / dim.h)} 个
        </span>
        <button className="btn btn-sm btn-primary" onClick={() => window.print()}>
          {loading ? '加载中…' : '打印'}
        </button>
      </div>

      {error && <p className="label-error no-print">{error}</p>}

      <div className="label-sheet">
        {bales.map((bale) => (
          <div className="label-card" key={bale.id}>
            <div className="label-qr">
              <QRCodeSVG value={qrOf(bale)} level="M" marginSize={2} />
            </div>
            <div className="label-info">
              <div className="label-name">
                {bale.species}
                {bale.grade ? ` / ${bale.grade}` : ''}
              </div>
              <div className="label-line">{bale.spec}</div>
              <div className="label-line label-bale">
                包号 {bale.baleNo || '—'}
              </div>
              <div className="label-line">提单号 {bale.blNo || '—'}</div>
              <div className="label-line">
                {bale.pieces} 片 × {bale.bundles} 件
              </div>
              <div className="label-line">{formatCubic(bale.cubic)} m³</div>
            </div>
            <div className="label-foot">立川云提供支持</div>
          </div>
        ))}
      </div>
    </div>
  )
}
