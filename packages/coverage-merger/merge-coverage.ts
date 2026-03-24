#!/usr/bin/env node

/**
 * Coverage merger — runs a test command across a monorepo, gathers all
 * coverage-final.json reports, rewrites paths to be monorepo-root-relative,
 * merges them via istanbul-lib-coverage, and generates an HTML report.
 * Optionally also writes lcov.info.
 *
 * Usage:
 *   tsx packages/coverage-merger/merge-coverage.ts [options]
 *
 * Options:
 *   --command <cmd>      Test command to run (default: "pnpm -r test --coverage")
 *   --output-dir <dir>   Where to write the merged report (default: ./coverage-merged)
 *   --skip-run           Skip running the test command; merge existing reports only
 *   --no-view            Skip opening the HTML report after merging
 *   --root <dir>         Monorepo root to scan (default: cwd / INIT_CWD)
 *   --depth <n>          Max directory depth to search for coverage dirs (default: 5)
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createCoverageMap } = require('istanbul-lib-coverage') as typeof import('istanbul-lib-coverage');
const { createContext } = require('istanbul-lib-report') as typeof import('istanbul-lib-report');
const istanbulReports = require('istanbul-reports') as typeof import('istanbul-reports');

// ─── CLI Argument Parsing ────────────────────────────────────────────────────

interface CliOptions {
  command: string;
  outputDir: string;
  skipRun: boolean;
  noView: boolean;
  root: string;
  depth: number;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);

  let command = 'pnpm -r test --coverage';
  let outputDir = 'coverage-merged';
  let skipRun = false;
  let noView = false;
  let root = process.env.INIT_CWD ?? process.cwd();
  let depth = 5;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--command':
        command = args[++i] ?? command;
        break;
      case '--output-dir':
        outputDir = args[++i] ?? outputDir;
        break;
      case '--root':
        root = path.resolve(args[++i] ?? root);
        break;
      case '--depth':
        depth = parseInt(args[++i] ?? String(depth), 10);
        break;
      case '--skip-run':
        skipRun = true;
        break;
      case '--no-view':
      case '--noview':
        noView = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
    }
  }

  if (!path.isAbsolute(outputDir)) {
    outputDir = path.resolve(root, outputDir);
  }

  return { command, outputDir, skipRun, noView, root, depth };
}

function printHelp(): void {
  console.log(`
Usage: tsx merge-coverage.ts [options]

Options:
  --command <cmd>      Test command to run (default: "pnpm -r test --coverage")
  --output-dir <dir>   Where to write the merged report (default: ./coverage-merged)
  --skip-run           Skip running the test command; merge existing reports only
  --no-view            Skip opening the HTML report after merging
  --root <dir>         Monorepo root to scan (default: cwd / INIT_CWD)
  --depth <n>          Max depth to search for coverage dirs (default: 5)
  -h, --help           Show this help
`.trim());
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface FoundReport {
  package: string;  // package path relative to root, e.g. "apps/web-app"
  json?: string;    // absolute path to coverage-final.json
}

// ─── Step 1: Run the test command ────────────────────────────────────────────

function runTestCommand(command: string, root: string): void {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Running: ${command}`);
  console.log(`${'─'.repeat(60)}\n`);

  const result = spawnSync(command, { cwd: root, stdio: 'inherit', shell: true });

  if (result.error) {
    console.error(`\nFailed to start command: ${result.error.message}`);
  } else if (result.status !== 0) {
    console.warn(`\nCommand exited with status ${result.status} — continuing to merge available reports.`);
  }
}

// ─── Step 2: Find coverage reports ───────────────────────────────────────────

/**
 * Recursively walk `dir` up to `maxDepth`, collecting directories named
 * "coverage" that contain coverage-final.json.
 */
function findCoverageDirs(root: string, dir: string, maxDepth: number, currentDepth = 0): FoundReport[] {
  if (currentDepth > maxDepth) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: FoundReport[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    if (['node_modules', '.git', 'dist', 'build', 'out', '.turbo'].includes(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);

    if (entry.name === 'coverage') {
      const jsonPath = path.join(fullPath, 'coverage-final.json');
      if (fs.existsSync(jsonPath)) {
        results.push({
          package: path.relative(root, dir) || '.',
          json: jsonPath,
        });
      }
      continue;
    }

    results.push(...findCoverageDirs(root, fullPath, maxDepth, currentDepth + 1));
  }

  return results;
}

function printFoundReports(reports: FoundReport[], root: string): void {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Found ${reports.length} coverage report(s)`);
  console.log(`${'─'.repeat(60)}`);

  if (reports.length === 0) {
    console.log('  (none)');
    return;
  }

  const maxLen = Math.max(...reports.map(r => r.package.length));
  for (const r of reports) {
    console.log(`  ${r.package.padEnd(maxLen)}  →  ${path.relative(root, r.json!)}`);
  }
}

// ─── Step 3: Rewrite paths + merge ───────────────────────────────────────────

/**
 * Istanbul coverage-final.json: keys are file paths, each value has a `path`
 * field with the same path. Rewrite both to be relative to the monorepo root.
 */
function rewritePaths(data: Record<string, any>, root: string): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [filePath, fileCoverage] of Object.entries(data)) {
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath);
    const rel = path.relative(root, abs);
    result[rel] = { ...fileCoverage as object, path: rel };
  }
  return result;
}

function mergeReports(reports: FoundReport[], root: string, outputDir: string): void {
  const map = createCoverageMap({});

  for (const r of reports) {
    const raw = fs.readFileSync(r.json!, 'utf-8');
    let data: Record<string, any>;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      console.warn(`  Warning: could not parse ${r.json}: ${e}`);
      continue;
    }

    const rewritten = rewritePaths(data, root);
    map.merge(rewritten);
  }

  // Write merged coverage-final.json
  fs.writeFileSync(
    path.join(outputDir, 'coverage-final.json'),
    JSON.stringify(map.toJSON(), null, 2),
    'utf-8'
  );

  // Generate HTML report (primary output) and lcov (secondary)
  const context = createContext({
    dir: outputDir,
    coverageMap: map,
    sourceFinder: (filePath) => fs.readFileSync(path.resolve(root, filePath), 'utf-8'),
  });
  istanbulReports.create('html-spa').execute(context);
  istanbulReports.create('lcovonly').execute(context);
}

// ─── Step 4: Print summary + open report ─────────────────────────────────────

function openReport(outputDir: string): void {
  const indexPath = path.join(outputDir, 'index.html');

  console.log(`\n${'─'.repeat(60)}`);
  console.log('Report ready');
  console.log(`${'─'.repeat(60)}`);
  console.log(`  Open: ${indexPath}`);

  const opener =
    process.platform === 'darwin' ? 'open' :
    process.platform === 'win32'  ? 'start' : 'xdg-open';

  spawnSync(`${opener} "${indexPath}"`, { shell: true, stdio: 'inherit' });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  const opts = parseArgs();

  console.log('Coverage Merger');
  console.log(`Root    : ${opts.root}`);
  console.log(`Output  : ${opts.outputDir}`);
  if (!opts.skipRun) console.log(`Command : ${opts.command}`);

  // Step 1: run tests
  if (!opts.skipRun) {
    runTestCommand(opts.command, opts.root);
  } else {
    console.log('\nSkipping test run (--skip-run).');
  }

  // Step 2: find reports
  const foundReports = findCoverageDirs(opts.root, opts.root, opts.depth);
  printFoundReports(foundReports, opts.root);

  if (foundReports.length === 0) {
    console.log('\nNothing to merge. Exiting.\n');
    process.exit(0);
  }

  // Step 3: merge + generate reports
  fs.mkdirSync(opts.outputDir, { recursive: true });
  console.log(`\nMerging ${foundReports.length} report(s) into ${path.relative(opts.root, opts.outputDir)}/…`);
  mergeReports(foundReports, opts.root, opts.outputDir);

  const lcovPath = path.join(opts.outputDir, 'lcov.info');
  const lcovRel = path.relative(opts.root, lcovPath);
  const htmlRel = path.relative(opts.root, path.join(opts.outputDir, 'index.html'));
  console.log(`  html   : ${htmlRel}`);
  console.log(`  lcov   : ${lcovRel}`);
  console.log(`  json   : ${path.relative(opts.root, path.join(opts.outputDir, 'coverage-final.json'))}`);

  // Step 4: open
  if (!opts.noView) {
    openReport(opts.outputDir);
  }
}

main();
