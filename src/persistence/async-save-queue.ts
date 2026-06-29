/**
 * Serializes asynchronous write work so on-disk writes never race. Extracted
 * from PersistenceService, which owns the two work units (save and clear) but
 * delegates the ordering discipline here. The queue is domain-agnostic: it
 * knows nothing about shards or snapshots, only that every unit of work must run
 * strictly after the previous one, that a throwing unit must not poison the
 * chain, and that rapid `schedule` calls collapse into a single debounced run.
 *
 * Ordering: a single promise chain (`chain`) tail; every {@link enqueue}
 * appends its work as `.then(...)`, so units run in submission order and a
 * caller can await {@link settled} to flush the tail before teardown. Without
 * one chain, concurrent writers hit the disk out of order and last-writer-wins
 * is non-deterministic.
 *
 * Failure isolation: the stored `chain` is always left FULFILLED. A rejection
 * from `work` is caught and logged, never propagated, because every `enqueue`
 * chains with `.then(onFulfilled)` and no rejection handler - a single throwing
 * unit would otherwise leave `chain` rejected and permanently starve every
 * later unit and the final flush. Each unit is responsible for its own data
 * guards; this seam only guarantees the queue keeps running.
 */
export class AsyncSaveQueue {
  /** Pending debounced timer handle, or null when nothing is scheduled. */
  protected timer: ReturnType<typeof setTimeout> | null = null;

  /** Tail of the serialized write chain; every enqueue appends to it. */
  protected chain: Promise<void> = Promise.resolve();

  /**
   * @param {number} debounceMs - Debounce window {@link schedule} collapses rapid calls into
   */
  public constructor(
    protected readonly debounceMs: number,
  ) {
  }

  /**
   * Schedules a debounced run of `work`, collapsing rapid calls into one. Each
   * call cancels the pending timer and restarts it, so only the last scheduled
   * work is enqueued once the window elapses.
   *
   * @param {() => Promise<void>} work - The unit to enqueue when the window elapses
   */
  public schedule(work: () => Promise<void>): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout((): void => {
      this.timer = null;
      this.enqueue(work);
    }, this.debounceMs);
  }

  /**
   * Appends one unit of work to the serialized chain so it runs after every
   * previously enqueued unit completes. A rejection from `work` is caught and
   * logged here, never propagated, so the chain keeps running.
   *
   * @param {() => Promise<void>} work - The queued unit of write work
   */
  public enqueue(work: () => Promise<void>): void {
    this.chain = this.chain.then((): Promise<void> => work()).catch((error: unknown): void => {
      console.error('Local history: a queued write failed; continuing with the next', error);
    });
  }

  /** Cancels a pending debounced run, if any, so no scheduled work fires. */
  public cancelScheduled(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * The tail of the write chain. Await it to flush every enqueued unit that has
   * been submitted so far (used by teardown to drain before the plugin unloads).
   *
   * @return {Promise<void>} Resolves when the current tail has completed
   */
  public settled(): Promise<void> {
    return this.chain;
  }
}
