/**
 * Defines the available debug theme types for console logging.
 * Used to specify the visual style and color scheme of debug messages.
 */
export type DebugTheme = 'log' | 'success' | 'error' | 'warn' | 'info';

/**
 * CSS styles for each debug theme.
 * Maps theme names to their corresponding CSS style strings for console output.
 */
export const styles: Record<DebugTheme, string> = {
  log: 'background: #444; color: #0f0; font-weight: bold; padding: 2px 6px; border-radius: 4px;',
  success: 'background: #155724; color: #d4edda; font-weight: bold; padding: 2px 6px; border-radius: 4px;',
  error: 'background: #721c24; color: #f8d7da; font-weight: bold; padding: 2px 6px; border-radius: 4px;',
  warn: 'background: #856404; color: #fff3cd; font-weight: bold; padding: 2px 6px; border-radius: 4px;',
  info: 'background: #046385; color: #d4fff9; font-weight: bold; padding: 2px 6px; border-radius: 4px;',
};

/**
 * Helper class for debugging with styled console output.
 * Provides static methods for different types of log messages with consistent formatting.
 */
export class DebugHelper {
  /**
   * Logs a success message with green styling.
   *
   * @param {string} label - The message to display
   * @param {Record<string, unknown>} vars - Optional variables to log along with the message
   * @return {void}
   */
  public static success(label: string, vars?: Record<string, unknown>): void {
    this.log(label, vars, 'success');
  }

  /**
   * Logs an error message with red styling.
   *
   * @param {string} label - The message to display
   * @param {Record<string, unknown>} vars - Optional variables to log along with the message
   * @return {void}
   */
  public static error(label: string, vars?: Record<string, unknown>): void {
    this.log(label, vars, 'error');
  }

  /**
   * Logs a warning message with yellow styling.
   *
   * @param {string} label - The message to display
   * @param {Record<string, unknown>} vars - Optional variables to log along with the message
   * @return {void}
   */
  public static warn(label: string, vars?: Record<string, unknown>): void {
    this.log(label, vars, 'warn');
  }

  /**
   * Logs an informational message with blue styling.
   *
   * @param {string} label - The message to display
   * @param {Record<string, unknown>} vars - Optional variables to log along with the message
   * @return {void}
   */
  public static info(label: string, vars?: Record<string, unknown>): void {
    this.log(label, vars, 'info');
  }

  /**
   * Main logging method that all other methods call.
   * Creates a collapsible console group with styled header and displays variables if provided.
   * Includes a stack trace for debugging.
   *
   * @param {string} label - The message to display
   * @param {Record<string, unknown>} vars - Optional variables to log along with the message
   * @param {DebugTheme} theme - The theme to use for styling (defaults to 'log')
   * @return {void}
   */
  public static log(label: string, vars?: Record<string, unknown>, theme: DebugTheme = 'log'): void {
    const timestamp: string = new Date().toLocaleString();
    const fullLabel: string = `${label}  [${timestamp}]`;

    // eslint-disable-next-line no-console
    console.groupCollapsed(`%c${fullLabel}`, styles[theme]);

    if (vars && Object.keys(vars).length > 0) {
      // eslint-disable-next-line no-console
      console.log(vars);
      // console.log(JSON.parse(JSON.stringify(vars)));
    } else {
      // eslint-disable-next-line no-console
      console.log('(no variables)');
    }

    // eslint-disable-next-line no-console
    console.trace('Trace');
    // eslint-disable-next-line no-console
    console.groupEnd();
  }
}

/**
 * Convenience wrapper around the DebugHelper class.
 * Can be used as a function to directly call the log method, or as an object to access specific logging methods.
 *
 * @example
 * // Function style
 * debug('Message', { data: 'value' });
 *
 * @example
 * // Object style
 * debug.error('Error message', { error: err });
 */
export const debug = Object.assign(
  (...args: Parameters<typeof DebugHelper.log>): void => DebugHelper.log(...args),
  {
    log: DebugHelper.log,
    success: DebugHelper.success,
    error: DebugHelper.error,
    warn: DebugHelper.warn,
    info: DebugHelper.info,
  },
);
