/**
 * Batched `.in()` filters.
 *
 * PostgREST encodes an `.in()` list into the URL query string, so a few
 * hundred ids overflow the server's URL length limit (~8KB) and the request
 * fails BEFORE it is sent. The symptom is misleading: not a database error but
 *
 *   TypeError: error sending request ... /rest/v1/market_snapshots?select=...
 *
 * which reads like a network fault. Measured with real Kalshi tickers
 * (~27 chars each), 400 ids produces a ~12KB URL; 100 stays around 3KB.
 *
 * Anywhere a list can grow with the number of markets, users or trades, it has
 * to go through here. A list with a fixed small bound — an enum, a handful of
 * status values — does not.
 */

/** Ids per request. 100 keeps the URL near 3KB with room to spare. */
export const IN_BATCH = 100;

interface Result<T> {
  data: T[] | null;
  error: { message: string } | null;
}

/**
 * Run a select once per batch of ids and concatenate the rows.
 *
 * The callback receives one batch and returns the query, so callers keep full
 * control of columns, extra filters and ordering:
 *
 *   const rows = await selectInBatches(ids, (batch) =>
 *     db.from('market_snapshots').select('*').in('market_id', batch).gte('ts', since));
 *
 * Ordering across batches is NOT preserved — sort afterwards if it matters.
 */
export async function selectInBatches<T>(
  values: readonly string[],
  run: (batch: string[]) => PromiseLike<Result<T>>,
  opts: { chunk?: number; label?: string } = {},
): Promise<T[]> {
  if (values.length === 0) return [];

  const chunk = opts.chunk ?? IN_BATCH;
  const out: T[] = [];

  for (let i = 0; i < values.length; i += chunk) {
    const { data, error } = await run(values.slice(i, i + chunk) as string[]);
    if (error) {
      throw new Error(
        `${opts.label ?? 'batched select'} failed on ids ${i}-${i + chunk}: ${error.message}`,
      );
    }
    if (data) out.push(...data);
  }

  return out;
}

/**
 * PostgREST caps every response at 1,000 rows (max-rows) and says nothing:
 * `.limit(3000)` returns 1,000 with no error. The slow pricing tier asked for
 * 2,500 markets and got exactly 1,000 every hour, so each market was priced
 * every 2.5 hours instead of hourly, and the archive tier would have taken
 * five days to cycle instead of one. Silent truncation is the failure mode
 * to trust least, so every select whose row count scales with the data goes
 * through here.
 *
 * Pages with `.range()` until a short page or `max` rows. The callback must
 * apply a deterministic ORDER BY, or pages can overlap.
 */
export const PAGE = 1000;

export async function selectPaged<T>(
  run: (from: number, to: number) => PromiseLike<Result<T>>,
  opts: { max?: number; label?: string } = {},
): Promise<T[]> {
  const max = opts.max ?? Number.MAX_SAFE_INTEGER;
  const out: T[] = [];

  for (let from = 0; from < max; from += PAGE) {
    const to = Math.min(from + PAGE, max) - 1;
    const { data, error } = await run(from, to);
    if (error) throw new Error(`${opts.label ?? 'paged select'} failed at rows ${from}-${to}: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < to - from + 1) break;
  }

  return out;
}

/**
 * Batched `.in()` AND paged: for reads where each id can match many rows.
 *
 * selectInBatches keeps the URL short, but each batch is still one PostgREST
 * response, and PostgREST caps a response at 1,000 rows without saying so.
 * The scorer loaded price history for 100 markets per batch -- up to 72
 * snapshots each in a six-hour window, ~7,200 rows -- ordered by ts
 * ascending, and got the OLDEST thousand back. Most markets received a stale
 * partial history, many none, and drift was computed on the wrong end of the
 * window. Reported as skippedNoData, growing in step with tier size.
 *
 * So: fewer ids per batch, and .range() pages within each batch until a
 * short page. The callback must apply a deterministic ORDER BY.
 */
export async function selectInBatchesPaged<T>(
  values: readonly string[],
  run: (batch: string[], from: number, to: number) => PromiseLike<Result<T>>,
  opts: { chunk?: number; label?: string } = {},
): Promise<T[]> {
  if (values.length === 0) return [];

  const chunk = opts.chunk ?? 25;
  const out: T[] = [];

  for (let i = 0; i < values.length; i += chunk) {
    const batch = values.slice(i, i + chunk) as string[];
    for (let from = 0; ; from += PAGE) {
      const to = from + PAGE - 1;
      const { data, error } = await run(batch, from, to);
      if (error) {
        throw new Error(`${opts.label ?? 'batched paged select'} failed on ids ${i}-${i + chunk} rows ${from}-${to}: ${error.message}`);
      }
      if (!data || data.length === 0) break;
      out.push(...data);
      if (data.length < PAGE) break;
    }
  }

  return out;
}

/**
 * Same batching for writes that filter by a long id list — deletes and
 * updates. Errors are returned rather than thrown, because most callers treat
 * a failed cleanup as a warning rather than a reason to abandon the run.
 */
export async function forEachBatch(
  values: readonly string[],
  run: (batch: string[]) => PromiseLike<{ error: { message: string } | null }>,
  opts: { chunk?: number } = {},
): Promise<{ error: string | null }> {
  if (values.length === 0) return { error: null };

  const chunk = opts.chunk ?? IN_BATCH;
  for (let i = 0; i < values.length; i += chunk) {
    const { error } = await run(values.slice(i, i + chunk) as string[]);
    if (error) return { error: error.message };
  }
  return { error: null };
}
