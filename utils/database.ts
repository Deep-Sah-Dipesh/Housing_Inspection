import * as SQLite from 'expo-sqlite';

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

      CREATE INDEX IF NOT EXISTS idx_photos_beneficiary_code ON photos(beneficiary_code);
    `);

    // Schema validation/migrations
    const existingColumns = await db.getAllAsync(`PRAGMA table_info(beneficiaries);`) as any[];
    const columnNames = existingColumns.map(c => c.name);
    
    const alterQueries = [];
    if (!columnNames.includes('district_name')) alterQueries.push(`ALTER TABLE beneficiaries ADD COLUMN district_name TEXT;`);
    if (!columnNames.includes('city_name')) alterQueries.push(`ALTER TABLE beneficiaries ADD COLUMN city_name TEXT;`);
    if (!columnNames.includes('annexure_id')) alterQueries.push(`ALTER TABLE beneficiaries ADD COLUMN annexure_id TEXT;`);
    if (!columnNames.includes('father_name')) alterQueries.push(`ALTER TABLE beneficiaries ADD COLUMN father_name TEXT;`);
    if (!columnNames.includes('project_name')) alterQueries.push(`ALTER TABLE beneficiaries ADD COLUMN project_name TEXT;`);
    if (!columnNames.includes('site_address')) alterQueries.push(`ALTER TABLE beneficiaries ADD COLUMN site_address TEXT;`);
    if (!columnNames.includes('inspection_status')) alterQueries.push(`ALTER TABLE beneficiaries ADD COLUMN inspection_status TEXT DEFAULT 'pending';`);

    for (const query of alterQueries) {
      try { await db.execAsync(query); } catch(e) {}
    }

    // ROBUST SEEDING: Target is 9848. If below 9800, we consider it incomplete/empty and re-seed.
    const { count } = await db.getFirstAsync<{count: number}>(`SELECT COUNT(*) as count FROM beneficiaries`) || { count: 0 };
    const EXPECTED_MIN_COUNT = 9800; 
    
    if (count < EXPECTED_MIN_COUNT) {
      console.log(`Database incomplete (Count: ${count}). Initializing strict seeding...`);
      try {
        const seedData = require('../assets/beneficiaries_seed.json');
        
        if (seedData && seedData.length > 0) {
          // Wipe table before seeding to prevent Primary Key collisions during incomplete recoveries
          await db.execAsync(`DELETE FROM beneficiaries`);
          
          await db.withTransactionAsync(async () => {
            const statement = await db.prepareAsync(`
              INSERT INTO beneficiaries (code, name, serial_number, district_name, city_name, annexure_id, father_name, project_name, site_address, inspection_status, sync_status)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending')
            `);
            
            for (const item of seedData) {
              await statement.executeAsync([
                item.code || '',
                item.name || '',
                item.serial_number || '',
                item.district_name || '',
                item.city_name || '',
                item.annexure_id || '',
                item.father_name || '',
                item.project_name || '',
                item.site_address || ''
              ]);
            }
            await statement.finalizeAsync();
          });
          console.log(`Successfully seeded ${seedData.length} projects!`);
        }
      } catch (seedError) {
        console.error("Failed to load or parse beneficiaries_seed.json.", seedError);
      }
    } else {
      console.log(`Database active and verified. Found ${count} projects. Loading app...`);
    }

  } catch (error) {
    console.error("Database initialization failed:", error);
  }
};