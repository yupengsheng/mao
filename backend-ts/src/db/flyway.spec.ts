import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  compareVersions,
  flywayChecksum,
  listMigrations,
  migrateWithDb,
  parseMigrationName,
  resolveMigrationDir,
  runFlywayIfEnabled,
  splitSqlStatements,
  type FlywayDb,
} from './flyway.js';
import { notDeleted } from './db.js';
import type { AppConfig } from '../config/app-config.js';

describe('Flyway contract', () => {
  it('migration files are well-formed with stable checksums', () => {
    const tsDir = resolve(process.cwd(), 'db/migration');
    expect(existsSync(tsDir)).toBe(true);
    const files = readdirSync(tsDir).filter((f) => f.endsWith('.sql')).sort();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(parseMigrationName(file), file).not.toBeNull();
      const sql = readFileSync(resolve(tsDir, file), 'utf8');
      expect(sql.length, file).toBeGreaterThan(0);
      expect(typeof flywayChecksum(sql), file).toBe('number');
    }
  });

  it('runFlywayIfEnabled noops when disabled', async () => {
    const cfg = { spring: { flyway: { enabled: false } } } as AppConfig;
    await expect(runFlywayIfEnabled(cfg)).resolves.toBeUndefined();
  });

  it('notDeleted helper', () => {
    expect(notDeleted()).toBe('deleted = 0');
    expect(notDeleted('s')).toBe('s.deleted = 0');
  });
});

describe('Flyway checksum and filenames', () => {
  it('ignores line endings and BOM', () => {
    const unix = flywayChecksum('hello\nworld\n');
    const windows = flywayChecksum('hello\r\nworld\r\n');
    const bom = flywayChecksum('\uFEFFhello\nworld\n');
    expect(unix).toBe(windows);
    expect(unix).toBe(bom);
    expect(unix).not.toBe(0);
  });

  it('parses V001 filenames', () => {
    expect(parseMigrationName('V001__init_schema.sql')).toEqual({
      version: '001',
      description: 'init schema',
    });
    expect(parseMigrationName('readme.txt')).toBeNull();
  });

  it('compares dotted versions numerically', () => {
    expect(compareVersions('9', '10')).toBeLessThan(0);
    expect(compareVersions('001', '012')).toBeLessThan(0);
    expect(compareVersions('075', '075')).toBe(0);
  });

  it('lists shared SQL migrations in version order', () => {
    const dir = resolveMigrationDir();
    const migrations = listMigrations(dir);
    expect(migrations[0]?.script).toBe('V001__init_schema.sql');
    expect(migrations.some((m) => m.script.startsWith('V075'))).toBe(true);
    for (let i = 1; i < migrations.length; i += 1) {
      expect(compareVersions(migrations[i - 1].version, migrations[i].version)).toBeLessThanOrEqual(0);
    }
    // 版本号唯一：重名时后一个文件会被 appliedVersions 静默跳过，listMigrations 直接抛错
    expect(new Set(migrations.map((m) => m.version)).size).toBe(migrations.length);
  });

  it('rejects duplicate versions instead of silently skipping the later file', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mao-flyway-dup-'));
    try {
      writeFileSync(resolve(dir, 'V148__first.sql'), 'SELECT 1;');
      writeFileSync(resolve(dir, 'V148__second.sql'), 'SELECT 2;');
      expect(() => listMigrations(dir)).toThrow(/duplicate migration version 148: V148__first\.sql and V148__second\.sql/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('splitSqlStatements', () => {
  it('splits same-line statements and ignores empty or comment-only fragments', () => {
    expect(splitSqlStatements('SELECT 1; SELECT 2; ; # trailing ;\n-- comment\n/* comment */')).toEqual(['SELECT 1', 'SELECT 2']);
    expect(splitSqlStatements('SELECT 3')).toEqual(['SELECT 3']);
  });

  it('keeps a stored procedure intact and removes client directives with BOM/CRLF', () => {
    const sql = '\uFEFFSELECT 1;\r\n  delimiter //\r\nCREATE PROCEDURE p()\r\nBEGIN\r\n SELECT \'a; //\';\r\n SELECT 2;\r\nEND //\r\nDELIMITER ;\r\nCALL p(); DROP PROCEDURE p;';
    expect(splitSqlStatements(sql)).toEqual([
      'SELECT 1', "CREATE PROCEDURE p()\nBEGIN\n SELECT 'a; //';\n SELECT 2;\nEND", 'CALL p()', 'DROP PROCEDURE p',
    ]);
  });

  it('does not split quoted semicolons, doubled quotes or backslash-escaped quotes', () => {
    const first = ["SELECT 'a;it''s'", '"b;""c"', '`semi;``colon`', String.raw`'it\'s;ok'`, String.raw`"a\";b"`].join(', ');
    expect(splitSqlStatements(`${first}; SELECT 2;`)).toEqual([first, 'SELECT 2']);
  });

  it('does not treat multiline literal or comment content as a DELIMITER directive', () => {
    const first = "SELECT 'first;\nDELIMITER //\nlast;'";
    expect(splitSqlStatements(`${first}; SELECT 2;`)).toEqual([first, 'SELECT 2']);
    const commented = '/*\nDELIMITER $$\n; */\nSELECT 1 /* ; */';
    expect(splitSqlStatements(`${commented}; -- DELIMITER //\nSELECT 2;`)).toEqual([commented, '-- DELIMITER //\nSELECT 2']);
  });

  it('ignores delimiters in line/block comments, including a comment after a statement', () => {
    const sql = 'DELIMITER $$\nCREATE PROCEDURE p()\nBEGIN\n -- $$\n # $$\n SELECT "$$"; /* $$ */\nEND$$ -- done $$\nDELIMITER ;\nSELECT 1;';
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('SELECT "$$"; /* $$ */');
    expect(statements[0]).toMatch(/END$/);
    expect(statements[1]).toBe('SELECT 1');
    expect(splitSqlStatements('SELECT 1--2; SELECT 3;')).toEqual(['SELECT 1--2', 'SELECT 3']);
  });

  it('keeps executable comments, but never sends comment-only queries', () => {
    expect(splitSqlStatements('/* ordinary ; */; /*!40101 SET @x = 1 */;')).toEqual(['/*!40101 SET @x = 1 */']);
  });

  it('rejects incomplete literals/comments and a directive inside unfinished SQL', () => {
    for (const sql of ["SELECT 'abc", 'SELECT `abc', 'SELECT 1 /* abc']) {
      expect(() => splitSqlStatements(sql)).toThrow(/Unterminated SQL/);
    }
    expect(() => splitSqlStatements('SELECT 1\nDELIMITER //')).toThrow(/between SQL statements/);
  });

  it('splits the real V001 stored procedure without changing the migration checksum', () => {
    const sql = readFileSync(resolve(process.cwd(), 'db/migration/V001__init_schema.sql'), 'utf8');
    const checksum = flywayChecksum(sql);
    const statements = splitSqlStatements(sql);
    const procedure = statements.find((statement) => /CREATE PROCEDURE create_agent_skill_table/.test(statement));
    expect(procedure).toContain('END IF;');
    expect(procedure).toMatch(/END$/);
    expect(statements.some((statement) => /^DELIMITER/m.test(statement))).toBe(false);
    expect(statements).toContain('CALL create_agent_skill_table()');
    expect(flywayChecksum(sql)).toBe(checksum);
  });
});

class FakeFlywayDb implements FlywayDb {
  tables = new Set<string>();
  history: Array<Record<string, unknown>> = [];
  executed: string[] = [];
  lock = 1;
  failScript?: string;

  async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT GET_LOCK')) {
      return [{ acquired: this.lock } as unknown as T];
    }
    if (s.startsWith('SELECT RELEASE_LOCK')) {
      return [{ released: 1 } as unknown as T];
    }
    if (s.includes('information_schema.tables') && s.includes('AND table_name =')) {
      return (this.tables.has(HISTORY) ? [{ c: 1 }] : []) as T[];
    }
    if (s.includes('information_schema.tables') && s.includes('table_name <>')) {
      return [...this.tables]
        .filter((t) => t !== HISTORY)
        .map((tableName) => ({ tableName })) as T[];
    }
    if (s.startsWith('CREATE TABLE') && s.includes(HISTORY)) {
      this.tables.add(HISTORY);
      return [] as T[];
    }
    if (s.startsWith('DELETE FROM')) {
      this.history = this.history.filter((r) => Number(r.success) !== 0);
      return [] as T[];
    }
    if (s.startsWith('SELECT installed_rank')) {
      return this.history as T[];
    }
    if (s.startsWith('INSERT INTO')) {
      this.history.push({
        installed_rank: params[0],
        version: params[1],
        description: params[2],
        type: params[3],
        script: params[4],
        checksum: params[5],
        installed_by: params[6],
        execution_time: params[7],
        success: params[8],
      });
      return [] as T[];
    }
    this.executed.push(sql);
    if (this.failScript && sql.includes(this.failScript)) {
      throw new Error('syntax error');
    }
    return [] as T[];
  }
}

const HISTORY = 'flyway_schema_history';

describe('migrateWithDb', () => {
  const sample = [
    {
      version: '001',
      versionRank: [1],
      description: 'init',
      script: 'V001__init.sql',
      checksum: 11,
      sql: 'CREATE TABLE t (id INT);',
    },
    {
      version: '002',
      versionRank: [2],
      description: 'next',
      script: 'V002__next.sql',
      checksum: 22,
      sql: 'ALTER TABLE t ADD COLUMN n INT;',
    },
  ];

  it('applies pending SQL and records history', async () => {
    const db = new FakeFlywayDb();
    const result = await migrateWithDb(db, sample, {
      baselineOnMigrate: true,
      baselineVersion: '12',
      validateOnMigrate: false,
      installedBy: 'mao',
    });
    expect(result.applied).toEqual(['V001__init.sql', 'V002__next.sql']);
    expect(db.history).toHaveLength(2);
    expect(db.history[0]?.success).toBe(1);
    expect(db.history[0]?.script).toBe('V001__init.sql');
  });

  it('executes a DELIMITER migration statement by statement and records its original checksum once', async () => {
    const db = new FakeFlywayDb();
    const sql = 'DELIMITER //\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END//\nDELIMITER ;\nCALL p(); DROP PROCEDURE p;';
    const migration = { ...sample[0], sql, checksum: flywayChecksum(sql) };
    const result = await migrateWithDb(db, [migration], {
      baselineOnMigrate: false, baselineVersion: '001', validateOnMigrate: true, installedBy: 'mao',
    });
    expect(result.applied).toEqual([migration.script]);
    expect(db.executed).toEqual(['CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END', 'CALL p()', 'DROP PROCEDURE p']);
    expect(db.history).toHaveLength(1);
    expect(db.history[0]).toMatchObject({ checksum: migration.checksum, success: 1 });
  });

  it('stops a split migration at the first failed statement and records failure once', async () => {
    const db = new FakeFlywayDb();
    db.failScript = 'SELECT 2';
    await expect(migrateWithDb(db, [{ ...sample[0], sql: 'SELECT 1; SELECT 2; SELECT 3;' }], {
      baselineOnMigrate: false, baselineVersion: '001', validateOnMigrate: false, installedBy: 'mao',
    })).rejects.toThrow(/V001__init.sql.*syntax error/);
    expect(db.executed).toEqual(['SELECT 1', 'SELECT 2']);
    expect(db.history).toHaveLength(1);
    expect(db.history[0]?.success).toBe(0);
  });

  it('baselines a non-empty schema and skips versions up to baseline', async () => {
    const db = new FakeFlywayDb();
    db.tables.add('user');
    const result = await migrateWithDb(db, sample, {
      baselineOnMigrate: true,
      baselineVersion: '001',
      validateOnMigrate: false,
      installedBy: 'mao',
    });
    expect(db.history[0]?.type).toBe('BASELINE');
    expect(result.applied).toEqual(['V002__next.sql']);
  });

  it('skips already applied versions', async () => {
    const db = new FakeFlywayDb();
    db.tables.add(HISTORY);
    db.history.push({
      installed_rank: 1,
      version: '001',
      description: 'init',
      type: 'SQL',
      script: 'V001__init.sql',
      checksum: 11,
      success: 1,
    });
    const result = await migrateWithDb(db, sample, {
      baselineOnMigrate: true,
      baselineVersion: '12',
      validateOnMigrate: false,
      installedBy: 'mao',
    });
    expect(result.applied).toEqual(['V002__next.sql']);
  });

  it('records failed migrations and throws', async () => {
    const db = new FakeFlywayDb();
    db.failScript = 'CREATE TABLE t';
    await expect(
      migrateWithDb(db, sample, {
        baselineOnMigrate: false,
        baselineVersion: '12',
        validateOnMigrate: false,
        installedBy: 'mao',
      }),
    ).rejects.toThrow(/V001__init.sql/);
    expect(db.history.some((r) => Number(r.success) === 0)).toBe(true);
  });

  it('validateOnMigrate rejects checksum mismatch', async () => {
    const db = new FakeFlywayDb();
    db.tables.add(HISTORY);
    db.history.push({
      installed_rank: 1,
      version: '001',
      description: 'init',
      type: 'SQL',
      script: 'V001__init.sql',
      checksum: 999,
      success: 1,
    });
    await expect(
      migrateWithDb(db, sample, {
        baselineOnMigrate: false,
        baselineVersion: '12',
        validateOnMigrate: true,
        installedBy: 'mao',
      }),
    ).rejects.toThrow(/checksum mismatch/);
  });
});

describe('runFlywayIfEnabled with injected db', () => {
  it('migrates using resolved SQL files', async () => {
    const db = new FakeFlywayDb();
    const close = vi.fn(async () => undefined);
    const cfg = {
      spring: {
        datasource: { url: 'jdbc:mysql://127.0.0.1:3306/mao', username: 'root', password: '' },
        flyway: {
          enabled: true,
          baselineOnMigrate: true,
          baselineVersion: '12',
          validateOnMigrate: false,
          locations: 'filesystem:db/migration',
        },
      },
    } as AppConfig;
    await runFlywayIfEnabled(cfg, process.cwd(), async () => ({ db, close }));
    expect(close).toHaveBeenCalled();
    expect(db.history.length).toBeGreaterThan(0);
    expect(String(db.history[0]?.script)).toMatch(/^V001__/);
  });
});
