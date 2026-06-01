/**
 * Data-access dispatch. `db.from(table)` returns either the real Supabase query
 * builder (signed-in mode) or a localStorage-backed shim that mimics the slice of
 * PostgREST the app actually uses (guest mode). Every store/lib reads and writes
 * through `db.from`, so the same code path serves both modes — the only thing that
 * changes is where the rows live.
 *
 * The shim is deliberately narrow: it implements exactly the query shapes used in
 * this codebase (see the chained methods below), the two computed views
 * (v_current_budget / v_active_wish_pool), and the handful of relational embeds
 * (review_results → review_tasks → transactions). It is NOT a general PostgREST.
 */
import { supabase } from '@/lib/supabase'
import { isGuestMode, GUEST_TABLE_PREFIX } from '@/lib/guestMode'

// ─── localStorage table helpers ──────────────────────────────────────────────

type Row = Record<string, unknown>

function tableKey(table: string): string {
  return GUEST_TABLE_PREFIX + table
}

function readRows(table: string): Row[] {
  try {
    const raw = localStorage.getItem(tableKey(table))
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeRows(table: string, rows: Row[]): void {
  localStorage.setItem(tableKey(table), JSON.stringify(rows))
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

const pad = (n: number) => String(n).padStart(2, '0')
const monthOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`

// ─── Insert defaults ─────────────────────────────────────────────────────────
// In Postgres these come from column DEFAULTs; the shim has to supply the ones the
// app reads back (ids, ordering timestamps, status/boolean defaults).

/** Per-table timestamp columns to stamp with now() when the insert omits them. */
const TIME_FIELDS: Record<string, string[]> = {
  wishlist_items: ['added_at'],
  impulse_records: ['recorded_at'],
  wish_pools: ['created_at'],
  savings_records: ['recorded_at'],
  price_tracks: ['created_at'],
  price_records: ['recorded_at'],
  brand_library: ['created_at', 'updated_at'],
  sop_rules: ['created_at'],
  personal_principles: ['created_at'],
  subscriptions: ['created_at'],
  monthly_budgets: ['created_at'],
  transactions: ['created_at'],
  review_tasks: ['created_at'],
  review_results: ['completed_at'],
  execution_sessions: ['started_at'],
  user_settings: ['created_at', 'updated_at'],
  user_streak: ['updated_at'],
}

/** Per-table non-timestamp defaults, applied only when the insert omits the key. */
const FIELD_DEFAULTS: Record<string, Row> = {
  wishlist_items: {
    category: null, estimated_price: null, season_tag: 'year_round', priority: 0,
    need_intensity: null, worthiness_score: null, worthiness_reason: null,
    is_focus: false, last_nudged_at: null, status: 'active', impulse_record_id: null,
    image_url: null, brand: null, fabric: null, color: null, size: null,
    channel: null, notes: null,
  },
  impulse_records: { estimated_price: null, season_tag: 'year_round', source: null, status: 'pending' },
  subscriptions: { is_active: true },
  brand_library: { weight: 5, note: null },
  price_records: { is_manual: false },
  price_tracks: {
    wishlist_item_id: null, target_price: null, current_price: null,
    source_url: null, last_checked_at: null,
  },
  review_tasks: { transaction_id: null, brand: null, category: null, status: 'pending' },
  review_results: { usage_note: null },
  transactions: { review_tag: null },
  monthly_budgets: { total_income: null, note: null, ai_suggested: false },
}

function applyInsertDefaults(table: string, row: Row): Row {
  const out: Row = { ...FIELD_DEFAULTS[table], ...row }
  if (out.id == null) out.id = uuid()
  const now = new Date().toISOString()
  for (const f of TIME_FIELDS[table] ?? []) {
    if (out[f] == null) out[f] = now
  }
  return out
}

// ─── Computed views ──────────────────────────────────────────────────────────

function computeView(table: string): Row[] {
  if (table === 'v_current_budget') {
    const month = monthOf(new Date())
    const budget = readRows('monthly_budgets').find((b) => b.month === month)
    if (!budget) return []
    const txns = readRows('transactions').filter((t) => String(t.date).slice(0, 7) === month)
    const sum = (main: string) =>
      txns.filter((t) => t.category_main === main).reduce((s, t) => s + Number(t.amount), 0)
    return [{ ...budget, basic_life_used: sum('basic_life'), discretionary_used: sum('discretionary') }]
  }

  if (table === 'v_active_wish_pool') {
    const focus = readRows('wishlist_items').find((w) => w.is_focus === true)
    if (!focus) return []
    const pool = readRows('wish_pools').find(
      (p) => p.focus_item_id === focus.id && p.completed_at == null,
    )
    if (!pool) return []
    const saved_amount = readRows('savings_records')
      .filter((s) => s.wish_pool_id === pool.id)
      .reduce((s, r) => s + Number(r.amount), 0)
    return [{ ...pool, saved_amount, focus_item_name: focus.item_name }]
  }

  return []
}

const VIEWS = new Set(['v_current_budget', 'v_active_wish_pool'])

// ─── Filtering / ordering ────────────────────────────────────────────────────

type Filter =
  | { kind: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'ilike'; col: string; val: unknown }
  | { kind: 'isNull' | 'notNull'; col: string }

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function passes(row: Row, f: Filter): boolean {
  const v = row[f.col]
  // Relational comparisons run over strings (ISO dates/timestamps) and numbers,
  // both of which order correctly with JS </> — cast to compare without TS noise.
  const a = v as number
  const b = (f as { val: unknown }).val as number
  switch (f.kind) {
    case 'eq': return v === f.val
    case 'neq': return v !== f.val
    case 'gt': return v != null && a > b
    case 'gte': return v != null && a >= b
    case 'lt': return v != null && a < b
    case 'lte': return v != null && a <= b
    case 'isNull': return v == null
    case 'notNull': return v != null
    case 'ilike': {
      if (v == null) return false
      // ilike: % is a wildcard, everything else literal + case-insensitive.
      const pat = escapeRegex(String(f.val)).replace(/%/g, '.*')
      return new RegExp(`^${pat}$`, 'i').test(String(v))
    }
  }
}

interface OrderClause {
  col: string
  ascending: boolean
}

function compareVals(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0
  if (a == null) return -1
  if (b == null) return 1
  const x = a as number
  const y = b as number
  if (x < y) return -1
  if (x > y) return 1
  return 0
}

// ─── Embedded resources (joins) ──────────────────────────────────────────────
// The app embeds belongs-to relations: a row carries a foreign-key column that
// points at the embedded table's id. Only the relations actually used are mapped.

/** embedName → the FK column on the embedding row that references embedName.id. */
const EMBED_FK: Record<string, string> = {
  review_tasks: 'review_task_id',
  transactions: 'transaction_id',
}

interface ParsedSelect {
  cols: string[]
  embeds: { name: string; inner: ParsedSelect; require: boolean }[]
}

/** Split on top-level commas (ignoring commas inside parentheses). */
function splitTopLevel(str: string): string[] {
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of str) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur.trim()) parts.push(cur)
  return parts.map((s) => s.trim()).filter(Boolean)
}

function parseSelect(str: string): ParsedSelect {
  const cols: string[] = []
  const embeds: ParsedSelect['embeds'] = []
  for (const part of splitTopLevel(str)) {
    const m = part.match(/^([a-zA-Z_][\w]*)(!inner|!left)?\s*\(([\s\S]*)\)$/)
    if (m) {
      embeds.push({ name: m[1], inner: parseSelect(m[3]), require: m[2] === '!inner' })
    } else {
      cols.push(part)
    }
  }
  return { cols, embeds }
}

/** Project a parent row down to the selected columns, resolving nested embeds. */
function projectRow(row: Row, sel: ParsedSelect): Row {
  const out: Row = {}
  const wantsAll = sel.cols.includes('*')
  if (wantsAll) Object.assign(out, row)
  else for (const c of sel.cols) out[c] = row[c]
  for (const e of sel.embeds) {
    const fk = EMBED_FK[e.name]
    const child = fk ? readRows(e.name).find((r) => r.id === row[fk]) : undefined
    out[e.name] = child ? projectRow(child, e.inner) : null
  }
  return out
}

/** Attach embeds to base rows; drop rows whose required (`!inner`) embed is null. */
function resolveEmbeds(rows: Row[], sel: ParsedSelect): Row[] {
  if (sel.embeds.length === 0) return rows
  const out: Row[] = []
  for (const row of rows) {
    const enriched: Row = { ...row }
    let keep = true
    for (const e of sel.embeds) {
      const fk = EMBED_FK[e.name]
      const child = fk ? readRows(e.name).find((r) => r.id === row[fk]) : undefined
      const projected = child ? projectRow(child, e.inner) : null
      if (!projected && e.require) keep = false
      enriched[e.name] = projected
    }
    if (keep) out.push(enriched)
  }
  return out
}

// ─── Query builder ───────────────────────────────────────────────────────────

interface Result {
  data: unknown
  error: { message: string } | null
  count: number | null
}

type Op = 'select' | 'insert' | 'update' | 'delete' | 'upsert'

class GuestQuery implements PromiseLike<Result> {
  private op: Op = 'select'
  private payload: Row[] = []
  private filters: Filter[] = []
  private orders: OrderClause[] = []
  private limitN: number | null = null
  private selectStr = '*'
  private wantSelect = false // .select() called after a mutation → return rows
  private singleMode: 'one' | 'maybe' | null = null
  private head = false
  private countExact = false
  private upsertOnConflict: string[] = ['id']
  private upsertIgnoreDup = false

  constructor(private table: string) {}

  // — terminal-shaping —
  select(str = '*', opts?: { count?: 'exact'; head?: boolean }) {
    this.selectStr = str || '*'
    if (this.op === 'select') {
      if (opts?.count === 'exact') this.countExact = true
      if (opts?.head) this.head = true
    } else {
      this.wantSelect = true
    }
    return this
  }

  insert(rows: Row | Row[]) {
    this.op = 'insert'
    this.payload = Array.isArray(rows) ? rows : [rows]
    return this
  }

  upsert(rows: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.op = 'upsert'
    this.payload = Array.isArray(rows) ? rows : [rows]
    if (opts?.onConflict) this.upsertOnConflict = opts.onConflict.split(',').map((s) => s.trim())
    this.upsertIgnoreDup = !!opts?.ignoreDuplicates
    return this
  }

  update(patch: Row) {
    this.op = 'update'
    this.payload = [patch]
    return this
  }

  delete() {
    this.op = 'delete'
    return this
  }

  // — filters —
  eq(col: string, val: unknown) { this.filters.push({ kind: 'eq', col, val }); return this }
  neq(col: string, val: unknown) { this.filters.push({ kind: 'neq', col, val }); return this }
  gt(col: string, val: unknown) { this.filters.push({ kind: 'gt', col, val }); return this }
  gte(col: string, val: unknown) { this.filters.push({ kind: 'gte', col, val }); return this }
  lt(col: string, val: unknown) { this.filters.push({ kind: 'lt', col, val }); return this }
  lte(col: string, val: unknown) { this.filters.push({ kind: 'lte', col, val }); return this }
  ilike(col: string, val: unknown) { this.filters.push({ kind: 'ilike', col, val }); return this }

  is(col: string, val: null) {
    this.filters.push({ kind: 'isNull', col })
    void val
    return this
  }

  not(col: string, operator: string, val: unknown) {
    // Only `.not(col, 'is', null)` is used in the codebase.
    if (operator === 'is' && val === null) this.filters.push({ kind: 'notNull', col })
    return this
  }

  // — modifiers —
  order(col: string, opts?: { ascending?: boolean }) {
    this.orders.push({ col, ascending: opts?.ascending !== false })
    return this
  }

  limit(n: number) { this.limitN = n; return this }

  single() { this.singleMode = 'one'; return this }
  maybeSingle() { this.singleMode = 'maybe'; return this }

  // — execution —
  private exec(): Result {
    switch (this.op) {
      case 'select': return this.execSelect()
      case 'insert': return this.execInsert()
      case 'update': return this.execUpdate()
      case 'delete': return this.execDelete()
      case 'upsert': return this.execUpsert()
    }
  }

  private execSelect(): Result {
    const base = VIEWS.has(this.table) ? computeView(this.table) : readRows(this.table)
    let rows = base.filter((r) => this.filters.every((f) => passes(r, f)))
    const sel = parseSelect(this.selectStr)
    rows = resolveEmbeds(rows, sel)
    if (this.orders.length > 0) {
      rows = [...rows].sort((a, b) => {
        for (const o of this.orders) {
          const c = compareVals(a[o.col], b[o.col])
          if (c !== 0) return o.ascending ? c : -c
        }
        return 0
      })
    }
    const total = rows.length
    const limited = this.limitN != null ? rows.slice(0, this.limitN) : rows
    const count = this.countExact ? total : null

    if (this.head) return { data: null, error: null, count }
    if (this.singleMode) return { data: limited[0] ?? null, error: null, count }
    return { data: limited, error: null, count }
  }

  private execInsert(): Result {
    const rows = this.payload.map((r) => applyInsertDefaults(this.table, r))
    writeRows(this.table, [...readRows(this.table), ...rows])
    if (!this.wantSelect) return { data: null, error: null, count: null }
    return { data: this.singleMode ? rows[0] ?? null : rows, error: null, count: null }
  }

  private execUpdate(): Result {
    const patch = this.payload[0] ?? {}
    const updated: Row[] = []
    const next = readRows(this.table).map((r) => {
      if (this.filters.every((f) => passes(r, f))) {
        const merged = { ...r, ...patch }
        updated.push(merged)
        return merged
      }
      return r
    })
    writeRows(this.table, next)
    if (!this.wantSelect) return { data: null, error: null, count: null }
    return { data: this.singleMode ? updated[0] ?? null : updated, error: null, count: null }
  }

  private execDelete(): Result {
    const next = readRows(this.table).filter((r) => !this.filters.every((f) => passes(r, f)))
    writeRows(this.table, next)
    return { data: null, error: null, count: null }
  }

  private execUpsert(): Result {
    const existing = readRows(this.table)
    const written: Row[] = []
    for (const raw of this.payload) {
      const idx = existing.findIndex((e) =>
        this.upsertOnConflict.every((c) => e[c] === raw[c]),
      )
      if (idx >= 0) {
        if (this.upsertIgnoreDup) continue
        existing[idx] = { ...existing[idx], ...raw }
        written.push(existing[idx])
      } else {
        const row = applyInsertDefaults(this.table, raw)
        existing.push(row)
        written.push(row)
      }
    }
    writeRows(this.table, existing)
    if (!this.wantSelect) return { data: null, error: null, count: null }
    return { data: this.singleMode ? written[0] ?? null : written, error: null, count: null }
  }

  then<TResult1 = Result, TResult2 = never>(
    onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    let result: Result
    try {
      result = this.exec()
    } catch (e) {
      result = { data: null, error: { message: (e as Error)?.message ?? String(e) }, count: null }
    }
    return Promise.resolve(result).then(onfulfilled, onrejected)
  }
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

/**
 * `db.from(table)` — the data entry point used everywhere instead of
 * `supabase.from`. Returns the localStorage shim in guest mode, the real Supabase
 * builder otherwise. Typed `any` because the two builders are structurally
 * different; callers already cast the `data` they read (as they did with Supabase).
 */
export const db = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any {
    return isGuestMode() ? new GuestQuery(table) : supabase.from(table)
  },
}
