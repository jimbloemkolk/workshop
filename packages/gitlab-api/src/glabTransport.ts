/**
 * glab CLI transport implementation.
 * 
 * All API calls shell out to the `glab` CLI tool, which handles
 * authentication and GitLab instance configuration.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import type { Transport } from './transport.js';

const execPromise = promisify(exec);

// Job logs can be very large (50MB+), so we need a large maxBuffer
const LARGE_BUFFER = 100 * 1024 * 1024; // 100MB

export class GlabTransport implements Transport {
  async restGet(path: string): Promise<string> {
    const { stdout } = await execPromise(`glab api ${path}`, { maxBuffer: LARGE_BUFFER });
    return stdout;
  }

  async restGetPaginated(path: string): Promise<string> {
    const { stdout } = await execPromise(`glab api --paginate ${path}`, { maxBuffer: LARGE_BUFFER });

    // --paginate returns JSON arrays concatenated like: [...][...][...]
    // We need to merge them into a single array
    if (!stdout.includes('][')) {
      return stdout;
    }

    const parts = stdout.split('][');
    const arrays: any[][] = parts.map((part: string, idx: number) => {
      let json: string;
      if (idx === 0) json = part + ']';
      else if (idx === parts.length - 1) json = '[' + part;
      else json = '[' + part + ']';
      return JSON.parse(json);
    });

    const merged = arrays.flat();
    return JSON.stringify(merged);
  }

  async graphql(query: string): Promise<string> {
    const escapedQuery = query.replace(/'/g, "'\\''");
    const { stdout } = await execPromise(`glab api graphql -f query='${escapedQuery}'`, { maxBuffer: LARGE_BUFFER });
    return stdout;
  }
}
