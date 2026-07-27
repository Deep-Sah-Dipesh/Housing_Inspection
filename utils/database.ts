import * as SQLite from 'expo-sqlite';

/**
 * Initializes the offline-first SQLite database for the Housing Inspection App.
 * Includes all optional fields requested for manual entry.
 */
export const initDatabase = async (db: SQLite.SQLiteDatabase) => {
  try {
    await db.execAsync(`
      PRAGMA journal_mode = WAL;
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
        sync_status TEXT DEFAULT 'pending',
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS photos (
        id TEXT PRIMARY KEY,
        beneficiary_code TEXT,
        local_uri TEXT NOT NULL,
        filename TEXT NOT NULL,
        latitude TEXT,
        longitude TEXT,
        notes TEXT,
        sync_status TEXT DEFAULT 'local_only',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (beneficiary_code) REFERENCES beneficiaries (code) ON DELETE CASCADE
      );
    `);

    // Basic migration check (in case the table existed previously without the new columns)
    const existingColumns = await db.getAllAsync(`PRAGMA table_info(beneficiaries);`) as any[];
    const columnNames = existingColumns.map(c => c.name);
    
    const alterQueries = [];
    if (!columnNames.includes('mobile_number')) alterQueries.push(`ALTER TABLE beneficiaries ADD COLUMN mobile_number TEXT;`);
    if (!columnNames.includes('aadhar_number')) alterQueries.push(`ALTER TABLE beneficiaries ADD COLUMN aadhar_number TEXT;`);
    if (!columnNames.includes('bank_name')) alterQueries.push(`ALTER TABLE beneficiaries ADD COLUMN bank_name TEXT;`);
    if (!columnNames.includes('account_number')) alterQueries.push(`ALTER TABLE beneficiaries ADD COLUMN account_number TEXT;`);
    if (!columnNames.includes('amount')) alterQueries.push(`ALTER TABLE beneficiaries ADD COLUMN amount TEXT;`);

    for (const query of alterQueries) {
      try { await db.execAsync(query); } catch(e) { console.warn("Migration skip:", e); }
    }

    console.log("Offline Database Initialized with full schema");
  } catch (error) {
    console.error("Database initialization failed:", error);
  }
};