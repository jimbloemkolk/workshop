/**
 * Job logs writer — writes job logs in a different format than pipeline data.
 * 
 * TODO: Define the actual output format. Could be:
 * - One JSON file with all logs
 * - One file per job log
 * - A structured directory with metadata + individual log files
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Writer, WriteOptions } from '@gitlab-analysis/fetcher-core';
import type { JobLogsFetchResult } from './types.js';

export class JobLogsWriter implements Writer<JobLogsFetchResult> {
  async write(result: JobLogsFetchResult, options: WriteOptions): Promise<void> {
    if (options.stdout) {
      process.stdout.write(JSON.stringify(result, null, 2));
      return;
    }

    const dir = options.outputDir ?? process.cwd();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Write the combined result
    const outputFile = join(dir, 'job-logs.json');
    writeFileSync(outputFile, JSON.stringify(result, null, 2));
  }
}
