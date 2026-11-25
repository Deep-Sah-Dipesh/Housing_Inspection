import { Directory, File, Paths } from 'expo-file-system';
import * as SQLite from 'expo-sqlite';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { zip, unzip } from 'react-native-zip-archive';
import {
  getProjectDirectory,
  getSafeCodeDirName,
  readProjectMeta,
  writeProjectMeta,
} from './authorHelpers';

const EXCLUDED_ROOT_DIRS = new Set([
  'SQLite',
  'RCTAsyncLocalStorage',
  'fonts',
  'assets',
  'projects_cache',
  '.expo',
  'HousingInspection',
]);

export interface BackupBeneficiaryRow {
  code: string;
  original_code: string | null;
  name: string | null;
  serial_number: string | null;
  mobile_number: string | null;
  aadhar_number: string | null;
  bank_name: string | null;
  account_number: string | null;
  amount: string | null;
  district_name: string | null;
  city_name: string | null;
  annexure_id: string | null;
  father_name: string | null;
  project_name: string | null;
  site_address: string | null;
  inspection_status: string | null;
  sync_status: string | null;
  is_custom: number | null;
  author_name: string | null;
  last_updated: string | null;
}

export interface BackupPhotoRow {
  id: string;
  beneficiary_code: string;
  local_uri: string;
  filename: string;
  latitude: string | null;
  longitude: string | null;
  notes: string | null;
  author_name: string | null;
  sync_status: string | null;
  created_at: string | null;
}

export interface BackupAppMetadataRow {
  key: string;
  value: string | null;
}

export interface BackupFileEntry {
  name: string;
  relativePath: string;
  size: number;
}

export interface BackupDatabasePayload {
  beneficiaries: BackupBeneficiaryRow[];
  photos: BackupPhotoRow[];
  appMetadata: BackupAppMetadataRow[];
  projectFiles: Record<string, BackupFileEntry[]>;
}

export interface BackupManifest {
  backupVersion: number;
  appVersion: string;
  channel: string;
  createdAt: string;
  signedByAuthor: string;
  checksum: string;
}

export interface CreateBackupResult {
  zipUri: string;
  zipFilename: string;
  projectCount: number;
  photoCount: number;
}

export interface RestoreBackupSummary {
  projectsRestored: number;
  projectsSkipped: number;
  photosRestored: number;
  authorsFound: string[];
}

export type BackupProgressCallback = (message: string, percent: number) => void;

const normalizeDocUri = (): string => {
  const uri = Paths.document.uri;
  return uri.endsWith('/') ? uri : `${uri}/`;
};

const toRelativeDocumentPath = (uri: string): string => {
  const docUri = normalizeDocUri();
  if (uri.startsWith(docUri)) {
    return uri.slice(docUri.length);
  }
  const housingIdx = uri.indexOf('HousingInspection/');
  if (housingIdx !== -1) {
    return uri.slice(housingIdx);
  }
  const filesIdx = uri.indexOf('/files/');
  if (filesIdx !== -1) {
    return uri.slice(filesIdx + '/files/'.length);
  }
  return uri;
};

const resolveRelativeToDocumentFile = (relativePath: string): File => {
  const cleanParts = relativePath.split('/').filter((p) => p.length > 0);
  if (cleanParts.length === 0) {
    return new File(Paths.document, 'unknown');
  }
  const fileName = cleanParts[cleanParts.length - 1];
  const dirParts = cleanParts.slice(0, -1);
  if (dirParts.length === 0) {
    return new File(Paths.document, fileName);
  }
  const targetDir = new Directory(Paths.document, ...dirParts);
  return new File(targetDir, fileName);
};

const computeDeterministicChecksum = (databaseJson: string, fileEntries: BackupFileEntry[]): string => {
  const sortedEntries = [...fileEntries].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath)
  );
  const manifestInput = `${databaseJson}|${JSON.stringify(
    sortedEntries.map((e) => `${e.relativePath}:${e.size}`)
  )}`;

  // Dual 32-bit FNV-1a hashes combined into a 16-char hex digest (zero native deps)
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < manifestInput.length; i++) {
    const ch = manifestInput.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= ch + (i & 0xff);
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  const part1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const part2 = (h2 >>> 0).toString(16).padStart(8, '0');
  return `${part1}${part2}`;
};

const recursiveCopyDirectory = (srcDir: Directory, destDir: Directory): void => {
  if (!srcDir.exists) return;
  destDir.create({ intermediates: true, idempotent: true });
  for (const entry of srcDir.list()) {
    if (entry instanceof Directory) {
      recursiveCopyDirectory(entry, new Directory(destDir, entry.name));
    } else {
      const targetFile = new File(destDir, entry.name);
      if (targetFile.exists) {
        targetFile.delete();
      }
      entry.copy(targetFile);
    }
  }
};

const collectDirectoryFiles = (dir: Directory, baseRelative: string): BackupFileEntry[] => {
  if (!dir.exists) return [];
  const entries: BackupFileEntry[] = [];
  for (const item of dir.list()) {
    const rel = baseRelative ? `${baseRelative}/${item.name}` : item.name;
    if (item instanceof Directory) {
      entries.push(...collectDirectoryFiles(item, rel));
    } else {
      if (item.name === '.project_meta.json') continue;
      entries.push({
        name: item.name,
        relativePath: rel,
        size: typeof item.size === 'number' ? item.size : 0,
      });
    }
  }
  return entries;
};

const makeAuthorSlug = (authorName: string): string => {
  const slug = authorName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 18);
  return slug || 'agent';
};

const makeShortSuffix = (seed: string): string => {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).slice(0, 5);
};

const normalizeFileSignatureList = (files: BackupFileEntry[]): string[] =>
  files
    .filter((f) => f.name !== '.project_meta.json')
    .map((f) => `${f.name.toLowerCase()}:${f.size}`)
    .sort();

const areFileSignaturesEqual = (a: BackupFileEntry[], b: BackupFileEntry[]): boolean => {
  const sigA = normalizeFileSignatureList(a);
  const sigB = normalizeFileSignatureList(b);
  if (sigA.length !== sigB.length) return false;
  for (let i = 0; i < sigA.length; i++) {
    if (sigA[i] !== sigB[i]) return false;
  }
  return true;
};

/**
 * Creates a tamper-resistant full backup `.zip` containing SQLite JSON export,
 * all `HousingInspection` project folders, legacy folders, and a checksummed `manifest.json`.
 */
export const createFullBackup = async (
  db: SQLite.SQLiteDatabase,
  officialName: string,
  onProgress?: BackupProgressCallback
): Promise<CreateBackupResult> => {
  const cleanOfficialName = officialName.trim();
  if (!cleanOfficialName) {
    throw new Error('Official Name is required to sign the backup.');
  }

  onProgress?.('Flushing database journal...', 5);
  await db.execAsync('PRAGMA wal_checkpoint(TRUNCATE);');

  onProgress?.('Backfilling author attribution...', 15);
  await db.runAsync(
    `UPDATE photos SET author_name = ? WHERE author_name IS NULL OR TRIM(author_name) = ''`,
    [cleanOfficialName]
  );

  const inspectedBeneficiaries = await db.getAllAsync<BackupBeneficiaryRow>(
    `SELECT DISTINCT b.*
     FROM beneficiaries b
     WHERE b.is_custom = 1
        OR EXISTS (SELECT 1 FROM photos p WHERE p.beneficiary_code = b.code)
     ORDER BY b.code ASC`
  );

  for (const b of inspectedBeneficiaries) {
    const effectiveAuthor =
      b.author_name && b.author_name.trim().length > 0 ? b.author_name.trim() : cleanOfficialName;
    if (!b.author_name || b.author_name.trim().length === 0) {
      await db.runAsync(`UPDATE beneficiaries SET author_name = ? WHERE code = ?`, [
        effectiveAuthor,
        b.code,
      ]);
      b.author_name = effectiveAuthor;
    }

    const projectDir = getProjectDirectory(b.code);
    if (projectDir.exists) {
      const existingMeta = await readProjectMeta(projectDir);
      await writeProjectMeta(projectDir, {
        beneficiaryCode: b.code,
        originalCode: b.original_code || existingMeta?.originalCode || b.code,
        authorName: existingMeta?.authorName?.trim() || effectiveAuthor,
        createdAt: existingMeta?.createdAt || b.last_updated || new Date().toISOString(),
        updatedAt: existingMeta?.updatedAt || new Date().toISOString(),
      });
    }
  }

  onProgress?.('Exporting database records...', 30);
  const allPhotos = await db.getAllAsync<BackupPhotoRow>(`SELECT * FROM photos ORDER BY created_at ASC`);
  const exportedPhotos: BackupPhotoRow[] = allPhotos.map((p) => ({
    ...p,
    local_uri: toRelativeDocumentPath(p.local_uri),
    author_name: p.author_name?.trim() || cleanOfficialName,
  }));

  const appMetadata = await db.getAllAsync<BackupAppMetadataRow>(`SELECT key, value FROM app_metadata`);

  const projectFiles: Record<string, BackupFileEntry[]> = {};
  const allFileEntries: BackupFileEntry[] = [];

  for (const b of inspectedBeneficiaries) {
    const projectDir = getProjectDirectory(b.code);
    const safeDirName = getSafeCodeDirName(b.code);
    const files = collectDirectoryFiles(projectDir, `HousingInspection/${safeDirName}`);
    projectFiles[b.code] = files;
    allFileEntries.push(...files);
  }

  const databasePayload: BackupDatabasePayload = {
    beneficiaries: inspectedBeneficiaries,
    photos: exportedPhotos,
    appMetadata,
    projectFiles,
  };
  const databaseJsonString = JSON.stringify(databasePayload, null, 2);

  onProgress?.('Staging project files...', 50);
  const stagingDir = new Directory(Paths.cache, 'Full_Backup_Staging');
  if (stagingDir.exists) {
    stagingDir.delete();
  }
  stagingDir.create({ intermediates: true, idempotent: true });

  const filesRootDir = new Directory(stagingDir, 'files');
  filesRootDir.create({ intermediates: true, idempotent: true });

  const housingRootDir = new Directory(Paths.document, 'HousingInspection');
  if (housingRootDir.exists) {
    recursiveCopyDirectory(housingRootDir, new Directory(filesRootDir, 'HousingInspection'));
  }

  // Copy any legacy photo folders in Paths.document
  if (Paths.document.exists) {
    for (const item of Paths.document.list()) {
      if (!(item instanceof Directory)) continue;
      if (item.name.startsWith('.') || EXCLUDED_ROOT_DIRS.has(item.name)) continue;
      const legacyFiles = collectDirectoryFiles(item, item.name);
      if (legacyFiles.length > 0) {
        recursiveCopyDirectory(item, new Directory(filesRootDir, item.name));
        allFileEntries.push(...legacyFiles);
      }
    }
  }

  onProgress?.('Generating tamper-resistant manifest...', 70);
  new File(stagingDir, 'database.json').write(databaseJsonString);

  const checksum = computeDeterministicChecksum(databaseJsonString, allFileEntries);
  const manifest: BackupManifest = {
    backupVersion: 1,
    appVersion: Constants.expoConfig?.version || '1.0.0',
    channel: Updates.channel || 'development',
    createdAt: new Date().toISOString(),
    signedByAuthor: cleanOfficialName,
    checksum,
  };
  new File(stagingDir, 'manifest.json').write(JSON.stringify(manifest, null, 2));

  onProgress?.('Compressing backup archive...', 85);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(
    now.getHours()
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const zipFilename = `HousingInspection_Backup_${timestamp}.zip`;
  const targetZipFile = new File(Paths.cache, zipFilename);
  if (targetZipFile.exists) {
    targetZipFile.delete();
  }

  await zip(stagingDir.uri, targetZipFile.uri);

  if (stagingDir.exists) {
    stagingDir.delete();
  }

  onProgress?.('Backup ready!', 100);
  return {
    zipUri: targetZipFile.uri,
    zipFilename,
    projectCount: inspectedBeneficiaries.length,
    photoCount: exportedPhotos.length,
  };
};

/**
 * Prompts the user to pick a `.zip` backup file, validates its manifest and checksum,
 * and restores projects, photos, notes, and author metadata without duplicating exact matches.
 */
export const restoreFullBackup = async (
  db: SQLite.SQLiteDatabase,
  onProgress?: BackupProgressCallback
): Promise<RestoreBackupSummary | null> => {
  const pickedResult = await File.pickFileAsync(undefined, 'application/zip');
  const pickedFile = Array.isArray(pickedResult) ? pickedResult[0] : pickedResult;
  if (!pickedFile) {
    return null;
  }

  onProgress?.('Reading selected backup archive...', 10);
  const tempZipFile = new File(Paths.cache, 'Restore_Backup_Input.zip');
  if (tempZipFile.exists) {
    tempZipFile.delete();
  }
  const zipBytes = await pickedFile.bytes();
  tempZipFile.write(zipBytes);

  const restoreStagingDir = new Directory(Paths.cache, 'Restore_Backup_Staging');
  if (restoreStagingDir.exists) {
    restoreStagingDir.delete();
  }
  restoreStagingDir.create({ intermediates: true, idempotent: true });

  try {
    onProgress?.('Extracting archive...', 25);
    await unzip(tempZipFile.uri, restoreStagingDir.uri);

    const manifestFile = new File(restoreStagingDir, 'manifest.json');
    const databaseFile = new File(restoreStagingDir, 'database.json');
    if (!manifestFile.exists || !databaseFile.exists) {
      throw new Error('Invalid backup archive: missing manifest.json or database.json.');
    }

    onProgress?.('Verifying backup integrity...', 40);
    const manifest = JSON.parse(await manifestFile.text()) as BackupManifest;
    const databaseJsonString = await databaseFile.text();
    const dbPayload = JSON.parse(databaseJsonString) as BackupDatabasePayload;

    if (!manifest.checksum || !Array.isArray(dbPayload.beneficiaries) || !Array.isArray(dbPayload.photos)) {
      throw new Error('Backup metadata is malformed.');
    }

    const filesRootDir = new Directory(restoreStagingDir, 'files');
    const extractedEntries: BackupFileEntry[] = [];
    const housingExtractedDir = new Directory(filesRootDir, 'HousingInspection');
    if (housingExtractedDir.exists) {
      for (const b of dbPayload.beneficiaries) {
        const expectedRelFiles = dbPayload.projectFiles?.[b.code] || [];
        for (const f of expectedRelFiles) {
          extractedEntries.push(f);
        }
      }
    }
    if (filesRootDir.exists) {
      for (const item of filesRootDir.list()) {
        if (item instanceof Directory && item.name !== 'HousingInspection') {
          extractedEntries.push(...collectDirectoryFiles(item, item.name));
        }
      }
    }

    const computedChecksum = computeDeterministicChecksum(databaseJsonString, extractedEntries);
    if (computedChecksum !== manifest.checksum) {
      throw new Error('Backup integrity check failed: the archive may have been modified or corrupted.');
    }

    let projectsRestored = 0;
    let projectsSkipped = 0;
    let photosRestored = 0;
    const authorsSet = new Set<string>();

    const totalProjects = Math.max(1, dbPayload.beneficiaries.length);

    for (let i = 0; i < dbPayload.beneficiaries.length; i++) {
      const b = dbPayload.beneficiaries[i];
      const pct = 45 + Math.round(((i + 1) / totalProjects) * 45);
      onProgress?.(`Restoring project ${i + 1} of ${totalProjects}...`, pct);

      const backupAuthor = b.author_name?.trim() || manifest.signedByAuthor || 'Field Agent';
      authorsSet.add(backupAuthor);
      const trueOriginalCode = b.original_code?.trim() || b.code;

      const backupPhotos = dbPayload.photos.filter((p) => p.beneficiary_code === b.code);
      const backupFiles = dbPayload.projectFiles?.[b.code] || [];

      const existingInspectedReports = await db.getAllAsync<BackupBeneficiaryRow>(
        `SELECT * FROM beneficiaries
         WHERE (code = ? OR original_code = ? OR code = ?)
           AND (is_custom = 1 OR EXISTS (SELECT 1 FROM photos p WHERE p.beneficiary_code = beneficiaries.code))`,
        [trueOriginalCode, trueOriginalCode, b.code]
      );

      let isExactDuplicate = false;
      for (const localReport of existingInspectedReports) {
        const localAuthor = localReport.author_name?.trim() || '';
        const sameAuthor = localAuthor.toLowerCase() === backupAuthor.toLowerCase();
        if (!sameAuthor) continue;

        const localDir = getProjectDirectory(localReport.code);
        const localFiles = collectDirectoryFiles(
          localDir,
          `HousingInspection/${getSafeCodeDirName(localReport.code)}`
        );
        if (areFileSignaturesEqual(localFiles, backupFiles)) {
          isExactDuplicate = true;
          break;
        }
      }

      if (isExactDuplicate) {
        projectsSkipped++;
        continue;
      }

      let targetCode = b.code;
      let targetOriginalCode: string | null = b.original_code;

      if (existingInspectedReports.length > 0) {
        const slug = makeAuthorSlug(backupAuthor);
        const suffix = makeShortSuffix(`${b.code}_${backupAuthor}_${manifest.createdAt}_${i}`);
        targetCode = `${trueOriginalCode}__${slug}_${suffix}`;
        targetOriginalCode = trueOriginalCode;
      }

      const sourceProjectDir = new Directory(
        filesRootDir,
        'HousingInspection',
        getSafeCodeDirName(b.code)
      );
      const destProjectDir = getProjectDirectory(targetCode);
      if (sourceProjectDir.exists) {
        recursiveCopyDirectory(sourceProjectDir, destProjectDir);
      } else {
        destProjectDir.create({ intermediates: true, idempotent: true });
      }

      await writeProjectMeta(destProjectDir, {
        beneficiaryCode: targetCode,
        originalCode: targetOriginalCode || trueOriginalCode,
        authorName: backupAuthor,
        createdAt: b.last_updated || manifest.createdAt,
        updatedAt: new Date().toISOString(),
      });

      await db.runAsync(
        `INSERT INTO beneficiaries (
          code, original_code, name, serial_number, mobile_number, aadhar_number,
          bank_name, account_number, amount, district_name, city_name,
          annexure_id, father_name, project_name, site_address,
          inspection_status, sync_status, is_custom, author_name, last_updated
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET
          original_code = COALESCE(excluded.original_code, beneficiaries.original_code),
          name = COALESCE(NULLIF(excluded.name, ''), beneficiaries.name),
          serial_number = COALESCE(NULLIF(excluded.serial_number, ''), beneficiaries.serial_number),
          mobile_number = COALESCE(NULLIF(excluded.mobile_number, ''), beneficiaries.mobile_number),
          aadhar_number = COALESCE(NULLIF(excluded.aadhar_number, ''), beneficiaries.aadhar_number),
          bank_name = COALESCE(NULLIF(excluded.bank_name, ''), beneficiaries.bank_name),
          account_number = COALESCE(NULLIF(excluded.account_number, ''), beneficiaries.account_number),
          amount = COALESCE(NULLIF(excluded.amount, ''), beneficiaries.amount),
          district_name = COALESCE(NULLIF(excluded.district_name, ''), beneficiaries.district_name),
          city_name = COALESCE(NULLIF(excluded.city_name, ''), beneficiaries.city_name),
          annexure_id = COALESCE(NULLIF(excluded.annexure_id, ''), beneficiaries.annexure_id),
          father_name = COALESCE(NULLIF(excluded.father_name, ''), beneficiaries.father_name),
          project_name = COALESCE(NULLIF(excluded.project_name, ''), beneficiaries.project_name),
          site_address = COALESCE(NULLIF(excluded.site_address, ''), beneficiaries.site_address),
          inspection_status = excluded.inspection_status,
          sync_status = excluded.sync_status,
          is_custom = excluded.is_custom,
          author_name = excluded.author_name,
          last_updated = excluded.last_updated`,
        [
          targetCode,
          targetOriginalCode,
          b.name,
          b.serial_number,
          b.mobile_number,
          b.aadhar_number,
          b.bank_name,
          b.account_number,
          b.amount,
          b.district_name,
          b.city_name,
          b.annexure_id,
          b.father_name,
          b.project_name,
          b.site_address,
          b.inspection_status || 'pending',
          b.sync_status || 'pending',
          b.is_custom ?? 0,
          backupAuthor,
          b.last_updated || new Date().toISOString(),
        ]
      );

      for (const photo of backupPhotos) {
        const destPhotoFile =
          targetCode !== b.code
            ? new File(destProjectDir, photo.filename)
            : resolveRelativeToDocumentFile(photo.local_uri);

        const photoId =
          targetCode !== b.code
            ? `${photo.id}_${makeShortSuffix(targetCode)}`
            : photo.id;

        await db.runAsync(
          `INSERT OR REPLACE INTO photos (
            id, beneficiary_code, local_uri, filename, latitude, longitude,
            notes, author_name, sync_status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            photoId,
            targetCode,
            destPhotoFile.uri,
            photo.filename,
            photo.latitude,
            photo.longitude,
            photo.notes,
            photo.author_name?.trim() || backupAuthor,
            photo.sync_status || 'local_only',
            photo.created_at || new Date().toISOString(),
          ]
        );
        photosRestored++;
      }

      projectsRestored++;
    }

    // Restore any legacy folders if not already present locally
    if (filesRootDir.exists) {
      for (const item of filesRootDir.list()) {
        if (!(item instanceof Directory)) continue;
        if (item.name === 'HousingInspection' || EXCLUDED_ROOT_DIRS.has(item.name)) continue;
        const targetLegacyDir = new Directory(Paths.document, item.name);
        if (!targetLegacyDir.exists) {
          recursiveCopyDirectory(item, targetLegacyDir);
        }
      }
    }

    onProgress?.('Restore complete!', 100);
    return {
      projectsRestored,
      projectsSkipped,
      photosRestored,
      authorsFound: Array.from(authorsSet),
    };
  } finally {
    if (tempZipFile.exists) {
      tempZipFile.delete();
    }
    if (restoreStagingDir.exists) {
      restoreStagingDir.delete();
    }
  }
};
