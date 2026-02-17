/**
 * JSON file writer — writes a result as a JSON file to a directory.
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Writer, WriteOptions } from '../types.js';

export interface JsonFileWriterOptions {
  /** The filename to write (default: "output.json") */
  filename: string;
}

/**
 * Writes the task result as a JSON file.
 * 
 * If `options.stdout` is true, writes to stdout instead.
 * If `options.outputDir` is provided, writes to that directory.
 */
export class JsonFileWriter<TResult> implements Writer<TResult> {
  private readonly filename: string;

  constructor(writerOptions?: Partial<JsonFileWriterOptions>) {
    this.filename = writerOptions?.filename ?? 'output.json';
  }

  async write(result: TResult, options: WriteOptions): Promise<void> {
    const indent = options.pretty ? 2 : undefined;
    const json = JSON.stringify(result, null, indent);

    if (options.stdout) {
      process.stdout.write(json);
      return;
    }

    const dir = options.outputDir ?? process.cwd();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const outputPath = join(dir, this.filename);
    writeFileSync(outputPath, json);
  }
}
