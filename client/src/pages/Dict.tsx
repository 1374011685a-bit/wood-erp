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
import {
  EmptyState,
  PageHead,
  TableSkeleton,
  ToastHost,
} from '../components/Ui'

type Column = {
  kind: DictKind
  title: string
  hint: string
  placeholder: string
}

const COLUMNS: Column[] = [
  {
    kind: 'species',
    title: '常用品名（木材名称）',
    hint: '入库 / 码单里录品名时，直接从这里选，也可以照旧手打',
    placeholder: '例如：樟子松',
  },
  {
    kind: 'grade',
    title: '常用等级',
    hint: '等级是规格的一部分，写法和入库时保持一致才会算同一个规格',
    placeholder: '例如：SLDK',
  },
]

export default function Dict() {
  const [data, setData] = useState<DictAll>({ species: [], grade: [] })
  const [drafts, setDrafts] = useState<Record<DictKind, string>>({
    species: '',
    grade: '',
  })
  const [editingId, setEditingId] = useState(0)
  const [editingName, setEditingName] = useState('')
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await fetchDict())
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const handleAdd = async (column: Column) => {
    const name = drafts[column.kind].trim()
    setError('')
    if (!name) {
      setError(`请先填写要添加的${column.kind === 'species' ? '品名' : '等级'}`)
      return
    }
    if (data[column.kind].some((item) => item.name === name)) {
      setError(`${name} 已经在列表里了`)
      return
    }

    try {
      await addDictItem(column.kind, name)
      setDrafts((prev) => ({ ...prev, [column.kind]: '' }))
      setNotice(`已添加：${name}`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加失败')
    }
  }

  const handleDelete = async (item: DictItem) => {
    setError('')
    try {
      await deleteDictItem(item.id)
      setNotice(`已删除：${item.name}`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
    }
  }

  const startEdit = (item: DictItem) => {
    setEditingId(item.id)
    setEditingName(item.name)
  }

  const submitEdit = async () => {
    const name = editingName.trim()
    if (!name) {
      setError('名称不能为空')
      return
    }
    try {
      await renameDictItem(editingId, name)
      setEditingId(0)
      setEditingName('')
      setNotice(`已改成：${name}`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '改名失败')
    }
  }

  return (
    <section>
      <PageHead
        title="常用项"
        subtitle="预先记好常用的品名和等级，录单时直接选，少打字、少写错"
      />

      <ToastHost
        items={[
          notice
            ? {
                id: 'dict-notice',
                kind: 'success' as const,
                message: notice,
                onClose: () => setNotice(''),
              }
            : null,
          error
            ? {
                id: 'dict-error',
                kind: 'error' as const,
                message: error,
                onClose: () => setError(''),
              }
            : null,
        ]}
      />

      <div className="dict-grid">
        {COLUMNS.map((column) => (
          <div className="card" key={column.kind}>
            <h2 className="section-title">{column.title}</h2>
            <p className="hint">{column.hint}</p>

            <div className="dict-add">
              <input
                className="input"
                placeholder={column.placeholder}
                value={drafts[column.kind]}
                onChange={(event) =>
                  setDrafts((prev) => ({ ...prev, [column.kind]: event.target.value }))
                }
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void handleAdd(column)
                }}
              />
              <button className="btn" onClick={() => void handleAdd(column)}>
                添加
              </button>
            </div>

            {loading ? (
              <TableSkeleton rows={4} cols={3} />
            ) : data[column.kind].length === 0 ? (
              <EmptyState text="还没有常用项，在上面输入后点「添加」" />
            ) : (
              <ul className="dict-list">
                {data[column.kind].map((item) => (
                  <li key={item.id} className="dict-item">
                    {editingId === item.id ? (
                      <>
                        <input
                          className="input input-cell"
                          autoFocus
                          value={editingName}
                          onChange={(event) => setEditingName(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') void submitEdit()
                            if (event.key === 'Escape') setEditingId(0)
                          }}
                        />
                        <div className="row-actions">
                          <button className="btn btn-sm btn-primary" onClick={() => void submitEdit()}>
                            保存
                          </button>
                          <button className="btn btn-sm" onClick={() => setEditingId(0)}>
                            取消
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <span className="dict-name">{item.name}</span>
                        <div className="row-actions">
                          <button className="btn btn-sm" onClick={() => startEdit(item)}>
                            改名
                          </button>
                          <button
                            className="btn btn-sm btn-danger"
                            onClick={() => void handleDelete(item)}
                          >
                            删除
                          </button>
                        </div>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>

      <p className="hint" style={{ marginTop: 16 }}>
        删除常用项不会影响已经录好的单据，只是以后下拉里不再提示这一项。
      </p>
    </section>
  )
}
