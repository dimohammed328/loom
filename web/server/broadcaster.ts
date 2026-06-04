/**
 * Synchronous pub/sub broadcaster hub.
 *
 * Each subscriber registers a callback. When a message is published,
 * it is delivered synchronously to every subscriber's callback.
 *
 * Mirrors src/loom_web/broadcaster.py but adapted for Bun's single-threaded
 * event model: instead of asyncio.Queue per subscriber, each subscriber is
 * a plain callback (typically a WebSocket send function).
 */

export type Subscriber = (message: Record<string, unknown>) => void;

export class Broadcaster {
  private _subscribers: Set<Subscriber> = new Set();

  /** Register a subscriber callback. */
  subscribe(fn: Subscriber): void {
    this._subscribers.add(fn);
  }

  /** Remove a subscriber callback. */
  unsubscribe(fn: Subscriber): void {
    this._subscribers.delete(fn);
  }

  /** Deliver message to all registered subscribers. */
  publish(message: Record<string, unknown>): void {
    for (const fn of this._subscribers) {
      fn(message);
    }
  }
}
