import { useCallback, useEffect, useMemo, useState } from 'react'

import { downloadEntries, listEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import {
  ROUTE_LABELS,
  advanceCheckpoint,
  chooseQuotaRoute,
  exportResumeResult,
  listReleasePendingItems,
  loadQuotaLedger,
  loadRecovery,
  loadResumeResult,
  plannedOfRow,
  reviewUnconfirmedQuota,
  unconfirmedOf,
} from '@/api/resume-service'
import type { LedgerView } from '@/api/resume-service'
import type { RecoveryState, ReleasePendingItem, ResumeResultData } from '@/data/resume-store'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('spider')
const columns = [
  "作业编号",
  "目标站点",
  "抽取模板",
  "起始地址",
  "并发线程数",
  "请求间隔秒",
  "每日上限条数",
  "超时秒数"
]
const actions = [
  "提交执行",
  "启动采集",
  "终止采集",
  "断点续跑",
  "归档结果"
]
const statuses = [
  "草稿",
  "待执行",
  "运行中",
  "已完成",
  "已失败"
]

const PREVIEW_COUNT = 6

function previewList(keys: string[]): string {
  if (keys.length <= PREVIEW_COUNT) {
    return keys.join('、') || '—'
  }
  return `${keys.slice(0, PREVIEW_COUNT).join('、')} …共 ${keys.length} 条`
}

export default function SpiderView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [notice, setNotice] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [recovery, setRecovery] = useState<RecoveryState | null>(null)
  const [resultData, setResultData] = useState<ResumeResultData | null>(null)
  const [pendingItems, setPendingItems] = useState<ReleasePendingItem[]>([])
  const [ledger, setLedger] = useState<LedgerView | null>(null)
  const filterFields = useMemo(() => columns.slice(0, 3), [])

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
      // 动作结果落到本地持久化后，待处理清单与当日额度台账同步刷新
      setPendingItems(listReleasePendingItems())
      setLedger(loadQuotaLedger())
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '任务编排列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload])

  // 选中作业或列表刷新后，重新读取恢复状态与断点续跑结果数据（核对后展示）
  useEffect(() => {
    if (selectedId === null) {
      setRecovery(null)
      setResultData(null)
      return
    }
    setRecovery(loadRecovery(selectedId))
    setResultData(loadResumeResult(selectedId))
  }, [selectedId, rows])

  const selectedRow = useMemo(
    () => rows.find((row) => Number(row.id) === selectedId) ?? null,
    [rows, selectedId],
  )

  const stats = [
    { label: '采集作业总数', value: total },
    { label: '运行中作业', value: rows.filter((row) => String(row.status) === '运行中').length },
    { label: '已完成作业', value: rows.filter((row) => String(row.status) === '已完成').length },
    { label: '已失败作业', value: rows.filter((row) => String(row.status) === '已失败').length },
  ]

  function runAction(action: string, row: EntryRow) {
    setErrorMessage('')
    setNotice('')
    const result = applyAction(meta.key, Number(row.id), action)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    setNotice(result.message)
    reload()
  }

  function openBreakpoints(row: EntryRow) {
    setErrorMessage('')
    setNotice('')
    setSelectedId(Number(row.id))
  }

  function handleAdvance(row: EntryRow) {
    setErrorMessage('')
    setNotice('')
    const result = advanceCheckpoint(Number(row.id))
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    setNotice(result.message)
    reload()
  }

  function handleReview() {
    if (selectedId === null) return
    setErrorMessage('')
    setNotice('')
    const result = reviewUnconfirmedQuota(selectedId)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    setNotice(result.message)
    reload()
  }

  function handleRoute(route: 'release' | 'carryover') {
    if (selectedId === null) return
    setErrorMessage('')
    setNotice('')
    const result = chooseQuotaRoute(selectedId, route)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    setNotice(result.message)
    reload()
  }

  function handleExportResult() {
    if (selectedId === null) return
    setErrorMessage('')
    const payload = exportResumeResult(selectedId)
    if (!payload) {
      setErrorMessage('还没有生成采集作业断点续跑结果数据，请先核对未确认额度')
      return
    }
    const blob = new Blob([payload.content], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = payload.filename
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
  }

  const unconfirmed = recovery ? unconfirmedOf(recovery) : 0
  const startableEstimate =
    ledger && selectedRow ? Math.floor(ledger.available / Math.max(1, plannedOfRow(selectedRow))) : null

  return (
    <section className="page" data-module="spider">
      <header className="page-head">
        <div>
          <h2>任务编排管理</h2>
          <p className="page-desc">维护采集作业的输入、执行约束与结果记录，为任务编排提供可验证的数据工程流程。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('采集作业登记入口尚未接入审批流')}>
            登记采集作业
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出任务编排清单
          </button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      <p className="status-legend">
        {statuses.map((status: string) => (
          <span key={status} className="legend-item">
            {status}：{rows.filter((row) => String(row.status) === status).length}
          </span>
        ))}
      </p>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)}>
              {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
              <td>{row.status}</td>
              <td className="row-actions">
                {actions.map((action) => (
                  <button key={action} className="link" type="button" onClick={() => runAction(action, row)}>
                    {action}
                  </button>
                ))}
                {String(row.status) === '运行中' && (
                  <button className="link" type="button" onClick={() => handleAdvance(row)}>
                    推进采集
                  </button>
                )}
                <button className="link" type="button" onClick={() => openBreakpoints(row)}>
                  查看断点
                </button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 2}>暂无任务编排数据，可先登记采集作业</td>
            </tr>
          )}
        </tbody>
      </table>

      {ledger && (
        <section className="panel">
          <h3 className="panel-title">当日额度台账（{ledger.day}）</h3>
          <div className="kv-grid">
            <span><span className="kv-label">当日额度总量</span>{ledger.capacity} 条</span>
            <span><span className="kv-label">预留占用</span>{ledger.reserved} 条</span>
            <span><span className="kv-label">已确认扣减</span>{ledger.deducted} 条</span>
            <span><span className="kv-label">累计释放回池</span>{ledger.released} 条</span>
            <span><span className="kv-label">结转占用</span>{ledger.carried} 条</span>
            <span><span className="kv-label">当日可用额度</span><strong>{ledger.available} 条</strong></span>
            {startableEstimate !== null && selectedRow && (
              <span>
                <span className="kv-label">当日可启动作业</span>
                按 {String(selectedRow['作业编号'])} 每日上限 {plannedOfRow(selectedRow)} 条估算，约 {startableEstimate} 个同类作业
              </span>
            )}
          </div>
          <p className="panel-hint">释放未被检查点确认的额度会回到可用额度；把预留结转到下一次续跑则继续占用，两种路线直接改变当日可启动作业数量。</p>
        </section>
      )}

      {selectedRow && (
        <section className="panel" data-panel="resume">
          <h3 className="panel-title">
            断点续跑 · {String(selectedRow['作业编号'])}
            <span className={`badge ${String(selectedRow.status) === '已失败' ? 'warn' : 'ok'}`}>{String(selectedRow.status)}</span>
          </h3>
          <div className="kv-grid">
            <span><span className="kv-label">任务编排</span>{meta.name}（{meta.key}）</span>
            <span><span className="kv-label">采集作业</span>{meta.entity}</span>
            <span><span className="kv-label">作业编号</span>{String(selectedRow['作业编号'])}</span>
            <span><span className="kv-label">起始地址</span><span className="mono">{String(selectedRow['起始地址'])}</span></span>
            {recovery && (
              <>
                <span><span className="kv-label">恢复状态版本</span>v{recovery.version}</span>
                <span><span className="kv-label">续跑次数</span>{recovery.resumeRuns} 次</span>
              </>
            )}
          </div>

          {!recovery && (
            <p className="empty-state">暂无恢复状态：该作业尚未启动采集，启动后将在此记录断点检查点与预留额度。</p>
          )}

          {recovery && (
            <>
              {recovery.interrupt && (
                <p className="interrupt-box">
                  中断位置：已提交 {recovery.interrupt.position} 条 ｜ 原因:{recovery.interrupt.reason} ｜ 重试说明:{recovery.interrupt.retryHint}（{recovery.interrupt.at}）
                </p>
              )}

              <h4 className="section-title">断点检查点（已提交结果 {recovery.submittedResults.length} 条）</h4>
              {recovery.checkpoints.length === 0 ? (
                <p className="empty-state">暂无结果：尚无已落地的检查点，失败记录不当作完成。</p>
              ) : (
                <table className="sub-table">
                  <thead>
                    <tr>
                      <th>检查点</th>
                      <th>本批提交</th>
                      <th>累计提交</th>
                      <th>确认额度</th>
                      <th>来源地址</th>
                      <th>提交时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recovery.checkpoints.map((checkpoint) => (
                      <tr key={checkpoint.seq}>
                        <td>#{checkpoint.seq}</td>
                        <td>{checkpoint.batchRecords} 条</td>
                        <td>{checkpoint.committedRecords} 条</td>
                        <td>{checkpoint.quotaConfirmed} 条</td>
                        <td className="mono">{checkpoint.sourceAddress}</td>
                        <td>{checkpoint.committedAt}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <h4 className="section-title">额度核对</h4>
              <div className="kv-grid">
                <span><span className="kv-label">计划采集</span>{recovery.plannedTotal} 条</span>
                <span><span className="kv-label">初始预留</span>{recovery.reservedQuota} 条</span>
                <span><span className="kv-label">续跑重新预留</span>{recovery.reReservedQuota} 条</span>
                <span><span className="kv-label">检查点已确认</span>{recovery.confirmedQuota} 条</span>
                <span><span className="kv-label">未确认待核对</span><strong>{unconfirmed} 条</strong></span>
                <span><span className="kv-label">已释放</span>{recovery.releasedQuota} 条</span>
                <span><span className="kv-label">已结转</span>{recovery.carriedQuota} 条</span>
                <span><span className="kv-label">复核依据（已核对未确认）</span>{recovery.reviewedUnconfirmed} 条</span>
              </div>
              <p className="panel-hint">
                落库路线：{recovery.quotaRoute ? ROUTE_LABELS[recovery.quotaRoute] : '待判定'}
                {recovery.routeReason ? ` ｜ ${recovery.routeReason}` : ''}
              </p>
              <div className="action-row">
                <button className="btn" type="button" onClick={handleReview}>核对未确认额度</button>
                <button className="btn" type="button" onClick={() => handleRoute('release')}>释放未确认额度</button>
                <button className="btn" type="button" onClick={() => handleRoute('carryover')}>结转到下次续跑</button>
              </div>

              <h4 className="section-title">采集作业断点续跑结果数据</h4>
              {!resultData ? (
                <p className="empty-state">暂无结果：请先「核对未确认额度」生成断点续跑结果数据。</p>
              ) : (
                <>
                  <div className="kv-grid">
                    <span><span className="kv-label">结果版本</span>v{resultData.version}</span>
                    <span><span className="kv-label">生成时间</span>{resultData.generatedAt}</span>
                    <span><span className="kv-label">检查点数</span>{resultData.checkpointCount}</span>
                    <span><span className="kv-label">续跑起点</span>检查点 #{resultData.resumeFromSeq}</span>
                    <span><span className="kv-label">已完成记录</span>{resultData.committedRecords} 条</span>
                    <span><span className="kv-label">未完成记录</span>{resultData.remainingRecords} 条</span>
                    <span><span className="kv-label">释放未确认额度</span>{resultData.releasedUnconfirmed} 条</span>
                    <span><span className="kv-label">结转下次续跑</span>{resultData.carriedForward} 条</span>
                    <span><span className="kv-label">落库路线</span>{resultData.quotaRoute === '待判定' ? '待判定' : ROUTE_LABELS[resultData.quotaRoute as 'release' | 'carryover']}</span>
                    <span><span className="kv-label">额度扣减标记</span>{resultData.deductionMarkers.length} 条已扣减</span>
                  </div>
                  <p className="panel-hint">路线取舍：{resultData.routeReason}</p>
                  <p className="panel-hint">跳过记录（已完成不重跑）：{previewList(resultData.skippedRecords)}</p>
                  <p className="panel-hint">待处理记录（续跑范围）：{previewList(resultData.pendingRecords)}</p>
                  <p className="panel-hint">{resultData.snapshotNote}</p>
                  <div className="action-row">
                    <button className="btn" type="button" onClick={handleExportResult}>导出复核记录</button>
                  </div>
                </>
              )}
            </>
          )}
        </section>
      )}

      <section className="panel">
        <h3 className="panel-title">释放未被检查点确认的额度待处理清单</h3>
        {pendingItems.length === 0 ? (
          <p className="empty-state">暂无待处理项：核对未确认额度后会在此登记。</p>
        ) : (
          <table className="sub-table">
            <thead>
              <tr>
                <th>登记时间</th>
                <th>作业编号</th>
                <th>未确认额度</th>
                <th>落库路线</th>
                <th>状态</th>
                <th>完成时间</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {pendingItems.map((item) => (
                <tr key={item.id}>
                  <td>{item.createdAt}</td>
                  <td>{item.jobKey}</td>
                  <td>{item.amount} 条</td>
                  <td>{item.route === '待判定' ? '待判定' : ROUTE_LABELS[item.route]}</td>
                  <td>{item.status}</td>
                  <td>{item.resolvedAt ?? '—'}</td>
                  <td>{item.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <footer className="page-foot">
        <span>共 {total} 条任务编排记录</span>
        {notice && <span className="notice-text">{notice}</span>}
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}
