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
   * Returns an object with an unsubscribe method to remove the handler.
   *
   * @param {Function} handler - The function to call when the map changes
   * @return {Object} An object with an unsubscribe method
   */
  public subscribe(handler: ChangeHandler<K, V>): { unsubscribe(): void } {
    this.listeners.add(handler);

    const listeners = this.listeners;

    return {
      unsubscribe(): void {
        listeners.delete(handler);
      }
    };
  }

  /**
   * Unsubscribes a handler function from map change notifications.
   *
   * @param {Function} handler - The handler function to remove
   */
  public unsubscribe(handler: ChangeHandler<K, V>): void {
    this.listeners.delete(handler);
  }

  /**
   * Notifies all subscribed handlers of a change to the map.
   * Called internally by the set, delete, and clear methods.
   *
   * @param {string} action - The type of change that occurred
   * @param {*} key - The key that was affected (if applicable)
   * @param {*} value - The value that was affected (if applicable)
   */
  public next(action: 'set' | 'delete' | 'clear' | 'update', key?: K, value?: V): void {
    for (const listener of this.listeners) {
      listener(action, key, value);
    }
  }

  /**
   * Sets a key-value pair in the map and notifies listeners of the change.
   * Only notifies listeners if the value has changed or if force is true.
   *
   * @param {*} key - The key to set
   * @param {*} value - The value to set
   * @param {boolean} force - Whether to force notification even if the value hasn't changed
   * @return {this} This map instance for method chaining
   * @override
   */
  public override set(key: K, value: V, force?: boolean): this {
    const hadKey: boolean = this.has(key);
    const prev: V = this.get(key);

    super.set(key, value);

    if (force || !hadKey || prev !== value) {
      this.next('set', key, value);
    }

    return this;
  }

  /**
   * Deletes a key-value pair from the map and notifies listeners of the change.
   * Only notifies listeners if a key was actually deleted or if force is true.
   *
   * @param {*} key - The key to delete
   * @param {boolean} force - Whether to force notification even if no key was deleted
   * @return {boolean} True if the key was deleted, false otherwise
   * @override
   */
  public override delete(key: K, force?: boolean): boolean {
    const result: boolean = super.delete(key);

    if (force || result) {
      this.next('delete', key);
    }

    return result;
  }

  /**
   * Clears all key-value pairs from the map and notifies listeners of the change.
   * Only notifies listeners if the map wasn't empty or if force is true.
   *
   * @param {boolean} force - Whether to force notification even if the map was empty
   * @return {number} The number of key-value pairs that were in the map before clearing
   * @override
   */
  public override clear(force?: boolean): number {
    const size: number = this.size;

    super.clear();

    if (force || size > 0) {
      this.next('clear');
    }

    return size;
  }
}
