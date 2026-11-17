import { listRows } from '@/data/local-store'
import {
  getLedger,
  getRecovery,
  getResult,
  listReleasePending,
  now,
  rangeKeys,
  saveLedger,
  saveRecovery,
  saveResult,
  upsertReleasePending,
} from '@/data/resume-store'
import type { QuotaLedger, RecoveryState, ReleasePendingItem, ResumeResultData } from '@/data/resume-store'
import type { EntryRow } from '@/data/types'

// 任务编排（spider）是本条任务编排题的主键，采集作业与作业编号共同描述业务对象。
const ORCHESTRATION = '任务编排'
const ENTITY = '采集作业'
const SPIDER_KEY = 'spider'
const BATCHES_PER_JOB = 4
const DEFAULT_PLANNED = 100

export const ROUTE_LABELS: Record<'release' | 'carryover', string> = {
  release: '释放未被检查点确认的额度',
  carryover: '把预留结转到下一次续跑',
}

export type EffectResult = { ok: boolean; note: string }
export type ServiceMessage = { ok: boolean; message: string }
export type LedgerView = QuotaLedger & { available: number }

function findSpiderRow(jobId: number): EntryRow | null {
  return listRows(SPIDER_KEY).find((row) => Number(row.id) === jobId) ?? null
}

function jobKeyOf(row: EntryRow): string {
  return String(row['作业编号'] ?? '')
}

function plannedOf(row: EntryRow): number {
  const raw = Number.parseInt(String(row['每日上限条数'] ?? ''), 10)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PLANNED
}

export function plannedOfRow(row: EntryRow): number {
  return plannedOf(row)
}

/** 未被检查点确认、仍占用的预留额度（待核对部分） */
export function unconfirmedOf(recovery: RecoveryState): number {
  return (
    recovery.reservedQuota +
    recovery.reReservedQuota -
    recovery.confirmedQuota -
    recovery.releasedQuota -
    recovery.carriedQuota
  )
}

function availableOf(ledger: QuotaLedger): number {
  return ledger.capacity - ledger.reserved - ledger.deducted
}

function batchSizeOf(planned: number): number {
  return Math.max(1, Math.ceil(planned / BATCHES_PER_JOB))
}

function buildFreshRecovery(row: EntryRow, reserved: number): RecoveryState {
  return {
    jobId: Number(row.id),
    jobKey: jobKeyOf(row),
    orchestration: ORCHESTRATION,
    entity: ENTITY,
    startAddress: String(row['起始地址'] ?? ''),
    plannedTotal: plannedOf(row),
    reservedQuota: reserved,
    reReservedQuota: 0,
    confirmedQuota: 0,
    releasedQuota: 0,
    carriedQuota: 0,
    reviewedUnconfirmed: 0,
    quotaRoute: null,
    routeReason: '',
    checkpoints: [],
    submittedResults: [],
    deductedRecordKeys: [],
    interrupt: null,
    resumeRuns: 0,
    version: 1,
    note: '',
    updatedAt: now(),
  }
}

/** 按当前恢复状态生成采集作业断点续跑结果数据：以释放未被检查点确认的额度为复核依据 */
function buildResultData(recovery: RecoveryState): ResumeResultData {
  const remaining = recovery.plannedTotal - recovery.confirmedQuota
  return {
    jobId: recovery.jobId,
    jobKey: recovery.jobKey,
    orchestration: recovery.orchestration,
    entity: recovery.entity,
    startAddress: recovery.startAddress,
    generatedAt: now(),
    version: recovery.version,
    checkpointCount: recovery.checkpoints.length,
    committedRecords: recovery.confirmedQuota,
    remainingRecords: remaining,
    resumeFromSeq: recovery.checkpoints.length,
    releaseBasis: recovery.reviewedUnconfirmed,
    releasedUnconfirmed: recovery.releasedQuota,
    carriedForward: recovery.carriedQuota,
    quotaRoute: recovery.quotaRoute ?? '待判定',
    routeReason:
      recovery.routeReason ||
      '尚未选择落库路线：可释放未确认额度回当日额度池，或把预留结转到下一次续跑',
    deductionMarkers: recovery.deductedRecordKeys.map((recordKey) => ({ recordKey, deducted: true })),
    skippedRecords: [...recovery.deductedRecordKeys],
    pendingRecords: rangeKeys(recovery.jobKey, recovery.confirmedQuota + 1, recovery.plannedTotal),
    snapshotNote: `复核依据：释放未被检查点确认的额度 ${recovery.reviewedUnconfirmed} 条；续跑只处理未完成记录 ${remaining} 条，已完成 ${recovery.confirmedQuota} 条不重复扣减额度`,
  }
}

/** 已生成过结果数据时，随恢复状态变化同步刷新（版本递增，不跳回先前版本） */
function refreshResultData(recovery: RecoveryState): void {
  if (getResult(recovery.jobKey)) {
    saveResult(buildResultData(recovery))
  }
}

// ---------- 查询 ----------

export function loadRecovery(jobId: number): RecoveryState | null {
  const row = findSpiderRow(jobId)
  return row ? getRecovery(jobKeyOf(row)) : null
}

export function loadResumeResult(jobId: number): ResumeResultData | null {
  const row = findSpiderRow(jobId)
  return row ? getResult(jobKeyOf(row)) : null
}

export function listReleasePendingItems(): ReleasePendingItem[] {
  return listReleasePending().slice().reverse()
}

export function loadQuotaLedger(): LedgerView {
  const ledger = getLedger()
  return { ...ledger, available: availableOf(ledger) }
}

// ---------- 状态流转挂钩（由 local-service 在任务编排动作时调用） ----------

export function spiderActionEffect(action: string, row: EntryRow): EffectResult {
  switch (action) {
    case '启动采集':
      return effectStart(row)
    case '终止采集':
      return effectInterrupt(row)
    case '断点续跑':
      return effectResume(row)
    case '归档结果':
      return effectArchive(row)
    default:
      return { ok: true, note: '' }
  }
}

function effectStart(row: EntryRow): EffectResult {
  const existing = getRecovery(jobKeyOf(row))
  if (
    existing &&
    (existing.confirmedQuota > 0 || unconfirmedOf(existing) > 0 || existing.carriedQuota > 0)
  ) {
    return {
      ok: false,
      note: `采集作业已存在恢复状态（已提交 ${existing.confirmedQuota} 条、未确认预留 ${unconfirmedOf(existing)} 条），请走「核对未确认额度 → 断点续跑」，避免从头重跑已完成记录或重复预留额度`,
    }
  }
  const planned = plannedOf(row)
  const ledger = getLedger()
  const available = availableOf(ledger)
  if (available < planned) {
    return {
      ok: false,
      note: `当日可用额度 ${available} 条，不足预留 ${planned} 条；可先释放失败作业未被检查点确认的额度`,
    }
  }
  const recovery = buildFreshRecovery(row, planned)
  recovery.note = `启动采集：预留当日额度 ${planned} 条`
  saveRecovery(recovery)
  ledger.reserved += planned
  saveLedger(ledger)
  return { ok: true, note: `已预留当日额度 ${planned} 条` }
}

function effectInterrupt(row: EntryRow): EffectResult {
  const jobKey = jobKeyOf(row)
  const ledger = getLedger()
  let recovery = getRecovery(jobKey)
  if (!recovery) {
    // 运行中的作业没有恢复状态（历史数据）：按“额度已预留但检查点尚未落地”补建
    const running = String(row.status) === '运行中'
    recovery = buildFreshRecovery(row, running ? plannedOf(row) : 0)
    if (running) {
      ledger.reserved += recovery.reservedQuota
    }
    recovery.note = running
      ? '补建恢复状态：额度已预留但尚无检查点落地'
      : '未进入运行即终止，无预留额度'
  }
  const unconfirmed = unconfirmedOf(recovery)
  recovery.interrupt = {
    position: recovery.confirmedQuota,
    reason: `采集中断：已提交 ${recovery.confirmedQuota} 条，${unconfirmed} 条额度已预留但检查点尚未落地`,
    retryHint: `核对未确认额度后可从检查点 #${recovery.checkpoints.length} 断点续跑，已提交记录不会重跑、不重复扣减额度`,
    at: now(),
  }
  recovery.version += 1
  recovery.note = '中断位置已保留，等待核对未确认额度'
  saveRecovery(recovery)
  saveLedger(ledger)
  refreshResultData(recovery)
  return {
    ok: true,
    note: `中断位置已保留（已提交 ${recovery.confirmedQuota} 条），未确认预留 ${unconfirmed} 条待核对`,
  }
}

function effectResume(row: EntryRow): EffectResult {
  if (String(row.status) !== '已失败') {
    return { ok: false, note: '仅「已失败」的采集作业可断点续跑' }
  }
  const recovery = getRecovery(jobKeyOf(row))
  if (!recovery) {
    return { ok: false, note: '没有找到恢复状态，无法断点续跑' }
  }
  const remaining = recovery.plannedTotal - recovery.confirmedQuota
  if (remaining <= 0) {
    return { ok: false, note: '计划记录已全部提交，无需续跑；请直接「归档结果」，异常不当作完成' }
  }
  const unconfirmed = unconfirmedOf(recovery)
  if (unconfirmed > 0 && !recovery.quotaRoute) {
    return {
      ok: false,
      note: `尚有 ${unconfirmed} 条未被检查点确认的预留额度未核对，请先「核对未确认额度」并选择释放或结转路线`,
    }
  }
  const ledger = getLedger()
  let quotaNote = '沿用已预留额度继续采集'
  if (recovery.carriedQuota > 0) {
    const use = Math.min(recovery.carriedQuota, remaining)
    recovery.carriedQuota -= use
    ledger.carried = Math.max(0, ledger.carried - use)
    quotaNote = `使用结转的预留额度 ${use} 条，无需重复预留、不重复扣减`
  } else if (unconfirmed === 0) {
    // 未确认额度已释放（或无历史预留）：续跑前按剩余记录重新预留
    const available = availableOf(ledger)
    if (available < remaining) {
      return { ok: false, note: `当日可用额度 ${available} 条，不足续跑预留 ${remaining} 条` }
    }
    ledger.reserved += remaining
    recovery.reReservedQuota += remaining
    quotaNote = `未确认额度已释放（或无历史预留），续跑前重新预留当日额度 ${remaining} 条`
  }
  recovery.interrupt = null
  recovery.resumeRuns += 1
  recovery.version += 1
  recovery.note = `第 ${recovery.resumeRuns} 次断点续跑启动`
  saveRecovery(recovery)
  saveLedger(ledger)
  const result = saveResult(buildResultData(recovery))
  return {
    ok: true,
    note: `从检查点 #${recovery.checkpoints.length} 续跑：跳过已提交 ${recovery.confirmedQuota} 条（不重复扣减额度），待处理 ${remaining} 条；${quotaNote}；结果数据 v${result.version} 已生成`,
  }
}

function effectArchive(row: EntryRow): EffectResult {
  const recovery = getRecovery(jobKeyOf(row))
  if (!recovery) {
    return { ok: true, note: '' }
  }
  const unconfirmed = unconfirmedOf(recovery)
  if (unconfirmed > 0) {
    const ledger = getLedger()
    ledger.reserved = Math.max(0, ledger.reserved - unconfirmed)
    ledger.released += unconfirmed
    saveLedger(ledger)
    recovery.releasedQuota += unconfirmed
    recovery.note = `归档完成：未确认预留 ${unconfirmed} 条已释放回当日额度池`
  } else {
    recovery.note = '归档完成：额度已全部经检查点确认扣减'
  }
  recovery.interrupt = null
  recovery.version += 1
  saveRecovery(recovery)
  refreshResultData(recovery)
  return {
    ok: true,
    note: unconfirmed > 0 ? `未确认预留 ${unconfirmed} 条已释放回当日额度池` : '额度已全部确认扣减，无重复扣减',
  }
}

// ---------- 运行中推进检查点（模拟采集批次落地） ----------

export function advanceCheckpoint(jobId: number): ServiceMessage {
  const row = findSpiderRow(jobId)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${jobId} 的采集作业` }
  }
  if (String(row.status) !== '运行中') {
    return { ok: false, message: '仅「运行中」的采集作业可推进检查点' }
  }
  const jobKey = jobKeyOf(row)
  const ledger = getLedger()
  let recovery = getRecovery(jobKey)
  if (!recovery) {
    // 自愈：运行中但没有恢复状态，补建并预留当日额度
    const planned = plannedOf(row)
    const available = availableOf(ledger)
    if (available < planned) {
      return { ok: false, message: `当日可用额度 ${available} 条，不足预留 ${planned} 条` }
    }
    recovery = buildFreshRecovery(row, planned)
    recovery.note = '补建恢复状态：运行中补预留当日额度'
    ledger.reserved += planned
  }
  const remaining = recovery.plannedTotal - recovery.confirmedQuota
  if (remaining <= 0) {
    return { ok: false, message: '计划记录已全部提交，可执行「归档结果」' }
  }
  const batch = Math.min(batchSizeOf(recovery.plannedTotal), remaining)
  const seq = recovery.checkpoints.length + 1
  const keys = rangeKeys(jobKey, recovery.confirmedQuota + 1, recovery.confirmedQuota + batch)
  recovery.checkpoints = [
    ...recovery.checkpoints,
    {
      seq,
      batchRecords: batch,
      committedRecords: recovery.confirmedQuota + batch,
      quotaConfirmed: batch,
      sourceAddress: recovery.startAddress,
      committedAt: now(),
      results: keys,
    },
  ]
  recovery.submittedResults = [...recovery.submittedResults, ...keys]
  recovery.deductedRecordKeys = [...recovery.deductedRecordKeys, ...keys]
  recovery.confirmedQuota += batch
  recovery.version += 1
  recovery.note = `检查点 #${seq} 落地，额度确认扣减 ${batch} 条`
  ledger.reserved = Math.max(0, ledger.reserved - batch)
  ledger.deducted += batch
  saveRecovery(recovery)
  saveLedger(ledger)
  refreshResultData(recovery)
  return {
    ok: true,
    message: `检查点 #${seq} 已落地：本批提交 ${batch} 条，累计 ${recovery.confirmedQuota}/${recovery.plannedTotal} 条，额度确认扣减 ${batch} 条`,
  }
}

// ---------- 核对未确认额度：登记待处理清单并生成断点续跑结果数据 ----------

export function reviewUnconfirmedQuota(jobId: number): ServiceMessage {
  const row = findSpiderRow(jobId)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${jobId} 的采集作业` }
  }
  const recovery = getRecovery(jobKeyOf(row))
  if (!recovery) {
    return { ok: false, message: '该采集作业还没有恢复状态，无需核对' }
  }
  const unconfirmed = unconfirmedOf(recovery)
  if (unconfirmed <= 0) {
    return { ok: false, message: '没有未被检查点确认的预留额度，无需核对' }
  }
  recovery.reviewedUnconfirmed = unconfirmed
  recovery.version += 1
  recovery.note = `核对完成：未确认预留 ${unconfirmed} 条，等待选择释放或结转路线`
  saveRecovery(recovery)
  // 动作结果落到本地持久化的待处理清单：有未结项则同步刷新金额，否则新建
  const open = listReleasePending().find(
    (item) => item.jobKey === recovery.jobKey && item.status === '待处理',
  )
  if (open) {
    upsertReleasePending({
      ...open,
      amount: unconfirmed,
      note: `核对刷新：未确认预留 ${unconfirmed} 条，等待选择落库路线`,
    })
  } else {
    upsertReleasePending({
      id: `${recovery.jobKey}-${Date.now()}`,
      jobId: recovery.jobId,
      jobKey: recovery.jobKey,
      amount: unconfirmed,
      route: '待判定',
      status: '待处理',
      createdAt: now(),
      resolvedAt: null,
      note: `核对登记：未确认预留 ${unconfirmed} 条，等待选择释放或结转路线`,
    })
  }
  const result = saveResult(buildResultData(recovery))
  return {
    ok: true,
    message: `核对完成：未被检查点确认的预留额度 ${unconfirmed} 条已登记到待处理清单，断点续跑结果数据 v${result.version} 已生成；请选择「释放」或「结转」落库路线`,
  }
}

// ---------- 释放 / 结转落库路线判定（含冲突改判） ----------

export function chooseQuotaRoute(jobId: number, route: 'release' | 'carryover'): ServiceMessage {
  const row = findSpiderRow(jobId)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${jobId} 的采集作业` }
  }
  const recovery = getRecovery(jobKeyOf(row))
  if (!recovery) {
    return { ok: false, message: '该采集作业还没有恢复状态，请先核对未确认额度' }
  }
  const ledger = getLedger()
  const label = ROUTE_LABELS[route]
  const open = listReleasePending().find(
    (item) => item.jobKey === recovery.jobKey && item.status === '待处理',
  )

  if (open) {
    // 正常落库：按核对登记的未确认额度走释放或结转路线
    const amount = open.amount
    if (route === 'release') {
      recovery.releasedQuota += amount
      ledger.reserved = Math.max(0, ledger.reserved - amount)
      ledger.released += amount
      recovery.routeReason = `释放未被检查点确认的额度 ${amount} 条回当日额度池，当日可启动作业数增加；续跑时按剩余记录重新预留，不重复扣减`
    } else {
      recovery.carriedQuota += amount
      ledger.carried += amount
      recovery.routeReason = `把预留 ${amount} 条结转到下一次续跑：当日额度池仍占用，续跑无需重新预留、不重复扣减`
    }
    recovery.quotaRoute = route
    recovery.version += 1
    recovery.note = `未确认额度 ${amount} 条已按「${label}」落库`
    upsertReleasePending({
      ...open,
      route,
      status: '已落库',
      resolvedAt: now(),
      note: `${label}：${amount} 条已落库`,
    })
    saveRecovery(recovery)
    saveLedger(ledger)
    const result = saveResult(buildResultData(recovery))
    return { ok: true, message: `已按「${label}」落库 ${amount} 条，断点续跑结果数据 v${result.version} 已刷新，供复核` }
  }

  // 没有待处理项：要么重复操作，要么与既有路线冲突，需要改判
  if (!recovery.quotaRoute) {
    return { ok: false, message: '没有待处理的未确认额度，请先「核对未确认额度」' }
  }
  if (recovery.quotaRoute === route) {
    return { ok: false, message: `当前已采用「${label}」路线，无需重复落库` }
  }
  const prevLabel = ROUTE_LABELS[recovery.quotaRoute]
  const conflictAmount = route === 'release' ? recovery.carriedQuota : recovery.releasedQuota
  if (conflictAmount <= 0) {
    return { ok: false, message: '没有可改判的额度' }
  }
  if (route === 'release') {
    recovery.carriedQuota -= conflictAmount
    recovery.releasedQuota += conflictAmount
    ledger.carried = Math.max(0, ledger.carried - conflictAmount)
    ledger.reserved = Math.max(0, ledger.reserved - conflictAmount)
    ledger.released += conflictAmount
  } else {
    recovery.releasedQuota -= conflictAmount
    recovery.carriedQuota += conflictAmount
    ledger.released = Math.max(0, ledger.released - conflictAmount)
    ledger.reserved += conflictAmount
    ledger.carried += conflictAmount
  }
  recovery.quotaRoute = route
  recovery.version += 1
  recovery.routeReason = `冲突判定：先前「${prevLabel}」${conflictAmount} 条与本次「${label}」冲突，改判为「${label}」落库；本地持久化版本递增为 v${recovery.version}，供复核`
  recovery.note = `冲突改判：${prevLabel} → ${label}（${conflictAmount} 条）`
  // 冲突改判也落到待处理清单，作为可回看的审计轨迹
  upsertReleasePending({
    id: `${recovery.jobKey}-${Date.now()}`,
    jobId: recovery.jobId,
    jobKey: recovery.jobKey,
    amount: conflictAmount,
    route,
    status: '已落库',
    createdAt: now(),
    resolvedAt: now(),
    note: `冲突改判：${prevLabel} → ${label}，${conflictAmount} 条额度改判落库`,
  })
  saveRecovery(recovery)
  saveLedger(ledger)
  const result = saveResult(buildResultData(recovery))
  return {
    ok: true,
    message: `冲突已判定：改走「${label}」路线，${conflictAmount} 条额度已改判落库，断点续跑结果数据 v${result.version} 供复核`,
  }
}

// ---------- 复核记录导出 ----------

export function exportResumeResult(jobId: number): { filename: string; content: string } | null {
  const row = findSpiderRow(jobId)
  if (!row) {
    return null
  }
  const result = getResult(jobKeyOf(row))
  if (!result) {
    return null
  }
  return {
    filename: `断点续跑结果-${result.jobKey}-v${result.version}.json`,
    content: `﻿${JSON.stringify(result, null, 2)}`,
  }
}
