/**
 * Per-user WebSocket connection accounting (Phase 2). A single user opening
 * unbounded sync connections is a cheap way to exhaust a node, so each
 * authenticated principal is capped. In-process is correct for a single node;
 * multi-node accounting (over Redis) is a later Phase 2 slice — the cap then
 * becomes per-node, which is still a useful guard.
 */
export class ConnectionCounter {
  private counts = new Map<string, number>();

  /**
   * Reserve a connection slot for `userId`. Returns false (and reserves
   * nothing) when the user is already at `max`. `max <= 0` disables the cap.
   */
  tryAcquire(userId: string, max: number): boolean {
    const current = this.counts.get(userId) ?? 0;
    if (max > 0 && current >= max) return false;
    this.counts.set(userId, current + 1);
    return true;
  }

  /** Release a slot previously reserved with tryAcquire. */
  release(userId: string): void {
    const current = this.counts.get(userId) ?? 0;
    if (current <= 1) this.counts.delete(userId);
    else this.counts.set(userId, current - 1);
  }

  /** Current open count for a user (0 when none). Test/introspection aid. */
  count(userId: string): number {
    return this.counts.get(userId) ?? 0;
  }
}

export const connections = new ConnectionCounter();
