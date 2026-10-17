import { useCallback, useEffect, useState } from 'react'
import {
  addDictItem,
  deleteDictItem,
  fetchDict,
  renameDictItem,
  type DictAll,
  type DictItem,
  type DictKind,
} from '../api'
import { useRole } from '../hooks/useRole'
import { can } from '../permissions'
import { tapHeavy, tapLight } from '../utils/haptics'
import {
  MobileCard,
  MobileEmpty,
  MobileModal,
  MobileSheet,
  MobileSkeleton,
  MobileToastHost,
  useAutoDismiss,
  type MobileToastItem,
} from './components'

const KINDS: Array<{ kind: DictKind; title: string; hint: string }> = [
  { kind: 'species', title: '常用品名', hint: '录入库单、改包时直接选择木材名称' },
  { kind: 'grade', title: '常用等级', hint: '等级写法和录单保持一致，库存才不会拆成两行' },
]

export default function DictMobile() {
  const canWrite = can(useRole(), 'dict.write')
  const [data, setData] = useState<DictAll>({ species: [], grade: [] })
  const [drafts, setDrafts] = useState<Record<DictKind, string>>({ species: '', grade: '' })
  const [loading, setLoading] = useState(true)
  const [renameTarget, setRenameTarget] = useState<DictItem | null>(null)
  const [renameName, setRenameName] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<DictItem | null>(null)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<MobileToastItem | null>(null)
  useAutoDismiss(toast, () => setToast(null))

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await fetchDict())
    } catch (err) {
      setToast({
        id: `l-${Date.now()}`,
        message: err instanceof Error ? err.message : '加载常用项失败',
      })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const add = async (kind: DictKind) => {
    const name = drafts[kind].trim()
    if (!name) {
      setToast({ id: `v-${Date.now()}`, message: '请先输入名称' })
      return
    }
    if (data[kind].some((item) => item.name === name)) {
      setToast({ id: `v-${Date.now()}`, message: `${name} 已经在列表里了` })
      return
    }
    setSaving(true)
    try {
      await addDictItem(kind, name)
      setDrafts((prev) => ({ ...prev, [kind]: '' }))
      await load()
      setToast({ id: `a-${Date.now()}`, message: `已添加：${name}` })
    } catch (err) {
      setToast({
        id: `a-${Date.now()}`,
        message: err instanceof Error ? err.message : '添加失败',
      })
    } finally {
      setSaving(false)
    }
  }

  const submitRename = async () => {
    if (!renameTarget) return
    const name = renameName.trim()
    if (!name) {
      setToast({ id: `v-${Date.now()}`, message: '名称不能为空' })
      return
    }
    setSaving(true)
    try {
      await renameDictItem(renameTarget.id, name)
      setRenameTarget(null)
      setRenameName('')
      await load()
      setToast({ id: `r-${Date.now()}`, message: `已改成：${name}` })
    } catch (err) {
      setToast({
        id: `r-${Date.now()}`,
        message: err instanceof Error ? err.message : '改名失败',
      })
    } finally {
      setSaving(false)
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    setSaving(true)
    try {
      await deleteDictItem(deleteTarget.id)
      setDeleteTarget(null)
      await load()
      setToast({ id: `d-${Date.now()}`, message: `已删除：${deleteTarget.name}` })
    } catch (err) {
      setToast({
        id: `d-${Date.now()}`,
        message: err instanceof Error ? err.message : '删除失败',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="m-stack">
      {loading ? (
        <MobileSkeleton cards={2} />
      ) : (
        KINDS.map((column) => (
          <MobileCard title={column.title} hint={`${data[column.kind].length} 项`} key={column.kind}>
            <p className="m-settings-note" style={{ marginTop: 0 }}>
              {column.hint}
            </p>
            {canWrite ? (
              <div className="m-dict-add">
                <input
                  className="m-input"
                  value={drafts[column.kind]}
                  onChange={(event) =>
                    setDrafts((prev) => ({ ...prev, [column.kind]: event.target.value }))
                  }
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void add(column.kind)
                  }}
                />
                <button
                  type="button"
                  className="m-btn m-btn-primary"
                  disabled={saving}
                  onClick={() => {
                    tapLight()
                    void add(column.kind)
                  }}
                >
                  添加
                </button>
              </div>
            ) : null}
            {data[column.kind].length === 0 ? (
              <MobileEmpty text={`还没有常用${column.kind === 'species' ? '品名' : '等级'}`} />
            ) : (
              <div className="m-dict-list">
                {data[column.kind].map((item) => (
                  <div className="m-dict-row" key={item.id}>
                    <b>{item.name}</b>
                    {canWrite ? (
                      <div>
                        <button
                          type="button"
                          onClick={() => {
                            setRenameTarget(item)
                            setRenameName(item.name)
                          }}
                        >
                          改名
                        </button>
                        <button
                          type="button"
                          className="is-danger"
                          onClick={() => {
                            tapHeavy()
                            setDeleteTarget(item)
                          }}
                        >
                          删除
                        </button>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </MobileCard>
        ))
      )}

      <MobileSheet open={Boolean(renameTarget)} title="改名" onClose={() => setRenameTarget(null)}>
        {renameTarget ? (
          <>
            <label className="m-field">
              <span className="m-field-label">新名称</span>
              <input
                className="m-input"
                value={renameName}
                onChange={(event) => setRenameName(event.target.value)}
              />
            </label>
            <div className="m-sheet-actions">
              <button
                type="button"
                className="m-btn m-btn-primary"
                disabled={saving}
                onClick={() => void submitRename()}
              >
                {saving ? '保存中…' : '保存'}
              </button>
              <button type="button" className="m-btn m-btn-ghost" onClick={() => setRenameTarget(null)}>
                取消
              </button>
            </div>
          </>
        ) : null}
      </MobileSheet>

      <MobileModal
        open={Boolean(deleteTarget)}
        title="删除常用项？"
        message={
          deleteTarget
            ? `确定删除 ${deleteTarget.name}？已录好的单据不受影响。`
            : undefined
        }
        confirmLabel={saving ? '删除中…' : '确认删除'}
        danger
        onConfirm={() => void confirmDelete()}
        onClose={() => {
          if (!saving) setDeleteTarget(null)
        }}
      />

      <MobileToastHost items={[toast]} />
    </div>
  )
}
