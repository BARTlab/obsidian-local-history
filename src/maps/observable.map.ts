import { MapChangeAction } from '@/consts';
import type { ChangeHandler } from '@/types';

/**
 * Extended Map class that provides observable functionality.
 * Allows subscribing to changes in the map (set, delete, clear operations).
 * Used for reactive data management throughout the plugin.
 *
 * @template K - The type of keys in the map
 * @template V - The type of values in the map
 * @extends {Map<K, V>}
 */
export class ObservableMap<K, V> extends Map<K, V> {
  /**
   * Set of change handler functions that are notified when the map changes.
   * Each handler is called with the action type and relevant key/value.
   */
  protected listeners: Set<ChangeHandler<K, V>> = new Set();

  /**
   * Subscribes a handler function to be called when the map changes.
   *
   * @param {ChangeHandler<K, V>} handler - The function to call when the map changes
   */
  public subscribe(handler: ChangeHandler<K, V>): void {
    this.listeners.add(handler);
  }

  /**
   * Notifies all subscribed handlers of a change to the map.
   * Called internally by the set, delete, and clear methods.
   *
   * Iterates over a snapshot of the listener set, so a handler that
   * subscribes during dispatch cannot corrupt the in-progress iteration
   * (re-entrancy safety).
   *
   * @param {string} action - The type of change that occurred
   * @param {*} key - The key that was affected (if applicable)
   * @param {*} value - The value that was affected (if applicable)
   */
  public next(action: MapChangeAction, key?: K, value?: V): void {
    for (const listener of [...this.listeners]) {
      listener(action, key, value);
    }
  }

  /**
   * Sets a key-value pair in the map and notifies listeners of the change.
   * Only notifies listeners if the key is new or the value has changed.
   *
   * @param {*} key - The key to set
   * @param {*} value - The value to set
   * @return {this} This map instance for method chaining
   * @override
   */
  public override set(key: K, value: V): this {
    const hadKey: boolean = this.has(key);
    const prev: V | undefined = this.get(key);

    super.set(key, value);

    if (!hadKey || prev !== value) {
      this.next(MapChangeAction.set, key, value);
    }

    return this;
  }

  /**
   * Deletes a key-value pair from the map and notifies listeners of the change.
   * Only notifies listeners if a key was actually deleted.
   *
   * @param {*} key - The key to delete
   * @return {boolean} True if the key was deleted, false otherwise
   * @override
   */
  public override delete(key: K): boolean {
    const result: boolean = super.delete(key);

    if (result) {
      this.next(MapChangeAction.delete, key);
    }

    return result;
  }

  /**
   * Clears all key-value pairs from the map and notifies listeners of the change.
   * Only notifies listeners if the map wasn't empty.
   *
   * @return {number} The number of key-value pairs that were in the map before clearing
   * @override
   */
  public override clear(): number {
    const size: number = this.size;

    super.clear();

    if (size > 0) {
      this.next(MapChangeAction.clear);
    }

    return size;
  }
}
