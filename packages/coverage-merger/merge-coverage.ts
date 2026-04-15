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
 *   --types <t1,t2,...>  Coverage directory names to collect (default: "coverage")
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
  types: string[];
  skipRun: boolean;
  noView: boolean;
  htmlOnly: boolean;
  root: string;
  depth: number;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);

  let command = 'pnpm -r test --coverage';
  let outputDir = 'coverage-merged';
  let types = ['coverage'];
  let skipRun = false;
  let noView = false;
  let htmlOnly = false;
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
      case '--types':
        types = (args[++i] ?? 'coverage').split(',').map(t => t.trim()).filter(Boolean);
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
      case '--html-only':
        htmlOnly = true;
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

  return { command, outputDir, types, skipRun, noView, htmlOnly, root, depth };
}

function printHelp(): void {
  console.log(`
Usage: tsx merge-coverage.ts [options]

Options:
  --command <cmd>      Test command to run (default: "pnpm -r test --coverage")
  --output-dir <dir>   Where to write the merged report (default: ./coverage-merged)
  --types <t1,t2,...>  Coverage directory names to collect (default: "coverage")
  --skip-run           Skip running the test command; merge existing reports only
  --no-view            Skip opening the HTML report after merging
  --html-only          Only write HTML output; skip coverage-final.json and lcov.info
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

interface OtherReport {
  package: string;    // package path relative to root, e.g. "apps/web-app"
  type: string;       // coverage directory name, e.g. "e2e"
  htmlDir: string;    // absolute path to the directory containing index.html
  outputDir?: string; // absolute path where it was copied in the output
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
 * `typeName` that contain coverage-final.json (reports) or only index.html
 * (otherReports — HTML-only coverage with no JSON to merge).
 */
function findCoverageDirs(
  root: string,
  dir: string,
  typeName: string,
  maxDepth: number,
  currentDepth = 0,
): { reports: FoundReport[]; otherReports: OtherReport[] } {
  if (currentDepth > maxDepth) return { reports: [], otherReports: [] };

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { reports: [], otherReports: [] };
  }

  const reports: FoundReport[] = [];
  const otherReports: OtherReport[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    if (['node_modules', '.git', 'dist', 'build', 'out', '.turbo'].includes(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);

    if (entry.name === typeName) {
      const jsonPath = path.join(fullPath, 'coverage-final.json');
      if (fs.existsSync(jsonPath)) {
        reports.push({
          package: path.relative(root, dir) || '.',
          json: jsonPath,
        });
      } else if (fs.existsSync(path.join(fullPath, 'index.html'))) {
        otherReports.push({
          package: path.relative(root, dir) || '.',
          type: typeName,
          htmlDir: fullPath,
        });
      }
      continue;
    }

    const sub = findCoverageDirs(root, fullPath, typeName, maxDepth, currentDepth + 1);
    reports.push(...sub.reports);
    otherReports.push(...sub.otherReports);
  }

  return { reports, otherReports };
}

function printFoundReports(reports: FoundReport[], otherReports: OtherReport[], typeName: string, root: string): void {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`[${typeName}] Found ${reports.length} coverage report(s), ${otherReports.length} html-only report(s)`);
  console.log(`${'─'.repeat(60)}`);

  if (reports.length === 0 && otherReports.length === 0) {
    console.log('  (none)');
    return;
  }

  if (reports.length > 0) {
    const maxLen = Math.max(...reports.map(r => r.package.length));
    for (const r of reports) {
      console.log(`  ${r.package.padEnd(maxLen)}  →  ${path.relative(root, r.json!)}`);
    }
  }

  if (otherReports.length > 0) {
    console.log('  [other — html only, no coverage-final.json]');
    const maxLen = Math.max(...otherReports.map(r => r.package.length));
    for (const r of otherReports) {
      console.log(`  ${r.package.padEnd(maxLen)}  →  ${path.relative(root, path.join(r.htmlDir, 'index.html'))}`);
    }
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

function mergeReports(reports: FoundReport[], root: string, outputDir: string, htmlOnly = false): void {
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

  const context = createContext({
    dir: outputDir,
    coverageMap: map,
    sourceFinder: (filePath) => fs.readFileSync(path.resolve(root, filePath), 'utf-8'),
  });

  istanbulReports.create('html-spa').execute(context);

  if (!htmlOnly) {
    fs.writeFileSync(
      path.join(outputDir, 'coverage-final.json'),
      JSON.stringify(map.toJSON(), null, 2),
      'utf-8'
    );
    istanbulReports.create('lcovonly').execute(context);
  }
}

// ─── Step 4: Copy html-only reports ──────────────────────────────────────────

/**
 * Copy an HTML-only coverage report directory into the output under
 * `other/<type>/<safe-package>/` and return the destination path.
 */
function copyOtherReport(report: OtherReport, outputDir: string): string {
  const safePackage = report.package === '.' ? 'root' : report.package.replace(/[/\\]/g, '-');
  const destDir = path.join(outputDir, 'other', report.type, safePackage);
  fs.mkdirSync(destDir, { recursive: true });
  fs.cpSync(report.htmlDir, destDir, { recursive: true });
  return destDir;
}

// ─── Step 5: Generate overview index ─────────────────────────────────────────

interface TypeResult {
  type: string;
  dir: string;
  count: number;
}

function generateOverviewPage(outputDir: string, results: TypeResult[], otherReports: OtherReport[] = []): string {
  const indexPath = path.join(outputDir, 'index.html');
  const generatedAt = new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  const rows = results.map(r => {
    const relDir = r.type === 'all' ? 'all' : r.type;
    const isAll = r.type === 'all';
    return `
      <tr${isAll ? ' class="all-row"' : ''}>
        <td><a href="${relDir}/index.html">${r.type}</a></td>
        <td>${r.count} package${r.count !== 1 ? 's' : ''}</td>
        <td><a href="${relDir}/index.html">Open report →</a></td>
      </tr>`;
  }).join('');

  const otherRows = otherReports.map(r => {
    const safePackage = r.package === '.' ? 'root' : r.package.replace(/[/\\]/g, '-');
    const relHref = `other/${r.type}/${safePackage}/index.html`;
    const label = r.package === '.' ? r.type : `${r.type} — ${r.package}`;
    return `
      <tr class="other-row">
        <td>${label}</td>
        <td>—</td>
        <td><a href="${relHref}">Open report →</a></td>
      </tr>`;
  }).join('');

  const otherSection = otherReports.length > 0 ? `
    <h2 class="section-title">Other Coverage Reports</h2>
    <p class="subtitle">HTML-only reports — not included in merged coverage</p>
    <table>
      <thead>
        <tr>
          <th>Type / Package</th>
          <th></th>
          <th>Report</th>
        </tr>
      </thead>
      <tbody>
        ${otherRows}
      </tbody>
    </table>` : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Coverage Reports</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 2rem;
    }
    .card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 12px;
      padding: 2rem 2.5rem;
      min-width: 480px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.4);
    }
    h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: 0.25rem; }
    h2.section-title { font-size: 1.1rem; font-weight: 600; margin-top: 2rem; margin-bottom: 0.25rem; }
    .subtitle { color: #94a3b8; font-size: 0.875rem; margin-bottom: 2rem; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 0.5rem; }
    th {
      text-align: left;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #64748b;
      padding: 0 0.75rem 0.75rem;
    }
    td {
      padding: 0.75rem;
      border-top: 1px solid #334155;
      font-size: 0.9rem;
    }
    td:first-child { font-weight: 600; color: #f1f5f9; }
    td:nth-child(2) { color: #94a3b8; }
    a { color: #38bdf8; text-decoration: none; }
    a:hover { text-decoration: underline; }
    tr:last-child td { border-bottom: 1px solid #334155; }
    .all-row td { background: #1a2d3a; }
    .all-row td:first-child { color: #7dd3fc; }
    .other-row td { background: #1e2a1e; }
    .other-row td:first-child { color: #86efac; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Coverage Reports</h1>
    <p class="subtitle">Select a report to view &nbsp;·&nbsp; Generated ${generatedAt}</p>
    <table>
      <thead>
        <tr>
          <th>Type</th>
          <th>Packages</th>
          <th>Report</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
    ${otherSection}
  </div>
</body>
</html>`;

  fs.writeFileSync(indexPath, html, 'utf-8');
  return indexPath;
}

// ─── Step 5: Print summary + open report ─────────────────────────────────────

function openReport(htmlPath: string): void {
  console.log(`\n${'─'.repeat(60)}`);
  console.log('Report ready');
  console.log(`${'─'.repeat(60)}`);
  console.log(`  Open: ${htmlPath}`);

  const opener =
    process.platform === 'darwin' ? 'open' :
    process.platform === 'win32'  ? 'start' : 'xdg-open';

  spawnSync(`${opener} "${htmlPath}"`, { shell: true, stdio: 'inherit' });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  const opts = parseArgs();
  const multiType = opts.types.length > 1;

  console.log('Coverage Merger');
  console.log(`Root    : ${opts.root}`);
  console.log(`Output  : ${opts.outputDir}`);
  console.log(`Types   : ${opts.types.join(', ')}`);
  if (!opts.skipRun) console.log(`Command : ${opts.command}`);
  if (opts.htmlOnly) console.log(`Mode    : html-only (skipping coverage-final.json and lcov.info)`);

  // Step 1: run tests
  if (!opts.skipRun) {
    runTestCommand(opts.command, opts.root);
  } else {
    console.log('\nSkipping test run (--skip-run).');
  }

  if (fs.existsSync(opts.outputDir)) {
    fs.rmSync(opts.outputDir, { recursive: true, force: true });
    console.log(`\nRemoved old report: ${opts.outputDir}`);
  }
  fs.mkdirSync(opts.outputDir, { recursive: true });

  const typeResults: TypeResult[] = [];
  const allReports: FoundReport[] = [];
  const allOtherReports: OtherReport[] = [];

  // Step 2+3: find and merge per type
  for (const typeName of opts.types) {
    const { reports: foundReports, otherReports: foundOtherReports } =
      findCoverageDirs(opts.root, opts.root, typeName, opts.depth);
    printFoundReports(foundReports, foundOtherReports, typeName, opts.root);

    // Copy html-only reports to the output directory
    for (const other of foundOtherReports) {
      const destDir = copyOtherReport(other, opts.outputDir);
      other.outputDir = destDir;
      allOtherReports.push(other);
      console.log(`  [other] copied ${path.relative(opts.root, other.htmlDir)} → ${path.relative(opts.root, destDir)}`);
    }

    if (foundReports.length === 0) continue;

    allReports.push(...foundReports);

    const typeOutputDir = multiType ? path.join(opts.outputDir, typeName) : opts.outputDir;
    fs.mkdirSync(typeOutputDir, { recursive: true });

    console.log(`\nMerging [${typeName}] ${foundReports.length} report(s) into ${path.relative(opts.root, typeOutputDir)}/…`);
    mergeReports(foundReports, opts.root, typeOutputDir, opts.htmlOnly);

    console.log(`  html : ${path.relative(opts.root, path.join(typeOutputDir, 'index.html'))}`);
    if (!opts.htmlOnly) {
      console.log(`  lcov : ${path.relative(opts.root, path.join(typeOutputDir, 'lcov.info'))}`);
      console.log(`  json : ${path.relative(opts.root, path.join(typeOutputDir, 'coverage-final.json'))}`);
    }

    typeResults.push({ type: typeName, dir: typeOutputDir, count: foundReports.length });
  }

  if (allReports.length === 0 && allOtherReports.length === 0) {
    console.log('\nNothing to merge. Exiting.\n');
    process.exit(0);
  }

  // Step 3b: unified report + overview page (multi-type, or when other reports exist)
  const needsOverview = multiType || allOtherReports.length > 0;
  let openPath: string;

  if (multiType && allReports.length > 0) {
    const allOutputDir = path.join(opts.outputDir, 'all');
    fs.mkdirSync(allOutputDir, { recursive: true });

    console.log(`\nMerging [all] ${allReports.length} report(s) into ${path.relative(opts.root, allOutputDir)}/…`);
    mergeReports(allReports, opts.root, allOutputDir, opts.htmlOnly);
    console.log(`  html : ${path.relative(opts.root, path.join(allOutputDir, 'index.html'))}`);
    if (!opts.htmlOnly) {
      console.log(`  lcov : ${path.relative(opts.root, path.join(allOutputDir, 'lcov.info'))}`);
    }

    const uniquePackageCount = new Set(allReports.map(r => r.package)).size;
    typeResults.push({ type: 'all', dir: allOutputDir, count: uniquePackageCount });
  }

  if (needsOverview) {
    openPath = generateOverviewPage(opts.outputDir, typeResults, allOtherReports);
    console.log(`\nOverview: ${path.relative(opts.root, openPath)}`);
  } else {
    openPath = path.join(opts.outputDir, 'index.html');
  }

  // Step 4: open
  if (!opts.noView) {
    openReport(openPath);
  }
}

main();
