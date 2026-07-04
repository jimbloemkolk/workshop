import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { packageRoot } from '../config.js'
import * as schema from './schema.js'

export type Db = ReturnType<typeof openDb>

export function openDb(dataDir: string) {
  fs.mkdirSync(dataDir, { recursive: true })
  const sqlite = new Database(path.join(dataDir, 'harvester.db'))
  sqlite.pragma('journal_mode = WAL')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: path.join(packageRoot, 'drizzle') })
  return db
}

export { schema }
