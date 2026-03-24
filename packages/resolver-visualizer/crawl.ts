import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import ts from 'typescript';
import resolve from 'resolve';
import { findUpSync } from 'find-up-simple';
import { minimatch } from 'minimatch';

// Promisified version of resolve
const resolveAsync = (request: string, opts: any): Promise<string> => {
    return new Promise((res, rej) => {
        (resolve as any)(request, opts, (err: any, result: any) => {
            if (err) rej(err);
            else res(result);
        });
    });
};

const args = process.argv.slice(2);
const MISMATCHES_ONLY = args.includes('--mismatches-only');
const VERBOSE = args.includes('--verbose');
const PRESERVE_SYMLINKS = !args.includes('--real-paths');

// Resolve mode: runtime | typecheck | both (default: both)
let RESOLVE_MODE: 'runtime' | 'typecheck' | 'both' = 'both';
const resolveArg = args.find(a => a.startsWith('--resolve='));
if (resolveArg) {
    const val = resolveArg.split('=')[1];
    if (val === 'runtime' || val === 'typecheck' || val === 'both') {
        RESOLVE_MODE = val;
    } else {
        console.warn(`Unknown --resolve value: ${val}. Falling back to 'both'.`);
    }
}
if (args.includes('--runtime-only')) RESOLVE_MODE = 'runtime';
if (args.includes('--typecheck-only')) RESOLVE_MODE = 'typecheck';

const filteredArgs = args.filter(arg => arg !== '--mismatches-only' && arg !== '--verbose' && arg !== '--real-paths' && !arg.startsWith('--resolve=') && arg !== '--runtime-only' && arg !== '--typecheck-only');
const ENTRY_FILE = filteredArgs[0];
const FILTER_PATTERN = filteredArgs[1];

if (!ENTRY_FILE) {
    console.error('Error: Please provide an entry file.');
    console.error('Usage: tsx crawl.ts <entry-file> [filter-pattern] [--mismatches-only]');
    console.error('  --mismatches-only: Only show mismatched packages and their paths');
    process.exit(1);
}

const invocationDir = process.env.INIT_CWD || process.cwd();
const absEntryFile = path.resolve(invocationDir, ENTRY_FILE);
const entryDir = path.dirname(absEntryFile);
const projectRoot = invocationDir;

const startTime = performance.now();
let lastCheckpoint = startTime;

function logTiming(label: string) {
    const now = performance.now();
    const elapsed = (now - lastCheckpoint).toFixed(2);
    const total = (now - startTime).toFixed(2);
    console.log(`   ⏱️  ${label}: ${elapsed}ms (total: ${total}ms)`);
    lastCheckpoint = now;
}

function verboseLog(...msgs: any[]) {
    if (!VERBOSE) return;
    console.log(...msgs);
}

console.log('🔍 Scanning for configuration...');
console.log(`   Entry File:   ${path.relative(projectRoot, absEntryFile)}`);
if (FILTER_PATTERN) {
    console.log(`   Filter:       ${FILTER_PATTERN}`);
}
if (MISMATCHES_ONLY) {
    console.log(`   Mode:         Mismatches Only`);
}

function findOwningConfig(initialSearchDir: string, targetFile: string): string | null {
    // 1. Find the nearest tsconfig.json (Root Config)
    const rootConfigPath = ts.findConfigFile(initialSearchDir, ts.sys.fileExists, "tsconfig.json");
    if (!rootConfigPath) return null;

    console.log(`   found root:   ${path.relative(projectRoot, rootConfigPath)}`);

    // 2. Parse the root config to see if it's a "Solution" (has references)
    const rootConfigFile = ts.readConfigFile(rootConfigPath, ts.sys.readFile);
    const parsedRoot = ts.parseJsonConfigFileContent(
        rootConfigFile.config,
        ts.sys,
        path.dirname(rootConfigPath)
    );

    // If no references, this is a standard project. Return it.
    if (!parsedRoot.projectReferences || parsedRoot.projectReferences.length === 0) {
        return rootConfigPath;
    }

    console.log(`   🗂️  Root has ${parsedRoot.projectReferences.length} references. Searching for owner...`);

    // 3. Iterate References to find the "Real" owner
    // This mimics how tsserver identifies which project a file belongs to.
    for (const ref of parsedRoot.projectReferences) {
        const refConfigPath = ts.resolveProjectReferencePath(ref);
        if (!refConfigPath) continue;

        // Parse the sub-project
        const refConfigFile = ts.readConfigFile(refConfigPath, ts.sys.readFile);
        if (refConfigFile.error) continue;

        const parsedRef = ts.parseJsonConfigFileContent(
            refConfigFile.config,
            ts.sys,
            path.dirname(refConfigPath)
        );

        // 4. Check if our file is in this project's scope
        // We check the specific file list derived from 'include'/'exclude'/'files'
        // This handles globs correctly.
        const fileInProject = parsedRef.fileNames.some((f) => {
            return path.normalize(f) === path.normalize(targetFile);
        });

        if (fileInProject) {
            console.log(`   🎯 Match found! Owned by: ${path.relative(projectRoot, refConfigPath)}`);
            return refConfigPath;
        }
    }

    // Fallback: If no sub-project claims it, return the root (or null)
    console.warn(`   ⚠️  No reference matched. Falling back to root config.`);
    return rootConfigPath;
}

const configPath = findOwningConfig(entryDir, absEntryFile);
logTiming('Config search');

if (!configPath) {
    console.error("❌ Could not find valid tsconfig.json");
    process.exit(1);
}

// --- 2. TYPESCRIPT RESOLUTION SETUP ---

console.log(`\n⚙️  Setting up TypeScript resolution`);
console.log(`   Active Config: ${path.relative(process.cwd(), configPath)}`);

const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath)
);

// Force strict options for pnpm analysis
parsedConfig.options.preserveSymlinks = PRESERVE_SYMLINKS;
// Performance optimizations
parsedConfig.options.skipLibCheck = true;
parsedConfig.options.skipDefaultLibCheck = true;

// LOGGING COMPILER OPTIONS
console.log('   [Compiler Options]');
console.log(`    - baseUrl:          ${parsedConfig.options.baseUrl || '(not set)'}`);
console.log(`    - paths:            ${parsedConfig.options.paths ? Object.keys(parsedConfig.options.paths).length + ' aliases' : '(none)'}`);
console.log(`    - moduleResolution: ${ts.ModuleResolutionKind[parsedConfig.options.moduleResolution || 0]}`);
console.log(`    - preserveSymlinks: ${parsedConfig.options.preserveSymlinks}`);

console.log('   ✅ Ready.');
logTiming('TypeScript setup');
console.log();

// Create a simple module resolution host
const moduleResolutionHost: ts.ModuleResolutionHost = {
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    directoryExists: ts.sys.directoryExists,
    getCurrentDirectory: () => process.cwd(),
    getDirectories: ts.sys.getDirectories,
    realpath: PRESERVE_SYMLINKS ? undefined : ts.sys.realpath,
};

// --- 3. HELPER: VITE ROOT RESOLVER ---
function resolveViteRoot(request: string): string | undefined {
    if (!request.startsWith('/')) return undefined;
    const rootPath = path.join(process.cwd(), request);
    if (fs.existsSync(rootPath)) return rootPath;

    const publicPath = path.join(process.cwd(), 'public', request);
    if (fs.existsSync(publicPath)) return publicPath;

    return undefined;
}

// --- 4. HELPER: PACKAGE.JSON FINDER ---
interface PackageInfo {
    name: string;
    version: string;
    packageJsonPath: string;
}

function findPackageJson(filePath: string): PackageInfo | undefined {
    const pkgPath = findUpSync('package.json', { cwd: path.dirname(filePath) });
    
    if (pkgPath) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            if (pkg.name && pkg.version) {
                return {
                    name: pkg.name,
                    version: pkg.version,
                    packageJsonPath: pkgPath
                };
            }
        } catch (e) {
            // Invalid JSON
        }
    }
    
    return undefined;
}


// --- 4. THE CRAWLER (BREADTH-FIRST WITH BATCHED FILE LOADING) ---
const VISITED = new Set<string>();
const VISITED_DISPLAY_PATHS = new Map<string, string>(); // realPath -> displayPath
const EDGES: any[] = [];

// Collect package versions seen across runtime/types resolutions
const packageVersions: Map<string, Set<string>> = new Map();

function recordPackage(pkg?: PackageInfo) {
    if (!pkg || !pkg.name) return;
    let s = packageVersions.get(pkg.name);
    if (!s) {
        s = new Set();
        packageVersions.set(pkg.name, s);
    }
    if (pkg.version) s.add(pkg.version);
}

// Performance tracking
let fileCount = 0;
let resolveCount = 0;
let tsResolveTime = 0;
let jsResolveTime = 0;

async function crawl(filePath: string, depth = 0, prefix = ''): Promise<any[]> {
    const absPath = path.resolve(filePath);
    if (!fs.existsSync(absPath)) return [];
    
    const realPath = fs.realpathSync(absPath);
    if (VISITED.has(realPath)) {
        const displayPath = VISITED_DISPLAY_PATHS.get(realPath) || realPath;
        return [{ alreadyVisited: true, path: displayPath }];
    }
    VISITED.add(realPath);
    VISITED_DISPLAY_PATHS.set(realPath, absPath);

    if (depth === 0) {
        console.log(`🚀 Starting trace from: ${path.relative(process.cwd(), absPath)}\n`);
    }

    fileCount++;

    const content = fs.readFileSync(realPath, 'utf-8');
    const info = ts.preProcessFile(content, true, true);
    
    const allImports = [
        ...info.importedFiles.map(i => ({ text: i.fileName, kind: 'import' })),
        ...info.typeReferenceDirectives.map(i => ({ text: i.fileName, kind: 'ref-type' })),
        ...info.referencedFiles.map(i => ({ text: i.fileName, kind: 'ref-path' }))
    ];

    const baseDir = path.dirname(realPath);
    const children: any[] = [];

    // Resolve all imports in parallel
    const resolvePromises = allImports.map(async (req) => {
        const importStart = performance.now();
        
        // B. RESOLVE USING NODE (Runtime check)
        let runtimePath: string | undefined;
        let isViteAsset = false;

        if (RESOLVE_MODE !== 'typecheck') {
            if (req.kind === 'import' && req.text.startsWith('/')) {
                const viteRes = resolveViteRoot(req.text);
                if (viteRes) {
                    runtimePath = viteRes;
                    isViteAsset = true;
                }
            }

            if (!runtimePath && req.kind === 'import') {
                // Skip trying to resolve Node.js core modules with the file resolver
                if (!resolve.isCore(req.text)) {
                    try {
                        const jsStart = performance.now();
                        runtimePath = await resolveAsync(req.text, {
                            basedir: baseDir,
                            extensions: ['.js', '.ts', '.tsx', '.json', '.svg', '.css', '.mjs'],
                            preserveSymlinks: PRESERVE_SYMLINKS
                        });
                        jsResolveTime += performance.now() - jsStart;
                    } catch (e) {}
                } else {
                    // For Node.js core modules, mark as resolved without a path
                    runtimePath = req.text;
                }
            }
        }

        // C. RESOLVE USING ts.resolveModuleName (STATELESS)
        let typesPath: string | undefined;
        
        if (RESOLVE_MODE !== 'runtime') {
            const tsStart = performance.now();
            
            if (req.kind === 'ref-path') {
                // Handle /// <reference path="..." /> directives
                // These are relative to the containing file
                const resolved = path.resolve(baseDir, req.text);
                if (fs.existsSync(resolved)) {
                    typesPath = resolved;
                } else if (fs.existsSync(resolved + '.ts')) {
                    typesPath = resolved + '.ts';
                } else if (fs.existsSync(resolved + '.d.ts')) {
                    typesPath = resolved + '.d.ts';
                }
            } else if (req.kind === 'ref-type') {
                // Handle /// <reference types="..." /> directives
                const result = ts.resolveTypeReferenceDirective(
                    req.text,
                    realPath,
                    parsedConfig.options,
                    moduleResolutionHost
                );
                if (result.resolvedTypeReferenceDirective?.resolvedFileName) {
                    typesPath = result.resolvedTypeReferenceDirective.resolvedFileName;
                }
            } else {
                // Handle regular imports using ts.resolveModuleName
                const result = ts.resolveModuleName(
                    req.text,
                    realPath,
                    parsedConfig.options,
                    moduleResolutionHost
                );
                
                if (result.resolvedModule?.resolvedFileName) {
                    typesPath = result.resolvedModule.resolvedFileName;
                } else if (resolve.isCore(req.text)) {
                    // For Node.js core modules, try to resolve @types/node
                    const nodeTypesResult = ts.resolveModuleName(
                        `@types/node`,
                        realPath,
                        parsedConfig.options,
                        moduleResolutionHost
                    );
                    if (nodeTypesResult.resolvedModule?.resolvedFileName) {
                        // Found @types/node, construct path to the specific module
                        const nodeTypesDir = path.dirname(nodeTypesResult.resolvedModule.resolvedFileName);
                        const modulePath = path.join(nodeTypesDir, `${req.text}.d.ts`);
                        if (fs.existsSync(modulePath)) {
                            typesPath = modulePath;
                        } else {
                            // Try index.d.ts in a directory
                            const moduleDirPath = path.join(nodeTypesDir, req.text, 'index.d.ts');
                            if (fs.existsSync(moduleDirPath)) {
                                typesPath = moduleDirPath;
                            }
                        }
                    }
                }
            }
            
            tsResolveTime += performance.now() - tsStart;
        }
        
        resolveCount++;

        // D. FALLBACKS
        if (!typesPath && isViteAsset) {
            typesPath = runtimePath;
        }

        // E. FIND PACKAGE INFO
        // For Node.js core modules, use a special package marker instead of looking up package.json
        let runtimePkg: PackageInfo | undefined;
        let typesPkg: PackageInfo | undefined;
        
        if (resolve.isCore(req.text)) {
            // Node.js core module
            const nodePackage: PackageInfo = {
                name: 'node',
                version: '',
                packageJsonPath: ''
            };
            if (runtimePath) runtimePkg = nodePackage;
        } else {
            runtimePkg = runtimePath ? findPackageJson(runtimePath) : undefined;
        }
        typesPkg = typesPath ? findPackageJson(typesPath) : undefined

        // F. IMPROVED MISMATCH DETECTION
        let isMismatch: boolean | 'unknown' = false;
        // Only consider mismatches when both resolutions were requested/performed
        const performedRuntime = RESOLVE_MODE !== 'typecheck';
        const performedTypes = RESOLVE_MODE !== 'runtime';

        if (performedRuntime && performedTypes && runtimePath && typesPath && runtimePath !== typesPath) {
            // If both are from packages, compare package names
            if (runtimePkg && typesPkg) {
                // Check if types package corresponds to runtime package
                // e.g., @types/react should match react
                const typesPackageBase = typesPkg.name.replace(/^@types\//, '');
                const runtimePackageBase = runtimePkg.name.replace(/^@/, '').replace(/\//, '__');
                
                // They match if:
                // 1. Same package name (both have types)
                // 2. Types package is @types/{runtime-package}
                const isSamePackage = typesPkg.name === runtimePkg.name || 
                                     typesPackageBase === runtimePkg.name;
                
                if (!isSamePackage) {
                    // Different packages entirely
                    isMismatch = true;
                } else if (isSamePackage) {
                    // Same package, check version compatibility
                    // Allow patch version differences (e.g., 19.2.3 vs 19.2.7 is OK)
                    const parseVersion = (v: string) => {
                        const match = v.match(/^(\d+)\.(\d+)\.(\d+)/);
                        if (!match) return null;
                        return { major: parseInt(match[1]), minor: parseInt(match[2]), patch: parseInt(match[3]) };
                    };
                    
                    const runtimeVer = parseVersion(runtimePkg.version);
                    const typesVer = parseVersion(typesPkg.version);
                    
                    if (runtimeVer && typesVer) {
                        // Mismatch if major or minor versions differ
                        if (runtimeVer.major !== typesVer.major || runtimeVer.minor !== typesVer.minor) {
                            isMismatch = true;
                        }
                        // Patch version differences are OK
                    }
                }
            } else {
                isMismatch = 'unknown';
            }
        }

        const edge = {
            source: realPath,
            request: req.text,
            kind: req.kind,
            runtimePath,
            typesPath,
            isMismatch,
            runtimePkg,
            typesPkg
        };
        
        // Record discovered packages and versions
        recordPackage(runtimePkg);
        recordPackage(typesPkg);

        EDGES.push(edge);

        // Choose next path based on mode preference:
        // - typecheck: prefer typesPath
        // - runtime: prefer runtimePath
        // - both: prefer typesPath then runtimePath
        let next: string | null = null;
        if (RESOLVE_MODE === 'typecheck') next = typesPath || null;
        else if (RESOLVE_MODE === 'runtime') next = runtimePath || null;
        else next = typesPath || runtimePath || null;
        
        return {
            edge,
            nextPath: next && !resolve.isCore(req.text) ? next : null,
            children: [] // Will be populated in BFS phase
        };
    });
    
    // Wait for all resolutions to complete in parallel
    const resolvedChildren = await Promise.all(resolvePromises);
    children.push(...resolvedChildren);
    
    return children;
}

// Breadth-first crawl
async function breadthFirstCrawl(entryFile: string): Promise<any[]> {
    // Crawl the entry file (resolve its imports)
    const tree = await crawl(entryFile, 0);
    
    // BFS: Process each level
    let currentLevel = [{ node: tree, depth: 0 }];
    let levelNum = 1;
    
    while (currentLevel.length > 0) {
        const nextLevel: Array<{ node: any, depth: number }> = [];
        
        // Process all nodes at current level in parallel
        const crawlPromises = currentLevel.flatMap(({ node, depth }) => {
            if (!Array.isArray(node)) return [];
            
            return node.map(async (child) => {
                if (child.nextPath && !VISITED.has(fs.realpathSync(child.nextPath))) {
                    // Crawl this file
                    child.children = await crawl(child.nextPath, depth + 1);
                    nextLevel.push({ node: child.children, depth: depth + 1 });
                } else if (child.nextPath && VISITED.has(fs.realpathSync(child.nextPath))) {
                    // Already visited
                    const realPath = fs.realpathSync(child.nextPath);
                    const displayPath = VISITED_DISPLAY_PATHS.get(realPath) || realPath;
                    child.children = [{ alreadyVisited: true, path: displayPath }];
                }
            });
        });
        
        await Promise.all(crawlPromises);
        
        currentLevel = nextLevel;
        levelNum++;
    }
    
    return tree;
}

const tree = await breadthFirstCrawl(absEntryFile);
logTiming('Crawling complete');

console.log('\n📊 Performance Summary:');
console.log(`   Files analyzed:     ${fileCount}`);
console.log(`   Imports resolved:   ${resolveCount}`);
console.log(`   TS resolution:      ${tsResolveTime.toFixed(0)}ms`);
console.log(`   JS resolution:      ${jsResolveTime.toFixed(0)}ms`);
console.log(`   Avg per file:       ${fileCount > 0 ? ((tsResolveTime + jsResolveTime) / fileCount).toFixed(1) : 0}ms`);
console.log(`   Avg per import:     ${resolveCount > 0 ? ((tsResolveTime + jsResolveTime) / resolveCount).toFixed(1) : 0}ms`);
console.log();

if (VERBOSE) {
    console.log('\n--- VERBOSE EDGES DUMP ---');
    for (const e of EDGES) {
        if (!e.typesPath || !e.runtimePath) {
            console.log(JSON.stringify({ request: e.request, kind: e.kind, runtimePath: e.runtimePath, typesPath: e.typesPath, runtimePkg: e.runtimePkg ? `${e.runtimePkg.name}@${e.runtimePkg.version}` : undefined, typesPkg: e.typesPkg ? `${e.typesPkg.name}@${e.typesPkg.version}` : undefined }, null, 2));
        }
    }
    console.log('--- END EDGES DUMP ---\n');
}

// --- REPORT ---
function matchesFilter(request: string, runtimePkg?: PackageInfo, typesPkg?: PackageInfo): boolean {
    if (!FILTER_PATTERN) return true;
    
    // Normalize the request for matching: remove leading ./ and /
    const normalizedRequest = request.replace(/^\.\//, '').replace(/^\//, '');
    if (minimatch(normalizedRequest, FILTER_PATTERN, { nocase: true })) return true;
    
    // Also try matching against package@version strings
    if (runtimePkg) {
        const runtimeStr = `${runtimePkg.name}@${runtimePkg.version}`;
        if (minimatch(runtimeStr, FILTER_PATTERN, { nocase: true })) return true;
    }
    
    if (typesPkg) {
        const typesStr = `${typesPkg.name}@${typesPkg.version}`;
        if (minimatch(typesStr, FILTER_PATTERN, { nocase: true })) return true;
                                    }
    
    return false;
                                }

// Check if this node or any of its descendants have mismatches
function hasMismatchInTree(node: any): boolean {
    const edge = node.edge;
    if (edge && edge.isMismatch === true) return true;
    
    if (node.children && node.children.length > 0) {
        for (const child of node.children) {
            if (!child.alreadyVisited && hasMismatchInTree(child)) {
                return true;
            }
        }
    }
    
    return false;
}

// Check if this node or any of its descendants match the filter
function hasMatchingDescendant(node: any): boolean {
    if (!FILTER_PATTERN) return true;
    
    const edge = node.edge;
    if (edge && matchesFilter(edge.request, edge.runtimePkg, edge.typesPkg)) return true;
    
    if (node.children && node.children.length > 0) {
        for (const child of node.children) {
            if (!child.alreadyVisited && hasMatchingDescendant(child)) {
                return true;
            }
        }
    }
    
    return false;
}

function printTree(node: any, depth = 0, isLast = true, prefix = '', ancestorMissing = false) {
    const edge = node.edge;
    if (!edge) return;
    
    // Check if this node or its descendants match
    let shouldShow = true;
    
    // Apply mismatch-only filter first
    if (MISMATCHES_ONLY) {
        shouldShow = edge.isMismatch === true || hasMismatchInTree(node);
    }
    
    // Then apply pattern filter if specified
    if (shouldShow && FILTER_PATTERN) {
        shouldShow = matchesFilter(edge.request, edge.runtimePkg, edge.typesPkg) || hasMatchingDescendant(node);
    }
    
    if (!shouldShow) return;
    
    const connector = depth === 0 ? '' : (isLast ? '└─ ' : '├─ ');
    const childPrefix = depth === 0 ? '' : (isLast ? '   ' : '│  ');
    
    // Check if this edge points to an already-visited file
    const hasRevisit = node.children && node.children.length === 1 && node.children[0].alreadyVisited;
    
    const performedRuntime = RESOLVE_MODE !== 'typecheck';
    const performedTypes = RESOLVE_MODE !== 'runtime';

    let status = '✅';
    const assetExt = (edge.request || '').toLowerCase().match(/\.(css|svg|png|jpg|jpeg|gif|webp|avif|ico)$/);
    
    // Check if the source file is a type-only file (e.g., .d.ts)
    const sourceIsTypeOnly = edge.source && edge.source.endsWith('.d.ts');

    if (edge.isMismatch === true) {
        status = '⚠️';
    } else if (edge.isMismatch === 'unknown') {
        status = '?';
    } else if (performedRuntime && performedTypes) {
        // both mode: check based on source file type
        if (sourceIsTypeOnly) {
            // Source is .d.ts (type-only file)
            // Only error if types can't be resolved
            if (!edge.typesPath) status = '❌';
            // Don't care about runtime path for .d.ts imports
        } else {
            // Source is actual code (.ts, .tsx, .js, etc.)
            // Error if can't resolve runtime (when applicable)
            if (!edge.runtimePath && edge.kind === 'import' && !assetExt) status = '❌';
            // Warning if runtime resolved but types missing
            else if (edge.runtimePath && !edge.typesPath && edge.kind === 'import' && !assetExt) status = '⚠️';
        }
    } else if (performedRuntime) {
        // runtime-only: error if runtime not resolved (only for actual code files)
        if (!sourceIsTypeOnly && !edge.runtimePath && edge.kind === 'import' && !assetExt) status = '❌';
    } else if (performedTypes) {
        // typecheck-only: error if types not resolved
        // But don't treat static assets (css, images, etc.) as missing types
        if (!edge.typesPath) {
            if (!assetExt) {
                status = '❌';
            } else {
                // leave as ✅ for assets
            }
        }
    }
    // If this is an asset and we attempted type resolution but skipped it (no typesPath),
    // print the asset inline with a muted icon and skip the child marker line. Example:
    // └─ ▫️ "./App.css"
    if (performedTypes && !edge.typesPath && assetExt) {
        console.log(`${prefix}${connector}▫️ "${edge.request}"`);
        return;
    }

    // Compact printing: if only one of TS/JS is present and there are no warnings/mismatches/revisits,
    // print on a single line: `✅ "react" path (pkg@ver)`
    const onlyTypes = (RESOLVE_MODE !== 'runtime') && !!edge.typesPath && !(RESOLVE_MODE !== 'typecheck' && edge.runtimePath);
    const onlyRuntime = (RESOLVE_MODE !== 'typecheck') && !!edge.runtimePath && !(RESOLVE_MODE !== 'runtime' && edge.typesPath);
    const hasNotes = edge.isMismatch === true || (performedTypes && performedRuntime && edge.runtimePath && edge.kind === 'import' && !edge.typesPath && !assetExt);

    if ((onlyTypes || onlyRuntime) && !hasNotes) {
        const singlePath = onlyTypes ? edge.typesPath : edge.runtimePath;
        const pkg = onlyTypes ? (edge.typesPkg ? ` (${edge.typesPkg.name}@${edge.typesPkg.version})` : '') : (edge.runtimePkg ? ` (${edge.runtimePkg.name}@${edge.runtimePkg.version})` : '');
        const revisitMarker = hasRevisit ? ' 🔄' : '';
        console.log(`${prefix}${connector}${status} "${edge.request}" ${singlePath ? path.relative(process.cwd(), singlePath) : ''}${pkg}${revisitMarker}`);
    } else {
        console.log(`${prefix}${connector}${status} "${edge.request}"`);

        if (RESOLVE_MODE !== 'runtime' && edge.typesPath) {
            const pkgInfo = edge.typesPkg ? ` (${edge.typesPkg.name}@${edge.typesPkg.version})` : '';
            const revisitMarker = hasRevisit ? ' 🔄' : '';
            console.log(`${prefix}${childPrefix}   TS: ${path.relative(process.cwd(), edge.typesPath)}${pkgInfo}${revisitMarker}`);
        }
        if (RESOLVE_MODE !== 'typecheck' && edge.runtimePath) {
            const pkgInfo = edge.runtimePkg ? ` (${edge.runtimePkg.name}@${edge.runtimePkg.version})` : '';
            console.log(`${prefix}${childPrefix}   JS: ${path.relative(process.cwd(), edge.runtimePath)}${pkgInfo}`);
        }
        // If we didn't resolve types (typecheck was performed) but the import is an asset,
        // show a muted/grey indicator to signal it was intentionally skipped.
        if (RESOLVE_MODE !== 'runtime' && !edge.typesPath && assetExt) {
            console.log(`${prefix}${childPrefix}   ▫️  (skipped type resolution for asset)`);
        }
    }
    // If we attempted type resolution but types are missing, warn about missing types
    const missingTypesHere = performedTypes && performedRuntime && edge.runtimePath && edge.kind === 'import' && !edge.typesPath && !assetExt;
    if (missingTypesHere && !ancestorMissing) {
        console.log(`${prefix}${childPrefix}   ⚠️  No type resolution found for import`);
    }

    if (edge.isMismatch === true) {
        console.log(`${prefix}${childPrefix}   🚨 Mismatch detected!`);
    }
    
    if (node.children && node.children.length > 0 && !hasRevisit) {
        // Filter children to only those that match or have matching descendants
        const childrenToShow = node.children.filter((child: any) => {
            if (child.alreadyVisited) return true;
            
            let show = true;
            
            // Apply mismatch-only filter
            if (MISMATCHES_ONLY) {
                show = hasMismatchInTree(child);
            }
            
            // Apply pattern filter if specified
            if (show && FILTER_PATTERN) {
                show = hasMatchingDescendant(child);
            }
            
            return show;
        });
        
        childrenToShow.forEach((child: any, idx: number) => {
            printTree(child, depth + 1, idx === childrenToShow.length - 1, prefix + childPrefix, ancestorMissing || missingTypesHere);
        });
    }
}

console.log(`📂 ${path.relative(process.cwd(), absEntryFile)}`);
tree.forEach((node, idx) => {
    printTree(node, 0, idx === tree.length - 1, '');
});

// Print package summary after the tree
if (packageVersions.size > 0) {
    console.log('\n📦 Package Versions Summary:');
    const names = Array.from(packageVersions.keys()).sort((a,b) => a.localeCompare(b));
    for (const name of names) {
        const versions = Array.from(packageVersions.get(name) || []).sort((a,b) => a.localeCompare(b));
        const multiple = versions.length > 1;
        const warn = multiple ? ' ⚠️' : '  ';
        console.log(`   ${warn} ${name}: ${versions.join(', ')}`);
    }
}