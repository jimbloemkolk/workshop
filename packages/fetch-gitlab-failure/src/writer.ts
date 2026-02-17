/**
 * Failure writer — writes failures.json and metadata.json.
 *
 * Output format:
 * - {outputDir}/failures.json  — the full FailureFetchResult (all job failure data)
 * - {outputDir}/metadata.json  — just the metadata portion for discovery / quick stats
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Writer, WriteOptions } from '@gitlab-analysis/fetcher-core';
import type { FailureFetchResult } from './types.js';

export class FailureWriter implements Writer<FailureFetchResult> {
  async write(result: FailureFetchResult, options: WriteOptions): Promise<void> {
    if (options.stdout) {
      process.stdout.write(JSON.stringify(result, null, 2));
      return;
    }

    const dir = options.outputDir ?? process.cwd();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Write full failure data
    const failuresFile = join(dir, 'failures.json');
    writeFileSync(failuresFile, JSON.stringify(result, null, 2));

    // Write metadata only (for dataset discovery / quick stats)
    const metadataFile = join(dir, 'metadata.json');
    writeFileSync(metadataFile, JSON.stringify(result.metadata, null, 2));
  }
}
