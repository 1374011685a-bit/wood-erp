import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  deleteBale,
  fetchBaleDetail,
  fetchBales,
  fetchShipments,
  fetchContractPicker,
  fetchDict,
  updateBale,
  type BaleItemLine,
  type BaleRow,
  type ContractPickerRow,
  type DictAll,
  type ShipmentRow,
} from '../api'
import {
  EmptyState,
  Loading,
  PageHead,
  Pager,
  TableSkeleton,
  ToastHost,
} from '../components/Ui'
import Breadcrumb from '../components/Breadcrumb'
import { tapLight, tapHeavy } from '../utils/haptics'
import { roundTo, formatCubic } from '../utils/num'
import { readListCache, writeListCache } from '../utils/listCache'
import { useRole } from '../hooks/useRole'
import { seesMoney } from '../permissions'
import { can } from '../permissions'

const PAGE_SIZE = 50

const STATUS_TEXT: Record<BaleRow['status'], string> = {
  in_stock: '在库',
  shipped: '已出库',
}

/**
 * 采购入库明细：专门用来看和查的页面。
 * 上半部分是「合同到货进度」（合同多少方、入了多少、还差多少方），
 * 下半部分是一包一行的明细，点进度表的某一行就直接筛这张合同。
 */
export default function Bales() {
  /**
   * 看不到金额的角色：列表里本来就没有金额列，
   * 这里只用来决定「保存后金额变了」那句提示要不要带上具体数字
   * （后端不会把 amount_before / amount_after 给这些角色）。
   */
  const money = seesMoney(useRole())
  /** 编辑 / 删除码单要 bale.write；打印标签是只读操作，谁都能用 */
  const canWrite = can(useRole(), 'bale.write')

  const navigate = useNavigate()
  const [rows, setRows] = useState<BaleRow[]>([])
  const [total, setTotal] = useState(0)
  /** 当前筛选范围内的在库包数 / 在库立方（后端随列表一起返回的合计） */
  const [totalInStock, setTotalInStock] = useState(0)
  const [cubicInStock, setCubicInStock] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  // 勾选要批量打印标签的包
  const [labelPicked, setLabelPicked] = useState<number[]>([])
  /**
   * 表头那个全选框。
   *
   * React 里复选框的"半选"（部分勾选）没有对应的属性可写，只能拿 ref 手动设
   * `indeterminate`；所以下面用 effect 跟着勾选状态同步。
   */
  const pickAllRef = useRef<HTMLInputElement | null>(null)
  /** 当前页所有行的 id —— 全选的范围就是"这一页" */
  const pageIds = rows.map((row) => row.id)
  const pickedOnPage = pageIds.filter((id) => labelPicked.includes(id))
  const allPicked = pageIds.length > 0 && pickedOnPage.length === pageIds.length
  useEffect(() => {
    if (pickAllRef.current) {
      pickAllRef.current.indeterminate = pickedOnPage.length > 0 && !allPicked
    }
  }, [pickedOnPage.length, allPicked])
  /**
   * 换页 / 换筛选之后，勾选作废：全选的范围只有"当前页"，
   * 留着上一页的 id 会让「批量打印（N）」数出一个页面上看不见的数字。
   * 按当前页的 id 串做依赖：同一页数据刷新（id 没变）不会把勾选清掉。
   */
  const pageIdsKey = pageIds.join(',')
  useEffect(() => {
    setLabelPicked([])
  }, [pageIdsKey])
  /**
   * 行内「⋯」菜单开在哪一行（存这一包的 id）。
   *
   * 操作列原来挂着「打印标签 / 编辑 / 删除」三个文字按钮，光这一列就占 230px ——
   * 1366 屏下整列都在屏幕外，要横滑才能点到。现在只把最常用的「打印标签」留在明面上，
   * 编辑 / 删除收进「⋯」里。
   */
  const [menuPos, setMenuPos] = useState<{ id: number; x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  /** 点空白处 / 滚动表格都收起「⋯」菜单（和右上角账号菜单一样的苹果式行为） */
  useEffect(() => {
    if (!menuPos) return
    const closeOnOutside = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuPos(null)
    }
    const closeOnScroll = () => setMenuPos(null)
    document.addEventListener('mousedown', closeOnOutside)
    window.addEventListener('scroll', closeOnScroll, true)
    return () => {
      document.removeEventListener('mousedown', closeOnOutside)
      window.removeEventListener('scroll', closeOnScroll, true)
    }
  }, [menuPos])

  const [progress, setProgress] = useState<ContractPickerRow[]>([])
  const [progressLoading, setProgressLoading] = useState(false)

  /**
   * 三层结构（合同 → 提单 → 包）的"当前在哪一层"记在**地址栏**里：
   *   ?contract=A11            → 看这张合同下的所有包
   *   ?contract=A11&shipment=224 → 再窄到某一张提单
   *   ?shipment=235            → 没关联合同的提单（只有提单、没有合同）
   * 好处：刷新、分享链接、浏览器后退都不丢位置。
   */
  const [params, setParams] = useSearchParams()
  const contract = params.get('contract') ?? ''
  const shipmentId = Number(params.get('shipment')) || 0

  const [input, setInput] = useState({
    keyword: '',
    status: '' as '' | 'in_stock' | 'shipped',
  })
  const [filters, setFilters] = useState({ keyword: '', status: '' as '' | 'in_stock' | 'shipped' })
  const [reloadToken, setReloadToken] = useState(0)
  const [dict, setDict] = useState<DictAll>({ species: [], grade: [] })

  /** L2 提单层：这张合同下的提单 + 没填合同号的那几张（底部兜底提示用） */
  const [shipments, setShipments] = useState<ShipmentRow[]>([])
  const [unlinkedShipments, setUnlinkedShipments] = useState<ShipmentRow[]>([])
  const [shipmentsLoading, setShipmentsLoading] = useState(false)

  /**
   * 空提单不上 L2：**0 包 + 0 明细**的提单没有货、也没有账，
   * 显示出来只会是一行「原 0 / 现 0 · 没有包」，看着像账丢了。
   * （后端删包/删单时已经会把这些提单软删；这里再兜一层，万一库里有残留也不显示。）
   *
   * ⚠️ 「有账没包」的不算空 —— 跨提单改包后的源提单就是这种（原 5 / 现 0），
   * 那一行要留着，用户才能看到「货在别人的包里」。
   */
  const visibleShipments = shipments.filter(
    (one) => !(one.bale_total === 0 && one.original_cubic === 0),
  )
  const visibleUnlinked = unlinkedShipments.filter(
    (one) => !(one.bale_total === 0 && one.original_cubic === 0),
  )

  // 编辑码单
  const emptyLine = (): BaleItemLine => ({
    species: '',
    grade: '',
    thickness: 0,
    width: 0,
    length: 0,
    pieces: 1,
    cubic: 0,
  })
  const [editOpen, setEditOpen] = useState(false)
  const [editId, setEditId] = useState(0)
  const [editNo, setEditNo] = useState('')
  const [editBarcode, setEditBarcode] = useState('')
  const [editBoxNo, setEditBoxNo] = useState('')
  const [editLines, setEditLines] = useState<BaleItemLine[]>([])
  const [editError, setEditError] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const [baleDeleteTarget, setBaleDeleteTarget] = useState<BaleRow | null>(null)
  /** 有缓存时后台静默刷新中 */
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(
    async (
      nextFilters: typeof filters,
      nextContract: string,
      nextShipmentId: number,
      nextOffset: number,
    ) => {
      // 缓存先渲染 + 后台静默刷新（L3 包列表）
      const cacheKey = `bales:${JSON.stringify(nextFilters)}:${nextContract}:${nextShipmentId}:${nextOffset}`
      const cached = readListCache<{
        rows: BaleRow[]
        total: number
        totalInStock: number
        cubicInStock: number
      }>(cacheKey)
      if (cached) {
        setRows(cached.rows)
        setTotal(cached.total)
        setTotalInStock(cached.totalInStock)
        setCubicInStock(cached.cubicInStock)
        setRefreshing(true)
      } else {
        setLoading(true)
      }
      try {
        const page = await fetchBales({
          keyword: nextFilters.keyword.trim() || undefined,
          status: nextFilters.status,
          /**
           * 三层筛选：选了提单就按提单（最精确）；只选合同就按"提单的合同号"筛；
           * 都没选就不过滤（全部包，含没关联合同那些 → 「全部合同」的兜底）。
           */
          ...(nextShipmentId > 0
            ? { shipment_id: nextShipmentId }
            : nextContract
              ? { contract_no: nextContract }
              : {}),
          limit: PAGE_SIZE,
          offset: nextOffset,
        })
        setRows(page.rows)
        setTotal(page.total)
        setTotalInStock(page.total_in_stock ?? 0)
        setCubicInStock(page.cubic_in_stock ?? 0)
        writeListCache(cacheKey, {
          rows: page.rows,
          total: page.total,
          totalInStock: page.total_in_stock ?? 0,
          cubicInStock: page.cubic_in_stock ?? 0,
        })
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载失败')
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [],
  )

  const loadProgress = useCallback(async () => {
    setProgressLoading(true)
    try {
      const page = await fetchContractPicker({ limit: 100 })
      setProgress(page.rows)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载合同进度失败')
    } finally {
      setProgressLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(filters, contract, shipmentId, offset)
  }, [load, filters, contract, shipmentId, offset, reloadToken])

  /**
   * L2 提单层的数据。
   *
   * 只在"选了合同"或"URL 里带着提单"时才拉；两个都空就清掉（回到「全部合同」）。
   * `unlinkedShipments` 是没填合同号的提单：
   *   - 选了合同时 → 在 L2 底部列出来，免得那些货"凭空消失"
   *   - 只有 ?shipment= 时 → 用它把提单号查出来给面包屑显示
   */
  useEffect(() => {
    if (!contract && !shipmentId) {
      setShipments([])
      setUnlinkedShipments([])
      return
    }
    let cancelled = false
    setShipmentsLoading(true)
    Promise.all([
      contract ? fetchShipments({ contract_no: contract, limit: 100 }) : null,
      fetchShipments({ unlinked: true, limit: 100 }),
    ])
      .then(([mine, unlinked]) => {
        if (cancelled) return
        setShipments(mine?.rows ?? [])
        setUnlinkedShipments(unlinked.rows)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '加载提单失败')
      })
      .finally(() => {
        if (!cancelled) setShipmentsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [contract, shipmentId, reloadToken])

  useEffect(() => {
    void loadProgress()
  }, [loadProgress, reloadToken])

  useEffect(() => {
    void fetchDict()
      .then(setDict)
      .catch(() => {
        // 拉不到就退化成手填
      })
  }, [])

  const handleSearch = () => {
    setOffset(0)
    setFilters({ keyword: input.keyword.trim(), status: input.status })
  }

  /**
   * 换层（点合同 / 点提单 / 面包屑回退）。
   *
   * ⚠️ 每次换层都要把 offset 归零：不然在第 2 页点进下一层，会停在一个空页上。
   * 用 `setParams` 默认的 push，浏览器后退就能回上一层。
   */
  const selectContract = (no: string) => {
    setOffset(0)
    setParams(no ? { contract: no } : {})
  }

  const selectShipment = (id: number, keepContract: string) => {
    setOffset(0)
    const next: Record<string, string> = {}
    // 没关联合同的提单：URL 里不写空的 contract（用户定的：只带 shipment）
    if (keepContract) next.contract = keepContract
    if (id > 0) next.shipment = String(id)
    setParams(next)
  }

  const clearDrill = () => {
    setOffset(0)
    setParams({})
  }

  /** 提单号：两层列表里找一下（URL 直接进来时列表还没回来，先显示 #id，回来会自动刷新） */
  const blNoOf = (id: number) =>
    (shipments.find((one) => one.id === id) ?? unlinkedShipments.find((one) => one.id === id))
      ?.bl_no ?? `#${id}`

  /**
   * L2 的两列立方：
   *   原   = 这一票**原本入库**的立方（入库明细合计；改包按来源各计各的，不会动它）
   *   现在 = 这一票下**现在活着的包**的立方合计（出库只改包的状态、不动立方，
   *          所以这个数不会因为发货变小）
   *
   * 两个数不等 = 这一票被改包混过：活包里混进了别的提单的货，或者自己的货被并走了。
   * 留 0.00005 的余量：两个数一个来自活包、一个来自明细，浮点末位可能差一丝。
   */
  const isMixedShipment = (one: ShipmentRow) =>
    Math.abs(one.bale_cubic - one.original_cubic) >= 0.00005

  /**
   * 「现在」那个数的口径（桌面端是表格里的一格，手机端是一行里的文字，
   * 两处共用一个算法，免得口径走岔）：混过包就带橙字 + 一句说清差额的悬停提示。
   */
  const nowInfo = (one: ShipmentRow) => {
    const text = formatCubic(one.bale_cubic)
    if (!isMixedShipment(one)) return { text, mixed: false, title: '' }
    const diff = formatCubic(roundTo(Math.abs(one.bale_cubic - one.original_cubic), 4))
    const share =
      `这一票现在的包合计 ${text} 方；原本入库 ${formatCubic(one.original_cubic)} 方，差额 ${diff} 方`
    return {
      text,
      mixed: true,
      title:
        one.bale_cubic > one.original_cubic
          ? `${share}是改包时从别的提单混进来的`
          : `${share}改包时被并到别的提单的包里了`,
    }
  }

  /** 「现在」那一列：混过包的标橙字，鼠标悬停说清差额从哪来 */
  const shipmentNowCell = (one: ShipmentRow) => {
    const now = nowInfo(one)
    if (!now.mixed) return <td className="num">{now.text}</td>
    return (
      <td className="num">
        <span className="cubic-mixed" title={now.title}>
          {now.text}
        </span>
      </td>
    )
  }

  /** 提单号旁边那个「混提单」标签 */
  const mixedTag = (one: ShipmentRow) =>
    isMixedShipment(one) ? (
      <span className="tag tag-out" title="这票货的包和别的提单的货混在一起了">
        混提单
      </span>
    ) : null

  /**
   * L2 的状态：这一票的包全在库 / 全出库 / 出一部分。
   * 特例：自己一个包都不剩、但原本入过库 —— 货是被并进别人的包里了，不是凭空没了。
   */
  const shipmentStatus = (one: ShipmentRow) => {
    if (one.bale_total === 0) {
      return one.original_cubic > 0 ? (
        <span className="tag tag-out" title="这一票的货改包时被并到别的提单的包里了，包挂在对方那边">
          货在别人的包里
        </span>
      ) : (
        <span className="muted">没有包</span>
      )
    }
    const allIn = one.bale_in_stock === one.bale_total
    const text = allIn ? '全部在库' : one.bale_in_stock === 0 ? '全部出库' : '部分出库'
    return <span className={allIn ? 'tag tag-in' : 'tag tag-out'}>{text}</span>
  }

  /**
   * L2 手机端的一行：提单号 [标签] ｜ 原 / 现在 ｜ 状态。
   *
   * 桌面那张表在手机上八列摊不开（会被渲染成一格一卡的堆叠），所以手机端换成这一行。
   * 用普通函数而不是组件：它只是拼一段 JSX，定义成组件每次渲染都会换一个新类型。
   */
  const shipCompactRow = (
    row: ShipmentRow,
    { active, unlinked = false }: { active: boolean; unlinked?: boolean },
  ) => {
    const now = nowInfo(row)
    return (
      <button
        type="button"
        className={active ? 'ship-compact-row is-active' : 'ship-compact-row'}
        onClick={() => selectShipment(row.id, unlinked ? '' : contract)}
        title="点一下只看这张提单的包"
      >
        <span className="ship-compact-no">
          {row.bl_no}
          {/*
            未关联合同的行不再单独挂标签：它们本来就在「未关联合同的提单」这一小节里，
            标题已经说清了；小屏上一行放不下这个 5 字标签，会把状态挤到第二行。
          */}
          {mixedTag(row)}
        </span>
        <span className="ship-compact-cubic">
          原 {formatCubic(row.original_cubic)} · 现{' '}
          <b className={now.mixed ? 'cubic-mixed' : undefined} title={now.title}>
            {now.text}
          </b>
        </span>
        <span className="ship-compact-status">{shipmentStatus(row)}</span>
      </button>
    )
  }

  /** 「重置」只清关键词和状态，**保留**当前层级（用户定的：甲） */
  const handleReset = () => {
    setInput({ keyword: '', status: '' })
    setFilters({ keyword: '', status: '' })
    setOffset(0)
  }

  const openBaleEdit = async (row: BaleRow) => {
    setError('')
    try {
      const detail = await fetchBaleDetail(row.id)
      setEditId(detail.id)
      setEditNo(detail.bale_no)
      setEditBarcode(detail.barcode)
      setEditBoxNo(detail.box_no ?? '')
      setEditLines(detail.items.length > 0 ? detail.items : [emptyLine()])
      setEditError('')
      setEditOpen(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : '打开失败')
    }
  }

  const submitBaleEdit = async () => {
    if (!editNo.trim()) {
      setEditError('包号不能为空')
      return
    }
    const items = editLines.filter((line) => line.species.trim())
    if (items.length === 0) {
      setEditError('至少要有一个规格（品名必填）')
      return
    }

    setEditSaving(true)
    setEditError('')
    try {
      const result = await updateBale(editId, {
        bale_no: editNo.trim(),
        box_no: editBoxNo.trim(),
        items: items.map((line) => ({
          species: line.species.trim(),
          grade: (line.grade ?? '').trim(),
          thickness: Number(line.thickness),
          width: Number(line.width),
          length: Number(line.length),
          pieces: Number(line.pieces),
          // 原样把这一行原来的单价带回去，后端就不会拿「最近入库价」重算金额
          unit_price: line.unit_price ?? 0,
        })),
      })
      setEditOpen(false)
      if (result.amount_changed) {
        /**
         * 财务字段变了就必须让用户看见。
         * 但看不到金额的角色拿不到具体数字（后端把 amount_before / amount_after 删了），
         * 这时只说「金额有变动」，不要打印 undefined。
         */
        setError(
          money && result.amount_before !== undefined
            ? `注意：这次保存后这一包对应的入库金额变了：${result.amount_before} → ${result.amount_after} 元，` +
                `请核对是不是自己改了单价（立方和单价都没动的话不会变）。`
            : '注意：这次保存后这一包对应的入库金额有变动，请找管理员或财务核对该单金额。',
        )
      } else {
        setNotice(
          money
            ? `已保存包号 ${editNo.trim()}，库存与金额都没变`
            : `已保存包号 ${editNo.trim()}，库存没变`,
        )
      }
      setReloadToken((n) => n + 1)
    } catch (err) {
      setEditError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setEditSaving(false)
    }
  }

  const confirmBaleDelete = async () => {
    if (!baleDeleteTarget) return
    try {
      await deleteBale(baleDeleteTarget.id)
      setNotice(
        `已删除 ${baleDeleteTarget.barcode || baleDeleteTarget.bale_no}，库存已同步减少`,
      )
      setBaleDeleteTarget(null)
      setReloadToken((n) => n + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
      setBaleDeleteTarget(null)
    }
  }

  const leftTotal = roundTo(
    progress.reduce((sum, row) => sum + (row.left_cubic ?? 0), 0),
    4,
  )

  return (
    <section>
      <datalist id="dict-species">
        {dict.species.map((item) => (
          <option key={item.id} value={item.name} />
        ))}
      </datalist>
      <datalist id="dict-grade">
        {dict.grade.map((item) => (
          <option key={item.id} value={item.name} />
        ))}
      </datalist>

      <PageHead
        title="采购入库明细"
        subtitle="看货的地方：上面盯合同还差多少方没到，下面一包一行查每一包的状态（提单在「采购入库」里录）"
      />

      {/*
        面包屑：按地址栏的参数生成，每段点一下退回那一层。
        最后一段是"当前层"，组件里固定不可点。
      */}
      <Breadcrumb
        items={
          shipmentId > 0
            ? [
                ...(contract
                  ? [
                      { label: '全部合同', onClick: clearDrill },
                      { label: contract, onClick: () => selectContract(contract) },
                    ]
                  : [{ label: '全部合同', onClick: clearDrill }]),
                { label: `提单 ${blNoOf(shipmentId)}` },
              ]
            : contract
              ? [
                  { label: '全部合同', onClick: clearDrill },
                  { label: contract },
                ]
              : [{ label: '全部合同' }]
        }
      />

      <ToastHost
        items={[
          notice
            ? {
                id: 'bale-notice',
                kind: 'success' as const,
                message: notice,
                onClose: () => setNotice(''),
              }
            : null,
          error
            ? {
                id: 'bale-error',
                kind: 'error' as const,
                message: error,
                onClose: () => setError(''),
              }
            : null,
        ]}
      />

      {/* 合同到货进度：合同多少方、入了多少、还差多少方 */}
      <div className="card">
        <h2 className="section-title">合同到货进度（立方）</h2>
        {progress.length === 0 && !progressLoading ? (
          <EmptyState text="还没有合同，先去「采购合同」建一份" />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>合同号</th>
                <th>供应商</th>
                <th>品名</th>
                <th className="num">合同立方 (m³)</th>
                <th className="num">已入库 (m³)</th>
                <th className="num">未到货 (m³)</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {progress.map((row) => (
                <tr
                  key={row.id}
                  // is-tappable：整行可点，手机端按下去要有反馈
                  className={`is-tappable${
                    contract === row.contract_no ? ' row-active' : ''
                  }`}
                  onClick={() => selectContract(contract === row.contract_no ? '' : row.contract_no)}
                  title="点一下看这张合同的提单和包"
                >
                  <td>{row.contract_no}</td>
                  <td>{row.partner || '—'}</td>
                  <td>{row.species_text || '—'}</td>
                  <td className="num">{formatCubic(row.total_qty)}</td>
                  <td className="num">{formatCubic(row.in_cubic)}</td>
                  <td className="num">{formatCubic(row.left_cubic)}</td>
                  <td>
                    <span className={row.status === '全部发货' ? 'tag tag-in' : 'tag tag-out'}>
                      {row.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={5} className="sheet-total-label">
                  合计（未到货）
                </td>
                <td className="num">{formatCubic(leftTotal)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        )}
        {progressLoading && <Loading />}
        {contract && (
          <p className="hint" style={{ marginTop: 12 }}>
            已按合同 {contract} 筛选；要看某一票就点下面提单那一行，再点一次可以取消。
          </p>
        )}
      </div>

      {/* ---------- L2 提单层：选了合同才出现 ---------- */}
      {contract && (
        <div className="drill-panel">
          <h2 className="section-title">这张合同下的提单</h2>
          {visibleShipments.length === 0 && visibleUnlinked.length === 0 && !shipmentsLoading ? (
            <EmptyState text="这张合同还没有提单" />
          ) : (
            /* ship-list：L2 提单表（桌面端行高压到 42px、几个列宽写死，见 index.css） */
            <table className="table ship-list">
              <thead>
                <tr>
                  <th>提单号</th>
                  <th>供应商</th>
                  <th>到货日期</th>
                  <th className="num">包数</th>
                  <th className="num">在库</th>
                  <th className="num">原 (m³)</th>
                  <th className="num">现在 (m³)</th>
                  <th>状态</th>
                </tr>
              </thead>
              {visibleShipments.length > 0 && (
                <tbody>
                  {visibleShipments.map((row) => (
                    <tr
                      key={row.id}
                      className={`is-tappable${shipmentId === row.id ? ' row-active' : ''}`}
                      onClick={() => selectShipment(row.id, contract)}
                      title="点一下只看这张提单的包"
                    >
                      <td>
                        {row.bl_no} {mixedTag(row)}
                      </td>
                      <td>{row.supplier || '—'}</td>
                      <td>{row.arrival_date || '—'}</td>
                      <td className="num">{row.bale_total}</td>
                      <td className="num">{row.bale_in_stock}</td>
                      <td className="num">{formatCubic(row.original_cubic)}</td>
                      {shipmentNowCell(row)}
                      <td>{shipmentStatus(row)}</td>
                    </tr>
                  ))}
                </tbody>
              )}
              {/*
                没填合同号的提单：单独一段列在下面。
                不列的话，这些货在"按合同筛"的时候会凭空消失 ——
                它们的包只有回到「全部合同」才看得到。
              */}
              {visibleUnlinked.length > 0 && (
                <>
                  <tbody>
                    <tr>
                      <td colSpan={8} className="ship-group">
                        未关联合同的提单
                      </td>
                    </tr>
                  </tbody>
                  <tbody>
                    {visibleUnlinked.map((row) => (
                      <tr
                        key={row.id}
                        className={`is-tappable${shipmentId === row.id ? ' row-active' : ''}`}
                        onClick={() => selectShipment(row.id, '')}
                        title="这张提单没填合同号；点一下只看它的包"
                      >
                        <td>
                          {row.bl_no} <span className="tag tag-out">未关联合同</span> {mixedTag(row)}
                        </td>
                        <td>{row.supplier || '—'}</td>
                        <td>{row.arrival_date || '—'}</td>
                        <td className="num">{row.bale_total}</td>
                        <td className="num">{row.bale_in_stock}</td>
                        <td className="num">{formatCubic(row.original_cubic)}</td>
                        {shipmentNowCell(row)}
                        <td>{shipmentStatus(row)}</td>
                      </tr>
                    ))}
                  </tbody>
                </>
              )}
            </table>
          )}
          {shipmentsLoading && <Loading />}
          {visibleUnlinked.length > 0 && (
            <p className="hint" style={{ marginTop: 12 }}>
              另有 {visibleUnlinked.length} 张提单没填合同号，它们的包在「全部合同」下能看到。
            </p>
          )}

          {/*
            手机端（< 768px）用这一份「一行一条」：提单号 [标签] ｜ 原 / 现在 ｜ 状态。
            上面那张八列的表手机端整张收起来了（屏幕放不下，摊成一格一卡更难看）。
            桌面端不渲染这块 —— .ship-compact 的基类就是 display: none。
          */}
          <div className="ship-compact">
            {visibleShipments.length > 0 && (
              <ul className="ship-compact-list">
                {visibleShipments.map((row) => (
                  <li key={row.id}>
                    {shipCompactRow(row, { active: shipmentId === row.id })}
                  </li>
                ))}
              </ul>
            )}

            {visibleUnlinked.length > 0 && (
              <>
                <p className="ship-compact-group">未关联合同的提单</p>
                <ul className="ship-compact-list">
                  {visibleUnlinked.map((row) => (
                    <li key={row.id}>
                      {shipCompactRow(row, { active: shipmentId === row.id, unlinked: true })}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>
      )}

      {/* 包明细 */}
      <div className="toolbar">
        <input
          className="input input-wide"
          placeholder="包号 / 条码号 / 柜号 / 提单号 / 合同号"
          title="包号 / 条码号 / 柜号 / 提单号 / 合同号"
          value={input.keyword}
          onChange={(event) => setInput((prev) => ({ ...prev, keyword: event.target.value }))}
          onKeyDown={(event) => {
            if (event.key === 'Enter') handleSearch()
          }}
        />
        <select
          className="input"
          value={input.status}
          onChange={(event) =>
            setInput((prev) => ({
              ...prev,
              status: event.target.value as '' | 'in_stock' | 'shipped',
            }))
          }
        >
          <option value="">全部状态</option>
          <option value="in_stock">只看在库</option>
          <option value="shipped">只看已出库</option>
        </select>
        <button className="btn" onClick={handleSearch}>
          查询
        </button>
        <button className="btn" onClick={handleReset}>
          重置
        </button>
        {/*
          全选本页：手机端表头是隐藏的（表格在手机上变成卡片，thead 不显示），
          够不到表头那个复选框，所以这里给一个看得见的按钮。
          桌面端和表头复选框并存 —— 两边读写的是同一个状态，不会打架。
        */}
        <button
          className="btn"
          disabled={pageIds.length === 0}
          title={
            allPicked ? `清空本页 ${pageIds.length} 包的勾选` : `勾选本页全部 ${pageIds.length} 包`
          }
          onClick={() => {
            tapLight()
            setLabelPicked(allPicked ? [] : pageIds)
          }}
        >
          {allPicked ? '取消全选' : '全选本页'}
        </button>
        <button
          className="btn"
          disabled={labelPicked.length === 0}
          title={labelPicked.length === 0 ? '先勾选要打印的包' : '打印这些小标签'}
          onClick={() => navigate(`/label/print?ids=${labelPicked.join(',')}`)}
        >
          批量打印（{labelPicked.length}）
        </button>
        <span className="spacer" />
        <span className="muted">
          {/*
            去重：原来「在库 1.5246 m³ · 本页合计 1.5246 m³」两个数一样、白占地方。
            现在只留筛选范围内的两个数：包数（在库几个）+ 在库立方合计。
          */}
          共 {total} 包（在库 {totalInStock}） · 合计 {formatCubic(cubicInStock)} m³
        </span>
      </div>

      <div className="card">
        <div className="l3-head">
          <h2 className="section-title">包明细</h2>
          <span className="l3-sub">共 {total} 包</span>
          {refreshing && <span className="list-refreshing">刷新中…</span>}
        </div>
        {/* bales-table：只在桌面端冻结「勾选 + 包号 + 条码号」三列（横滑时钉在左边） */}
        <table className="table bales-table">
          <thead>
            <tr>
              <th className="col-check">
                <input
                  ref={pickAllRef}
                  type="checkbox"
                  /* 全选 = 勾上**当前页可见**的全部包（一页 50 条） */
                  checked={allPicked}
                  aria-label="全选本页"
                  title={
                    allPicked
                      ? `取消全选（本页 ${pageIds.length} 包）`
                      : `全选本页 ${pageIds.length} 包`
                  }
                  onChange={(event) =>
                    setLabelPicked(event.target.checked ? pageIds : [])
                  }
                />
              </th>
              <th>包号</th>
              <th>条码号</th>
              <th>柜号</th>
              <th>提单码</th>
              <th>合同号</th>
              <th>品牌</th>
              <th>品名</th>
              <th>等级</th>
              <th className="num">厚度 (mm)</th>
              <th className="num">宽度 (mm)</th>
              <th className="num">长度 (m)</th>
              <th className="num">片数 (片)</th>
              <th className="num">立方 (m³)</th>
              <th>状态</th>
              <th>出库单</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                className={labelPicked.includes(row.id) ? 'is-picked' : undefined}
                onClick={(event) => {
                  const target = event.target as HTMLElement
                  if (target.closest('button,a,input,select,label')) return
                  setLabelPicked((prev) =>
                    prev.includes(row.id)
                      ? prev.filter((id) => id !== row.id)
                      : [...prev, row.id],
                  )
                }}
              >
                <td className="col-check">
                  <input
                    type="checkbox"
                    checked={labelPicked.includes(row.id)}
                    onChange={(event) =>
                      setLabelPicked((prev) =>
                        event.target.checked
                          ? [...prev, row.id]
                          : prev.filter((id) => id !== row.id),
                      )
                    }
                  />
                </td>
                {/*
                  包号列宽被冻结区写死了 64px：长包号（W-MIX-TEST-LONG）只能省略号截断，
                  所以挂个 title，鼠标悬停能看到完整包号。
                */}
                <td title={row.bale_no || undefined}>{row.bale_no || '—'}</td>
                <td>{row.barcode || '—'}</td>
                <td>{row.box_no || '—'}</td>
                <td>{row.bl_no || '—'}</td>
                <td>{row.contract_no || '—'}</td>
                <td>{row.brand || '—'}</td>
                <td>{row.species}</td>
                <td>{row.grade || '—'}</td>
                {/* 厚度 / 宽度永远单值；长度和片数是混装包才用斜杠串（1.8/2.1/2.4、17/30/247） */}
                <td className="num">{row.thickness}</td>
                <td className="num">{row.width}</td>
                <td className="num">{row.length_text ?? row.length}</td>
                <td className="num">{row.pieces_text ?? row.pieces}</td>
                {/*
                  跨单合并包只挂在主单下：整包 8 方、其中主单 3 方。
                  主单那份小于整包时显示「3 / 8」（本单 / 总），鼠标悬停说清差额；
                  普通包（两个数相等）还是一个数字 —— 口径和入库单详情完全一致。
                */}
                <td className="num">
                  {row.own_cubic < row.cubic ? (
                    <span
                      title={
                        `这一包 ${formatCubic(row.cubic)} 方，` +
                        `其中 ${formatCubic(row.own_cubic)} 方来自本单，` +
                        `${formatCubic(roundTo(row.cubic - row.own_cubic, 4))} 方来自其他入库单`
                      }
                    >
                      {formatCubic(row.own_cubic)} / {formatCubic(row.cubic)}
                    </span>
                  ) : (
                    formatCubic(row.cubic)
                  )}
                </td>
                <td>
                  <span className={row.status === 'in_stock' ? 'tag tag-in' : 'tag tag-out'}>
                    {STATUS_TEXT[row.status]}
                  </span>
                </td>
                <td>{row.outbound_order_no || '—'}</td>
                <td>
                  <div className="row-actions">
                    <button
                      className="btn btn-sm"
                      onClick={() => navigate(`/label/print?ids=${row.id}`)}
                    >
                      打印标签
                    </button>
                    {canWrite && (
                      <>
                        {/*
                          桌面（≥768px）：操作列去 1366 屏下会跑到屏幕外，收成「⋯」省宽度。
                          手机（<768px）：这一列在卡片底部，横着摆三个文字按钮正好，
                          手机端维持原样不动 —— 两个按钮由 CSS 媒体查询互斥显示。
                        */}
                        <button
                          type="button"
                          className="btn btn-sm row-more"
                          title="更多操作（编辑 / 删除）"
                          aria-haspopup="menu"
                          aria-expanded={menuPos?.id === row.id}
                          onClick={(event) => {
                            if (menuPos?.id === row.id) {
                              setMenuPos(null)
                              return
                            }
                            const rect = event.currentTarget.getBoundingClientRect()
                            // 菜单用 fixed 定位：卡片是横向滚动容器，绝对定位会被裁掉
                            setMenuPos({ id: row.id, x: rect.right, y: rect.bottom + 6 })
                          }}
                        >
                          ⋯
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm row-edit-btn"
                          onClick={() => void openBaleEdit(row)}
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-danger row-edit-btn"
                          onClick={() => setBaleDeleteTarget(row)}
                        >
                          删除
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {!loading && rows.length === 0 && (
          <EmptyState
            text="没有符合条件的包"
            hint="这里是货的明细：一包一行。包是录入库单时生成的"
            action={{ label: '去录入库单', to: '/inbound/new' }}
          />
        )}
        {loading && <TableSkeleton rows={6} cols={6} />}

        <Pager
          total={total}
          limit={PAGE_SIZE}
          offset={offset}
          onChange={setOffset}
          unit="个包"
        />
      </div>

      {/* 行内「⋯」菜单：fixed 定位，避开卡片的横向滚动裁切 */}
      {menuPos &&
        (() => {
          const row = rows.find((one) => one.id === menuPos.id)
          if (!row) return null
          return (
            <div
              className="row-menu"
              ref={menuRef}
              role="menu"
              style={{ top: menuPos.y, left: Math.max(8, menuPos.x - 140) }}
            >
              <button
                type="button"
                className="account-menu-item"
                role="menuitem"
                onClick={() => {
                  setMenuPos(null)
                  void openBaleEdit(row)
                }}
              >
                编辑
              </button>
              <button
                type="button"
                className="account-menu-item row-menu-danger"
                role="menuitem"
                onClick={() => {
                  setMenuPos(null)
                  setBaleDeleteTarget(row)
                }}
              >
                删除
              </button>
            </div>
          )
        })()}

      {editOpen && (
        <div className="overlay" onClick={() => setEditOpen(false)}>
          <div className="modal modal-wide" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h2 className="modal-title">编辑这一包</h2>
              <button className="btn btn-sm btn-quiet" onClick={() => setEditOpen(false)}>
                关闭
              </button>
            </div>

            <div className="field-row">
              <label className="field field-required">
                <span className="field-label">
                  <span>包号</span>
                  <small>照货上写的填</small>
                </span>
                <input
                  className="input"
                  value={editNo}
                  onChange={(event) => setEditNo(event.target.value)}
                />
              </label>
              <label className="field">
                <span>柜号</span>
                <input
                  className="input"
                  value={editBoxNo}
                  onChange={(event) => setEditBoxNo(event.target.value)}
                />
              </label>
              <label className="field">
                <span>条码号（系统生成）</span>
                <input className="input" value={editBarcode} readOnly />
              </label>
            </div>

            <p className="hint" style={{ marginTop: 14 }}>
              这包里的规格（可以多个）；改完入库明细会同步调整，库存跟着变。
            </p>

            <table className="table table-detail">
              <thead>
                <tr>
                  <th>品牌</th>
                  <th>品名</th>
                  <th>等级</th>
                  <th className="num">厚度 (mm)</th>
                  <th className="num">宽度 (mm)</th>
                  <th className="num">长度 (m)</th>
                  <th className="num">片数 (片)</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {editLines.map((line, index) => (
                  <tr key={index}>
                    {/*
                      品牌只读展示：这一包的品牌在建单时定的，改包 / 改码单都不动它。
                      （后端 updateBale 没带 brand 时会原样保留，所以这里也不放输入框。
                      混装包里多行品牌不一样时，这里会看到每行各自的品牌。）
                    */}
                    <td className="bale-brand-cell">{line.brand || '—'}</td>
                    {(['species', 'grade', 'thickness', 'width', 'length', 'pieces'] as const).map(
                      (field) => (
                        <td key={field}>
                          <input
                            className="input input-cell"
                            inputMode={
                              field === 'species' || field === 'grade' ? undefined : 'decimal'
                            }
                            list={
                              field === 'species'
                                ? 'dict-species'
                                : field === 'grade'
                                  ? 'dict-grade'
                                  : undefined
                            }
                            value={String(line[field] === 0 ? '' : line[field])}
                            onChange={(event) =>
                              setEditLines((prev) =>
                                prev.map((item, i) =>
                                  i === index
                                    ? {
                                        ...item,
                                        [field]:
                                          field === 'species' || field === 'grade'
                                            ? event.target.value
                                            : Number(event.target.value),
                                      }
                                    : item,
                                ),
                              )
                            }
                          />
                        </td>
                      ),
                    )}
                    <td>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() =>
                          setEditLines((prev) =>
                            prev.length > 1 ? prev.filter((_, i) => i !== index) : prev,
                          )
                        }
                        disabled={editLines.length === 1}
                      >
                        删一行
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="row-tools">
              <button className="btn" onClick={() => setEditLines((prev) => [...prev, emptyLine()])}>
                + 加一个规格
              </button>
            </div>

            {editError && <p className="login-error">{editError}</p>}

            <div className="confirm-actions">
              <button className="btn" onClick={() => setEditOpen(false)} disabled={editSaving}>
                取消
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void submitBaleEdit()}
                disabled={editSaving}
              >
                {editSaving ? '提交中…' : '确认'}
              </button>
            </div>
          </div>
        </div>
      )}

      {baleDeleteTarget && (
        <div className="overlay" onClick={() => setBaleDeleteTarget(null)}>
          <div
            className="modal modal-narrow modal-alert"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="modal-title">删除这一包</h2>
            <p className="confirm-text">
              确认删除 {baleDeleteTarget.barcode || baleDeleteTarget.bale_no}？这一包的库存会一起减掉，
              此操作不可恢复。
            </p>
            <div className="confirm-actions">
              <button className="btn" onClick={() => setBaleDeleteTarget(null)}>
                取消
              </button>
              <button
                className="btn btn-danger-solid"
                onClick={() => {
                  tapHeavy()
                  void confirmBaleDelete()
                }}
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
