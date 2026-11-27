import * as SQLite from 'expo-sqlite';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { getProjectDirectory } from './authorHelpers';
import { SEED_DATA, SEED_DATASET_TIMESTAMP } from './seedLoader';

/**
 * Permanently removes a project's SQLite rows (`photos`, `reports`, `beneficiaries`)
 * and deletes its `HousingInspection/<safeCodeDir>` folder from disk.
 */
export const deleteProjectFromDevice = async (
  db: SQLite.SQLiteDatabase,
  code: string
): Promise<void> => {
  await db.withTransactionAsync(async () => {
    await db.runAsync(`DELETE FROM photos WHERE beneficiary_code = ?`, [code]);
    await db.runAsync(`DELETE FROM reports WHERE beneficiary_code = ?`, [code]);
    await db.runAsync(`DELETE FROM beneficiaries WHERE code = ?`, [code]);
  });
  const projectDir = getProjectDirectory(code);
  if (projectDir.exists) {
    projectDir.delete();
  }
};

export const initDatabase = async (db: SQLite.SQLiteDatabase) => {
  try {
    await db.execAsync(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS beneficiaries (
        code TEXT PRIMARY KEY,
        name TEXT,
        serial_number TEXT,
        mobile_number TEXT,
        aadhar_number TEXT,
        bank_name TEXT,
        account_number TEXT,
        amount TEXT,
        district_name TEXT,
        city_name TEXT,
        annexure_id TEXT,
        father_name TEXT,
        project_name TEXT,
        site_address TEXT,
        inspection_status TEXT DEFAULT 'pending',
        sync_status TEXT DEFAULT 'pending',
        is_custom INTEGER DEFAULT 0,
        author_id TEXT,
        author_name TEXT,
        original_code TEXT,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS app_metadata (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY,
        beneficiary_code TEXT NOT NULL,
        author_id TEXT,
        author_name TEXT,
        original_author_id TEXT,
        original_author_name TEXT,
        notes TEXT,
        note_filename TEXT,
        is_edited_copy INTEGER DEFAULT 0,
        parent_report_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (beneficiary_code) REFERENCES beneficiaries (code) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS photos (
        id TEXT PRIMARY KEY,
        beneficiary_code TEXT,
        report_id TEXT,
        local_uri TEXT NOT NULL,
        filename TEXT NOT NULL,
        latitude TEXT,
        longitude TEXT,
        notes TEXT,
        author_id TEXT,
        author_name TEXT,
        sync_status TEXT DEFAULT 'local_only',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (beneficiary_code) REFERENCES beneficiaries (code) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_photos_beneficiary_code ON photos(beneficiary_code);
    `);

    // Schema validation/migrations
    const existingColumns = await db.getAllAsync(`PRAGMA table_info(beneficiaries);`) as { name: string }[];
    const columnNames = existingColumns.map(c => c.name);
    
    const alterQueries: string[] = [];
    if (!columnNames.includes('district_name')) alterQueries.push(`ALTER TABLE beneficiaries ADD COLUMN district_name TEXT;`);
    if (!columnNames.includes('city_name')) alterQueries.push(`ALTER TABLE beneficiaries ADD COLUMN city_name TEXT;`);
    if (!columnNames.includes('annexure_id')) alterQueries.push(`ALTER TABLE beneficiaries ADD COLUMN annexure_id TEXT;`);
    if (!columnNames.includes('father_name')) alterQueries.push(`ALTER TABLE beneficiaries ADD COLUMN father_name TEXT;`);
    if (!columnNames.includes('project_name')) alterQueries.push(`ALTER TABLE beneficiaries ADD COLUMN project_name TEXT;`);
    if (!columnNames.includes('site_address')) alterQueries.push(`ALTER TABLE beneficiaries ADD COLUMN site_address TEXT;`);
    if (!columnNames.includes('inspection_status')) alterQueries.push(`ALTER TABLE beneficiaries ADD COLUMN inspection_status TEXT DEFAULT 'pending';`);
    if (!columnNames.includes('is_custom')) alterQueries.push(`ALTER TABLE beneficiaries ADD COLUMN is_custom INTEGER DEFAULT 0;`);
    if (!columnNames.includes('author_id')) alterQueries.push(`ALTER TABLE beneficiaries ADD COLUMN author_id TEXT;`);
    if (!columnNames.includes('author_name')) alterQueries.push(`ALTER TABLE beneficiaries ADD COLUMN author_name TEXT;`);
    if (!columnNames.includes('original_code')) alterQueries.push(`ALTER TABLE beneficiaries ADD COLUMN original_code TEXT;`);

    const existingPhotoColumns = await db.getAllAsync(`PRAGMA table_info(photos);`) as { name: string }[];
    const photoColumnNames = existingPhotoColumns.map(c => c.name);
    if (!photoColumnNames.includes('report_id')) alterQueries.push(`ALTER TABLE photos ADD COLUMN report_id TEXT;`);
    if (!photoColumnNames.includes('author_id')) alterQueries.push(`ALTER TABLE photos ADD COLUMN author_id TEXT;`);
    if (!photoColumnNames.includes('author_name')) alterQueries.push(`ALTER TABLE photos ADD COLUMN author_name TEXT;`);

    const existingReportColumns = await db.getAllAsync(`PRAGMA table_info(reports);`) as { name: string }[];
    const reportColumnNames = existingReportColumns.map(c => c.name);
    if (!reportColumnNames.includes('author_id')) alterQueries.push(`ALTER TABLE reports ADD COLUMN author_id TEXT;`);
    if (!reportColumnNames.includes('original_author_id')) alterQueries.push(`ALTER TABLE reports ADD COLUMN original_author_id TEXT;`);
    if (!reportColumnNames.includes('original_author_name')) alterQueries.push(`ALTER TABLE reports ADD COLUMN original_author_name TEXT;`);
    if (!reportColumnNames.includes('note_filename')) alterQueries.push(`ALTER TABLE reports ADD COLUMN note_filename TEXT;`);
    if (!reportColumnNames.includes('is_edited_copy')) alterQueries.push(`ALTER TABLE reports ADD COLUMN is_edited_copy INTEGER DEFAULT 0;`);
    if (!reportColumnNames.includes('parent_report_id')) alterQueries.push(`ALTER TABLE reports ADD COLUMN parent_report_id TEXT;`);

    for (const query of alterQueries) {
      try { await db.execAsync(query); } catch(e) {}
    }

    // Create secondary indexes AFTER column migrations complete
    try { await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_photos_report_id ON photos(report_id);`); } catch(e) {}
    try { await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_reports_beneficiary_code ON reports(beneficiary_code);`); } catch(e) {}

    // Track installed/updated app version & OTA update ID timestamp in app_metadata
    try {
      const currentAppVersion = Constants.expoConfig?.version || '1.0.0';
      const currentUpdateId = Updates.updateId || 'embedded';
      const storedVersion = await db.getFirstAsync<{ value: string }>(
        `SELECT value FROM app_metadata WHERE key = 'installed_version'`
      );
      const storedUpdateId = await db.getFirstAsync<{ value: string }>(
        `SELECT value FROM app_metadata WHERE key = 'installed_update_id'`
      );
      if (
        !storedVersion ||
        storedVersion.value !== currentAppVersion ||
        !storedUpdateId ||
        storedUpdateId.value !== currentUpdateId
      ) {
        const nowIso = new Date().toISOString();
        await db.runAsync(
          `INSERT OR REPLACE INTO app_metadata (key, value) VALUES ('installed_version', ?)`,
          [currentAppVersion]
        );
        await db.runAsync(
          `INSERT OR REPLACE INTO app_metadata (key, value) VALUES ('installed_update_id', ?)`,
          [currentUpdateId]
        );
        await db.runAsync(
          `INSERT OR REPLACE INTO app_metadata (key, value) VALUES ('app_version_updated_at', ?)`,
          [nowIso]
        );
      }
    } catch (versionErr) {
      console.error('Failed to track app version metadata:', versionErr);
    }

    // Fast startup: schema + migrations complete immediately; seed dataset sync runs in the background
  } catch (error) {
    console.error("Database initialization failed:", error);
  }
};

interface SeedRecord {
  code?: string;
  name?: string;
  serial_number?: string;
  mobile_number?: string;
  aadhar_number?: string;
  bank_name?: string;
  account_number?: string;
  district_name?: string;
  city_name?: string;
  annexure_id?: string;
  father_name?: string;
  project_name?: string;
  site_address?: string;
}

const SEED_BATCH_SIZE = 250;
let activeSeedSyncPromise: Promise<boolean> | null = null;

const computeSeedSignature = (seedData: SeedRecord[]): string => {
  let hash = 2166136261;
  for (let i = 0; i < seedData.length; i++) {
    const item = seedData[i];
    const sample = `${item.code ?? ''}|${item.name ?? ''}|${item.serial_number ?? ''}|${item.mobile_number ?? ''}|${item.aadhar_number ?? ''}|${item.bank_name ?? ''}|${item.account_number ?? ''}|${item.district_name ?? ''}|${item.city_name ?? ''}|${item.annexure_id ?? ''}|${item.father_name ?? ''}|${item.project_name ?? ''}|${item.site_address ?? ''}`;
    for (let j = 0; j < sample.length; j++) {
      hash ^= sample.charCodeAt(j);
      hash = Math.imul(hash, 16777619);
    }
  }
  return `${SEED_DATASET_TIMESTAMP}:${seedData.length}:${hash >>> 0}`;
};

/**
 * Non-blocking, chunked background sync of bundled seed records into SQLite.
 * Preserves existing inspections, photos, and custom-added projects.
 */
export const syncSeedDatasetInBackground = (
  db: SQLite.SQLiteDatabase
): Promise<boolean> => {
  if (activeSeedSyncPromise) {
    return activeSeedSyncPromise;
  }

  activeSeedSyncPromise = (async () => {
    try {
      const seedData = SEED_DATA as SeedRecord[];
      if (!Array.isArray(seedData) || seedData.length === 0) {
        return false;
      }

      const { count } =
        (await db.getFirstAsync<{ count: number }>(
          `SELECT COUNT(*) as count FROM beneficiaries`
        )) || { count: 0 };

      const seedSignature = computeSeedSignature(seedData);
      const storedMeta = await db.getFirstAsync<{ value: string }>(
        `SELECT value FROM app_metadata WHERE key = 'seed_signature'`
      );

      if (count >= seedData.length && storedMeta?.value === seedSignature) {
        return false;
      }

      console.log(
        `Background syncing seed dataset (${seedData.length} records, existing DB count: ${count})...`
      );

      const upsertSql = `
        INSERT INTO beneficiaries (
          code, name, serial_number, mobile_number, aadhar_number,
          bank_name, account_number, district_name, city_name,
          annexure_id, father_name, project_name, site_address,
          inspection_status, sync_status, is_custom
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', 0)
        ON CONFLICT(code) DO UPDATE SET
          serial_number = CASE WHEN COALESCE(beneficiaries.serial_number, '') = '' AND excluded.serial_number != '' THEN excluded.serial_number ELSE beneficiaries.serial_number END,
          mobile_number = CASE WHEN COALESCE(beneficiaries.mobile_number, '') = '' AND excluded.mobile_number != '' THEN excluded.mobile_number ELSE beneficiaries.mobile_number END,
          aadhar_number = CASE WHEN COALESCE(beneficiaries.aadhar_number, '') = '' AND excluded.aadhar_number != '' THEN excluded.aadhar_number ELSE beneficiaries.aadhar_number END,
          bank_name = CASE WHEN COALESCE(beneficiaries.bank_name, '') = '' AND excluded.bank_name != '' THEN excluded.bank_name ELSE beneficiaries.bank_name END,
          account_number = CASE WHEN COALESCE(beneficiaries.account_number, '') = '' AND excluded.account_number != '' THEN excluded.account_number ELSE beneficiaries.account_number END,
          district_name = CASE WHEN excluded.district_name != '' AND COALESCE(beneficiaries.is_custom, 0) = 0 THEN excluded.district_name ELSE beneficiaries.district_name END,
          city_name = CASE WHEN excluded.city_name != '' AND COALESCE(beneficiaries.is_custom, 0) = 0 THEN excluded.city_name ELSE beneficiaries.city_name END,
          annexure_id = CASE WHEN COALESCE(beneficiaries.annexure_id, '') = '' AND excluded.annexure_id != '' THEN excluded.annexure_id ELSE beneficiaries.annexure_id END,
          father_name = CASE WHEN COALESCE(beneficiaries.father_name, '') = '' AND excluded.father_name != '' THEN excluded.father_name ELSE beneficiaries.father_name END,
          project_name = CASE WHEN COALESCE(beneficiaries.project_name, '') = '' AND excluded.project_name != '' THEN excluded.project_name ELSE beneficiaries.project_name END,
          site_address = CASE WHEN COALESCE(beneficiaries.site_address, '') = '' AND excluded.site_address != '' THEN excluded.site_address ELSE beneficiaries.site_address END
      `;

      for (let start = 0; start < seedData.length; start += SEED_BATCH_SIZE) {
        const batch = seedData.slice(start, start + SEED_BATCH_SIZE);
        await db.withTransactionAsync(async () => {
          const statement = await db.prepareAsync(upsertSql);
          try {
            for (const item of batch) {
              const cleanCode = item.code ? String(item.code).trim() : '';
              if (!cleanCode) continue;
              await statement.executeAsync([
                cleanCode,
                item.name || '',
                item.serial_number || '',
                item.mobile_number || '',
                item.aadhar_number || '',
                item.bank_name || '',
                item.account_number || '',
                item.district_name || '',
                item.city_name || '',
                item.annexure_id || '',
                item.father_name || '',
                item.project_name || '',
                item.site_address || '',
              ]);
            }
          } finally {
            await statement.finalizeAsync();
          }
        });

        // Yield briefly between batches so UI navigation and queries stay responsive
        await new Promise((resolve) => setTimeout(resolve, 15));
      }

      await db.runAsync(
        `INSERT OR REPLACE INTO app_metadata (key, value) VALUES ('seed_signature', ?)`,
        [seedSignature]
      );

      console.log(`Background seed sync completed (${seedData.length} records).`);
      return true;
    } catch (seedError) {
      console.error("Failed to sync bundled seed dataset in background.", seedError);
      return false;
    } finally {
      activeSeedSyncPromise = null;
    }
  })();

  return activeSeedSyncPromise;
};