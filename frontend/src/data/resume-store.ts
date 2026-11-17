// 断点续跑的本地持久化层：恢复状态（断点检查点 + 失败前已提交的采集结果）、
// 采集作业断点续跑结果数据、释放未被检查点确认的额度待处理清单、当日额度台账。
// 与 local-store.ts 同一套实现思路：全部落在浏览器 localStorage，刷新或重开浏览器都还在。

const RESUME_STORAGE_KEY = 'scraper-strategy-studio:resume'

/** 断点检查点：一批已提交结果落地时的确认记录 */
export type Checkpoint = {
  seq: number
  batchRecords: number
  committedRecords: number
  quotaConfirmed: number
  sourceAddress: string
  committedAt: string
  results: string[]
}

/** 中断信息：保留中断位置并给出重试说明原因 */
export type InterruptInfo = {
  position: number
  reason: string
  retryHint: string
  at: string
}

/** 恢复状态：失败前已提交的采集结果与断点检查点作为一份状态保存 */
export type RecoveryState = {
  jobId: number
  jobKey: string
  orchestration: string
  entity: string
  startAddress: string
  plannedTotal: number
  reservedQuota: number
  reReservedQuota: number
  confirmedQuota: number
  releasedQuota: number
  carriedQuota: number
  reviewedUnconfirmed: number
  quotaRoute: 'release' | 'carryover' | null
  routeReason: string
  checkpoints: Checkpoint[]
  submittedResults: string[]
  deductedRecordKeys: string[]
  interrupt: InterruptInfo | null
  resumeRuns: number
  version: number
  note: string
  updatedAt: string
}

/** 采集作业断点续跑结果数据：续跑依据与额度扣减标记，供复核 */
export type ResumeResultData = {
  jobId: number
  jobKey: string
  orchestration: string
  entity: string
  startAddress: string
  generatedAt: string
  version: number
  checkpointCount: number
  committedRecords: number
  remainingRecords: number
  resumeFromSeq: number
  releaseBasis: number
  releasedUnconfirmed: number
  carriedForward: number
  quotaRoute: string
  routeReason: string
  deductionMarkers: { recordKey: string; deducted: boolean }[]
  skippedRecords: string[]
  pendingRecords: string[]
  snapshotNote: string
}

/** 释放未被检查点确认的额度待处理清单项 */
export type ReleasePendingItem = {
  id: string
  jobId: number
  jobKey: string
  amount: number
  route: 'release' | 'carryover' | '待判定'
  status: '待处理' | '已落库'
  createdAt: string
  resolvedAt: string | null
  note: string
}

/** 当日额度台账：释放或结转直接影响当日可启动作业数量 */
export type QuotaLedger = {
  day: string
  capacity: number
  reserved: number
  deducted: number
  released: number
  carried: number
}

type ResumeStorage = {
  recoveries: Record<string, RecoveryState>
  results: Record<string, ResumeResultData>
  releasePending: ReleasePendingItem[]
  ledger: QuotaLedger
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

export function now(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

export function today(): string {
  return now().slice(0, 10)
}

export function recordKeyOf(jobKey: string, n: number): string {
  return `${jobKey}-R${String(n).padStart(4, '0')}`
}

export function rangeKeys(jobKey: string, from: number, to: number): string[] {
  const keys: string[] = []
  for (let n = from; n <= to; n += 1) {
    keys.push(recordKeyOf(jobKey, n))
  }
  return keys
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 示例恢复状态：SPID-0004 失败前已提交 2 个检查点（60 条），
// 仍有 90 条额度处于“已预留但检查点尚未落地”的状态，等待核对释放或结转。
function seedStorage(): ResumeStorage {
  const committed = rangeKeys('SPID-0004', 1, 60)
  const checkpoints: Checkpoint[] = [
    {
      seq: 1,
      batchRecords: 30,
      committedRecords: 30,
      quotaConfirmed: 30,
      sourceAddress: 'https://shop.example.com/items?page=1',
      committedAt: '2026-11-17 09:10:00',
      results: committed.slice(0, 30),
    },
    {
      seq: 2,
      batchRecords: 30,
      committedRecords: 60,
      quotaConfirmed: 30,
      sourceAddress: 'https://shop.example.com/items?page=1',
      committedAt: '2026-11-17 09:40:00',
      results: committed.slice(30, 60),
    },
  ]
  return {
    recoveries: {
      'SPID-0004': {
        jobId: 4,
        jobKey: 'SPID-0004',
        orchestration: '任务编排',
        entity: '采集作业',
        startAddress: 'https://shop.example.com/items?page=1',
        plannedTotal: 150,
        reservedQuota: 150,
        reReservedQuota: 0,
        confirmedQuota: 60,
        releasedQuota: 0,
        carriedQuota: 0,
        reviewedUnconfirmed: 0,
        quotaRoute: null,
        routeReason: '',
        checkpoints,
        submittedResults: committed,
        deductedRecordKeys: committed,
        interrupt: {
          position: 60,
          reason: '网络超时：第 3 批结果已生成但检查点尚未落地，90 条额度处于已预留未确认状态',
          retryHint: '先核对未确认额度并选择释放或结转路线，再从检查点 #2 断点续跑；已提交的 60 条不会重跑、不重复扣减额度',
          at: '2026-11-17 09:55:00',
        },
        resumeRuns: 0,
        version: 3,
        note: '示例恢复状态：失败前已提交 2 个检查点，等待值班员核对未确认额度',
        updatedAt: '2026-11-17 09:55:00',
      },
    },
    results: {},
    releasePending: [],
    ledger: { day: today(), capacity: 500, reserved: 90, deducted: 60, released: 0, carried: 0 },
  }
}

function readStorage(): ResumeStorage {
  const fallback = seedStorage()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(RESUME_STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(RESUME_STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ResumeStorage>
    return {
      recoveries: { ...fallback.recoveries, ...(parsed.recoveries ?? {}) },
      results: { ...fallback.results, ...(parsed.results ?? {}) },
      releasePending: parsed.releasePending ?? fallback.releasePending,
      ledger: { ...fallback.ledger, ...(parsed.ledger ?? {}) },
    }
  } catch {
    window.localStorage.setItem(RESUME_STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: ResumeStorage | null = null

function store(): ResumeStorage {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

function persist(): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(RESUME_STORAGE_KEY, JSON.stringify(store()))
  }
}

export function getRecovery(jobKey: string): RecoveryState | null {
  const found = store().recoveries[jobKey]
  return found ? clone(found) : null
}

/**
 * 保存恢复状态。重试中断不能覆盖更完整的检查点：
 * 写回状态的已确认进度落后于本地时，保留本地更完整的检查点与已提交结果，版本只增不减。
 */
export function saveRecovery(next: RecoveryState): RecoveryState {
  const data = store()
  const prev = data.recoveries[next.jobKey]
  let merged: RecoveryState = { ...next, updatedAt: now() }
  if (prev) {
    merged.version = Math.max(next.version, prev.version + 1)
    if (next.confirmedQuota < prev.confirmedQuota || next.checkpoints.length < prev.checkpoints.length) {
      merged = {
        ...merged,
        checkpoints: prev.checkpoints,
        submittedResults: prev.submittedResults,
        confirmedQuota: prev.confirmedQuota,
        deductedRecordKeys: [...new Set([...prev.deductedRecordKeys, ...next.deductedRecordKeys])],
        note: `${next.note}（检测到较旧状态写回，已保留更完整的检查点 #${prev.checkpoints.length}）`,
      }
    }
  }
  data.recoveries[next.jobKey] = merged
  persist()
  return clone(merged)
}

export function getResult(jobKey: string): ResumeResultData | null {
  const found = store().results[jobKey]
  return found ? clone(found) : null
}

/** 保存断点续跑结果数据：版本只增不减，不跳回先前版本，当前业务证据继续保留 */
export function saveResult(next: ResumeResultData): ResumeResultData {
  const data = store()
  const prev = data.results[next.jobKey]
  if (prev && next.version <= prev.version) {
    return clone(prev)
  }
  data.results[next.jobKey] = clone(next)
  persist()
  return clone(next)
}

export function listReleasePending(): ReleasePendingItem[] {
  return clone(store().releasePending)
}

export function upsertReleasePending(item: ReleasePendingItem): void {
  const data = store()
  const index = data.releasePending.findIndex((entry) => entry.id === item.id)
  if (index >= 0) {
    data.releasePending[index] = clone(item)
  } else {
    data.releasePending.push(clone(item))
  }
  persist()
}

export function getLedger(): QuotaLedger {
  return clone(store().ledger)
}

export function saveLedger(ledger: QuotaLedger): void {
  store().ledger = clone(ledger)
  persist()
}

export function resumeStorageKey(): string {
  return RESUME_STORAGE_KEY
}
