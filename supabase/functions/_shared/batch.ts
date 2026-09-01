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
