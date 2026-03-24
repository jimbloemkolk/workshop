/**
 * GitLab hostname detection.
 * 
 * Determines the GitLab instance hostname from environment or glab config.
 * Used by composition layers to create the cache namespace that prevents
 * data mixing between different GitLab instances.
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execPromise = promisify(exec);

/**
 * Get the GitLab hostname for the current environment.
 * 
 * Resolution order:
 * 1. `GITLAB_HOST` environment variable (if set)
 * 2. `glab config get host` (glab CLI configuration)
 * 3. Falls back to 'gitlab.com'
 */
export async function getGitlabHostname(): Promise<string> {
  // 1. Environment variable
  const envHost = process.env.GITLAB_HOST;
  if (envHost) return envHost;

  // 2. glab config
  try {
    const { stdout } = await execPromise('glab config get host');
    const host = stdout.trim();
    if (host && host !== '') return host;
  } catch {
    // glab not configured or not installed
  }

  // 3. Default
  return 'gitlab.com';
}
