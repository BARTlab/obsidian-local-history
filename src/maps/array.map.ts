import type { KeysMatching } from '@/types';
import { isFunction } from 'lodash-es';

/**
 * Extended Map class that provides array-like functionality.
 * Combines the key-value storage of Map with common Array methods.
 * Used throughout the plugin for efficient collection management.
 *
 * @template T - The type of values stored in the map
 * @extends {Map<number | string, T>}
 */
export class ArrayMap<T> extends Map<number | string, T> {
  /**
   * Creates an ArrayMap from an array of objects.
   * Uses either a property key or a function to determine the map keys.
   *
   * @template R - The type of objects in the input array
   * @template K - The key of R that has a string or number value
   * @param {Array} list - The array of objects to convert to an ArrayMap
   * @param {string|Function} key - Either a property name of R or a function that extracts a key from an R object
   * @return {ArrayMap} A new ArrayMap with the objects from the input array
   */
  public static make<
    R, K extends keyof R = KeysMatching<R, number | string>
  >(
    list: R[],
    key: K | ((item: R) => string | number)
  ): ArrayMap<R> {
    return new this(
      list.map((item: R): [string | number, R] => [isFunction(key) ? key(item) : item[key] as string | number, item])
    ) as ArrayMap<R>;
  }

  /**
   * Converts the map values to a simple array.
   * Useful for performing array operations on the map values.
   *
   * @return {Array} An array containing all values from the map
   */
  public simplify(): T[] {
    return [...this.values()];
  }

  /**
   * Finds the first element in the map that satisfies the provided testing function.
   * Converts the map to an array and uses Array.prototype.find.
   *
   * @param {Array} args - Arguments to pass to Array.prototype.find
   * @return {*} The first element that satisfies the testing function, or undefined if none is found
   */
  public find(...args: Parameters<Array<T>['filter']>): ReturnType<typeof Array.prototype.find> {
    return this.simplify().find(...args);
  }

  /**
   * Executes a reducer function on each element of the map.
   * Converts the map to an array and uses Array.prototype.reduce.
   *
   * @param {Array} args - Arguments to pass to Array.prototype.reduce
   * @return {*} The value that results from running the reducer
   */
  public reduce(...args: Parameters<Array<T>['reduce']>): ReturnType<typeof Array.prototype.reduce> {
    return this.simplify().reduce(...args);
  }

  /**
   * Finds the index of the first element in the map that satisfies the provided testing function.
   * Converts the map to an array and uses Array.prototype.findIndex.
   *
   * @param {Array} args - Arguments to pass to Array.prototype.findIndex
   * @return {number} The index of the first element that satisfies the testing function, or -1 if none is found
   */
  public findIndex(...args: Parameters<Array<T>['findIndex']>): ReturnType<typeof Array.prototype.findIndex> {
    return this.simplify().findIndex(...args);
  }

  /**
   * Creates a new array with all elements from the map that pass the test implemented by the provided function.
   * Converts the map to an array and uses Array.prototype.filter.
   *
   * @param {Array} args - Arguments to pass to Array.prototype.filter
   * @return {Array} A new array with the elements that pass the test
   */
  public filter(...args: Parameters<Array<T>['filter']>): ReturnType<typeof Array.prototype.filter> {
    return this.simplify().filter(...args);
  }
}
