import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * An in-memory stand-in for a Supabase PostgREST client.
 *
 * It does two jobs that a plain mock would not:
 *
 *  1. It records every query, so a test can assert that the application layer
 *     filtered by user_id — the check that has to hold even before RLS.
 *  2. It *simulates* RLS: when `rlsUserId` is set, rows belonging to anyone
 *     else are invisible and writes that name another user are rejected with
 *     Postgres' insufficient_privilege code. So a test that forgets the
 *     application filter still cannot read across users, which is exactly the
 *     property the real deployment relies on.
 *
 * It is not a Postgres. It implements the subset of the query builder this
 * codebase actually uses, and throws on anything else rather than silently
 * returning the wrong rows.
 */

export type Row = Record<string, unknown>;
export type Tables = Record<string, Row[]>;

export type RecordedQuery = {
  table: string;
  op: 'select' | 'insert' | 'update' | 'upsert' | 'delete';
  filters: Array<{ column: string; op: string; value: unknown }>;
  payload?: Row | Row[];
};

export type FakeSupabase = {
  client: SupabaseClient;
  tables: Tables;
  calls: RecordedQuery[];
  /** Queries against a table, for assertions. */
  queriesFor(table: string): RecordedQuery[];
  /**
   * The most queries that were ever in flight at once.
   *
   * How you tell a batch from a chain without a stopwatch: code that awaits
   * its reads one after another never gets above one, however fast the machine
   * is. Asserting on this instead of elapsed time is the difference between a
   * test that means something and a test that fails when the suite is busy.
   */
  maxConcurrent: number;
};

const RLS_ERROR = { message: 'new row violates row-level security policy', code: '42501' };

/**
 * Column defaults, mirroring supabase/migrations/0001_schema.sql.
 *
 * Without these an inserted row would lack the columns later queries filter on
 * (`timers.status`, `cooking_sessions.current_step`), and tests would pass or
 * fail for reasons Postgres would not reproduce.
 */
const DEFAULTS: Record<string, Row> = {
  profiles: { display_name: null, preferences: {} },
  recipes: { ingredients: [], steps: [], servings: 2, is_favorite: false, source: null },
  cooking_sessions: { recipe_id: null, current_step: 0, status: 'active', notes: {} },
  user_memory: { kind: 'preference' },
  timers: {
    label: 'timer',
    status: 'running',
    started_at: new Date().toISOString(),
    session_id: null,
    kind: 'timer',
    step_index: null,
    heads_up_at: null,
    reminded_at: null,
  },
  conversation_turns: { text: '', heard_text: null, interrupted: false, metrics: {} },
};

export function createFakeSupabase(options: {
  tables: Tables;
  /** The authenticated user. Rows owned by anyone else are invisible. */
  rlsUserId?: string;
  /**
   * Artificial round-trip time for every query.
   *
   * The real database is in another region; a query costs more than the
   * microseconds this fake takes. Tests that care about how many round trips
   * sit in front of the first spoken word set this so chaining what could run
   * concurrently shows up as elapsed time instead of hiding.
   */
  latencyMs?: number;
}): FakeSupabase {
  // Deliberately the caller's object, not a copy: a test asserts on the same
  // store the code under test wrote to, and two clients can share one store to
  // model two users against one database.
  const tables: Tables = options.tables;
  const calls: RecordedQuery[] = [];
  const rlsUserId = options.rlsUserId;
  const latencyMs = options.latencyMs ?? 0;
  let inFlight = 0;
  let maxConcurrent = 0;

  let idCounter = 0;
  const nextId = () => `00000000-0000-4000-8000-${String(++idCounter).padStart(12, '0')}`;

  function visible(table: string, rows: Row[]): Row[] {
    if (!rlsUserId) return rows;
    // profiles is keyed by `id`; every other user-owned table by `user_id`.
    return rows.filter((row) => {
      if ('user_id' in row) return row.user_id === rlsUserId;
      if (table === 'profiles' && 'id' in row) return row.id === rlsUserId;
      return true;
    });
  }

  class Builder implements PromiseLike<{ data: unknown; error: unknown }> {
    private filters: RecordedQuery['filters'] = [];
    private orders: Array<{ column: string; ascending: boolean }> = [];
    private limitCount: number | null = null;
    private selected = false;
    private mode: 'one' | 'maybe' | 'many' = 'many';
    private payload: Row | Row[] | undefined;
    private onConflict: string[] = [];

    constructor(
      private readonly table: string,
      private readonly op: RecordedQuery['op'],
    ) {}

    select(_columns?: string): this {
      this.selected = true;
      return this;
    }

    eq(column: string, value: unknown): this {
      this.filters.push({ column, op: 'eq', value });
      return this;
    }

    in(column: string, value: unknown[]): this {
      this.filters.push({ column, op: 'in', value });
      return this;
    }

    or(clause: string): this {
      this.filters.push({ column: '*', op: 'or', value: clause });
      return this;
    }

    order(column: string, opts?: { ascending?: boolean }): this {
      this.orders.push({ column, ascending: opts?.ascending ?? true });
      return this;
    }

    limit(count: number): this {
      this.limitCount = count;
      return this;
    }

    single(): this {
      this.mode = 'one';
      return this;
    }

    maybeSingle(): this {
      this.mode = 'maybe';
      return this;
    }

    setPayload(payload: Row | Row[], onConflict?: string): this {
      this.payload = payload;
      if (onConflict) this.onConflict = onConflict.split(',').map((part) => part.trim());
      return this;
    }

    private matches(row: Row): boolean {
      return this.filters.every((filter) => {
        if (filter.op === 'eq') return row[filter.column] === filter.value;
        if (filter.op === 'in') return (filter.value as unknown[]).includes(row[filter.column]);
        if (filter.op === 'or') return matchesOr(row, String(filter.value));
        throw new Error(`fake-supabase: unsupported filter ${filter.op}`);
      });
    }

    private run(): { data: unknown; error: unknown } {
      calls.push({
        table: this.table,
        op: this.op,
        filters: this.filters,
        ...(this.payload === undefined ? {} : { payload: this.payload }),
      });

      const store = (tables[this.table] ??= []);

      if (this.op === 'insert' || this.op === 'upsert') {
        const incoming = Array.isArray(this.payload) ? this.payload : [this.payload ?? {}];
        const written: Row[] = [];

        for (const candidate of incoming) {
          if (rlsUserId && 'user_id' in candidate && candidate.user_id !== rlsUserId) {
            return { data: null, error: RLS_ERROR };
          }
          if (rlsUserId && this.table === 'profiles' && candidate.id !== rlsUserId) {
            return { data: null, error: RLS_ERROR };
          }

          const conflictKeys = this.onConflict.length > 0 ? this.onConflict : ['id'];
          const existing = store.find((row) =>
            conflictKeys.every((key) => key in candidate && row[key] === candidate[key]),
          );

          if (existing && this.op === 'upsert') {
            Object.assign(existing, candidate, { updated_at: new Date().toISOString() });
            written.push(existing);
          } else {
            const row: Row = {
              id: nextId(),
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              ...(DEFAULTS[this.table] ?? {}),
              ...candidate,
            };
            store.push(row);
            written.push(row);
          }
        }

        const data = this.mode === 'many' ? written : (written[0] ?? null);
        return { data, error: null };
      }

      if (this.op === 'update') {
        const targets = visible(this.table, store).filter((row) => this.matches(row));
        for (const row of targets) {
          Object.assign(row, this.payload as Row, { updated_at: new Date().toISOString() });
        }
        const data = this.mode === 'many' ? targets : (targets[0] ?? null);
        return { data: this.selected ? data : null, error: null };
      }

      if (this.op === 'delete') {
        const survivors = store.filter(
          (row) => !(visible(this.table, [row]).length > 0 && this.matches(row)),
        );
        tables[this.table] = survivors;
        return { data: null, error: null };
      }

      let rows = visible(this.table, store).filter((row) => this.matches(row));

      for (const order of [...this.orders].reverse()) {
        rows = [...rows].sort((a, b) => {
          const left = a[order.column];
          const right = b[order.column];
          const comparison = compare(left, right);
          return order.ascending ? comparison : -comparison;
        });
      }

      if (this.limitCount !== null) rows = rows.slice(0, this.limitCount);

      if (this.mode === 'one') {
        const row = rows[0];
        return row
          ? { data: row, error: null }
          : { data: null, error: { message: 'no rows returned', code: 'PGRST116' } };
      }
      if (this.mode === 'maybe') return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    }

    then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
      onfulfilled?:
        | ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>)
        | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      const settle = () => this.run();
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      const done = <T,>(value: T): T => {
        inFlight -= 1;
        return value;
      };
      const promise = latencyMs > 0
        ? new Promise<{ data: unknown; error: unknown }>((resolve) => {
            setTimeout(() => resolve(settle()), latencyMs);
          })
        : Promise.resolve(settle());
      return promise.then(done).then(onfulfilled, onrejected);
    }
  }

  const client = {
    from(table: string) {
      return {
        select: (columns?: string) => new Builder(table, 'select').select(columns),
        insert: (payload: Row | Row[]) => new Builder(table, 'insert').setPayload(payload),
        update: (payload: Row) => new Builder(table, 'update').setPayload(payload),
        upsert: (payload: Row | Row[], opts?: { onConflict?: string }) =>
          new Builder(table, 'upsert').setPayload(payload, opts?.onConflict),
        delete: () => new Builder(table, 'delete'),
      };
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    tables,
    calls,
    get maxConcurrent() {
      return maxConcurrent;
    },
    queriesFor: (table: string) => calls.filter((call) => call.table === table),
  };
}

/** Supports the two clause shapes `searchRecipes` builds. */
function matchesOr(row: Row, clause: string): boolean {
  return clause.split(',').some((part) => {
    const ilike = /^(\w+)\.ilike\.%(.*)%$/.exec(part);
    if (ilike) {
      const [, column, needle] = ilike;
      const value = row[column ?? ''];
      return typeof value === 'string' && value.toLowerCase().includes((needle ?? '').toLowerCase());
    }
    const contains = /^(\w+)\.cs\.\[\{"name":"(.*)"\}\]$/.exec(part);
    if (contains) {
      const [, column, needle] = contains;
      const value = row[column ?? ''];
      return (
        Array.isArray(value) &&
        value.some(
          (item) =>
            typeof item === 'object' &&
            item !== null &&
            String((item as { name?: unknown }).name ?? '').toLowerCase() === needle,
        )
      );
    }
    return false;
  });
}

function compare(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === null || left === undefined) return -1;
  if (right === null || right === undefined) return 1;
  if (typeof left === 'boolean' && typeof right === 'boolean') {
    return Number(left) - Number(right);
  }
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right));
}
