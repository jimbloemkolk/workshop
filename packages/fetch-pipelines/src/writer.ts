/**
 * Pipeline writer — writes pipelines.json and metadata.json.
 * 
 * This is the pipeline-specific output format that the app package
 * expects in `app/public/datasets/{name}/`.
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Writer, WriteOptions } from '@workshop/fetcher-core';
import type { PipelineFetchResult } from './types.js';

/**
 * Writes pipeline data in the format expected by the app:
 * - {outputDir}/pipelines.json  — the pipeline data
 * - {outputDir}/metadata.json   — fetch metadata
 */
export class PipelineWriter implements Writer<PipelineFetchResult> {
  async write(result: PipelineFetchResult, options: WriteOptions): Promise<void> {
    if (options.stdout) {
      process.stdout.write(JSON.stringify(result.pipelines, null, 2));
      return;
    }

    const dir = options.outputDir ?? process.cwd();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Write pipelines
    const pipelinesFile = join(dir, 'pipelines.json');
    writeFileSync(pipelinesFile, JSON.stringify(result.pipelines, null, 2));

    // Write metadata
    const metadataFile = join(dir, 'metadata.json');
    writeFileSync(metadataFile, JSON.stringify(result.metadata, null, 2));
  }
}
