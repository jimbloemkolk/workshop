/**
 * Stdout writer — writes a result as JSON to stdout.
 */

import type { Writer, WriteOptions } from '../types.js';

/**
 * Writes the task result as JSON to stdout.
 * Ignores outputDir and other file-related options.
 */
export class StdoutWriter<TResult> implements Writer<TResult> {
  async write(result: TResult, options: WriteOptions): Promise<void> {
    const indent = options.pretty ? 2 : undefined;
    process.stdout.write(JSON.stringify(result, null, indent));
  }
}
