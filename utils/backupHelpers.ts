import { Directory, File, Paths } from 'expo-file-system';
import * as SQLite from 'expo-sqlite';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { zip, unzip } from 'react-native-zip-archive';
import {
  deriveAuthorId,
  generateReportId,
  getProjectDirectory,
  getReportDirectory,
  getSafeCodeDirName,
  readProjectMeta,
  writeProjectMeta,
  writeReportMeta,
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
  author_id?: string | null;
  author_name: string | null;
  last_updated: string | null;
}

export interface BackupReportRow {
  id: string;
  beneficiary_code: string;
  author_id?: string | null;
  author_name: string | null;
  original_author_id?: string | null;
  original_author_name?: string | null;
  notes: string | null;
  note_filename: string | null;
  is_edited_copy: number | null;
  parent_report_id: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface BackupPhotoRow {
  id: string;
  beneficiary_code: string;
  report_id?: string | null;
  local_uri: string;
  filename: string;
  latitude: string | null;
  longitude: string | null;
  notes: string | null;
  author_id?: string | null;
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
  reports?: BackupReportRow[];
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
  signedByAuthorId?: string;
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
  const cleanUri = uri.split('?')[0] || uri;
  const docUri = normalizeDocUri();
  if (cleanUri.startsWith(docUri)) {
    return cleanUri.slice(docUri.length);
  }
  const housingIdx = cleanUri.indexOf('HousingInspection/');
  if (housingIdx !== -1) {
    return cleanUri.slice(housingIdx);
  }
  const filesIdx = cleanUri.indexOf('/files/');
  if (filesIdx !== -1) {
    return cleanUri.slice(filesIdx + '/files/'.length);
  }
  return cleanUri.replace(/^\/+/, '');
};

const resolveRelativeToDocumentFile = (relativePath: string): File => {
  const cleanParts = relativePath
    .split('?')[0]
    .split('/')
    .filter((p) => p.length > 0 && p !== '..' && p !== '.');
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

const resolveRelativeFileInDir = (baseDir: Directory, relativePath: string): File => {
  const cleanParts = relativePath
    .split('?')[0]
    .split('/')
    .filter((p) => p.length > 0 && p !== '..' && p !== '.');
  if (cleanParts.length === 0) {
    return new File(baseDir, 'unknown');
  }
  const fileName = cleanParts[cleanParts.length - 1];
  const dirParts = cleanParts.slice(0, -1);
  if (dirParts.length === 0) {
    return new File(baseDir, fileName);
  }
  const subDir = new Directory(baseDir, ...dirParts);
  return new File(subDir, fileName);
};

const computeDeterministicChecksum = (databaseJson: string, fileEntries: BackupFileEntry[]): string => {
  const sortedEntries = [...fileEntries].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath)
  );
  const manifestInput = `${databaseJson}|${JSON.stringify(
    sortedEntries.map((e) => `${e.relativePath}:${e.size}`)
  )}`;

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

const isMetaFile = (name: string): boolean =>
  name === '.project_meta.json' || name === '.report_meta.json';

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

/**
 * Merges `srcDir` into `destDir` file-by-file without deleting existing unrelated files
 * or skipping the directory when `destDir` already exists.
 */
const mergeCopyDirectory = (srcDir: Directory, destDir: Directory): void => {
  if (!srcDir.exists) return;
  destDir.create({ intermediates: true, idempotent: true });
  for (const entry of srcDir.list()) {
    if (entry instanceof Directory) {
      mergeCopyDirectory(entry, new Directory(destDir, entry.name));
    } else {
      const targetFile = new File(destDir, entry.name);
      if (isMetaFile(entry.name) && targetFile.exists) {
        // Never overwrite existing owner metadata during merge
        continue;
      }
      if (!targetFile.exists || (typeof targetFile.size === 'number' && targetFile.size === 0)) {
        if (targetFile.exists) {
          targetFile.delete();
        }
        entry.copy(targetFile);
      }
    }
  }
};

const collectDirectoryFiles = (
  dir: Directory,
  baseRelative: string,
  includeMeta = false
): BackupFileEntry[] => {
  if (!dir.exists) return [];
  const entries: BackupFileEntry[] = [];
  for (const item of dir.list()) {
    const rel = baseRelative ? `${baseRelative}/${item.name}` : item.name;
    if (item instanceof Directory) {
      entries.push(...collectDirectoryFiles(item, rel, includeMeta));
    } else {
      if (!includeMeta && isMetaFile(item.name)) continue;
      entries.push({
        name: item.name,
        relativePath: rel,
        size: typeof item.size === 'number' ? item.size : 0,
      });
    }
  }
  return entries;
};

const indexExtractedFiles = (
  dir: Directory,
  baseRelative: string,
  byRelPath: Map<string, File>,
  byFilename: Map<string, File[]>
): void => {
  if (!dir.exists) return;
  for (const item of dir.list()) {
    const rel = baseRelative ? `${baseRelative}/${item.name}` : item.name;
    if (item instanceof Directory) {
      indexExtractedFiles(item, rel, byRelPath, byFilename);
    } else {
      byRelPath.set(rel.toLowerCase(), item);
      const lowerName = item.name.toLowerCase();
      const existing = byFilename.get(lowerName);
      if (existing) {
        existing.push(item);
      } else {
        byFilename.set(lowerName, [item]);
      }
    }
  }
};

const findFileRecursiveByName = (dir: Directory, targetName: string): File | null => {
  if (!dir.exists) return null;
  const lower = targetName.toLowerCase();
  for (const item of dir.list()) {
    if (item instanceof Directory) {
      const found = findFileRecursiveByName(item, targetName);
      if (found) return found;
    } else if (item.name.toLowerCase() === lower) {
      return item;
    }
  }
  return null;
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
    .filter((f) => !isMetaFile(f.name))
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

const isSameBackupAuthor = (
  local: { authorId?: string | null; authorName?: string | null },
  incoming: { authorId?: string | null; authorName?: string | null }
): boolean => {
  const localId = deriveAuthorId(local.authorId);
  const incomingId = deriveAuthorId(incoming.authorId);
  if (localId && incomingId) {
    return localId === incomingId;
  }
  const localName = (local.authorName || '').trim().toLowerCase();
  const incomingName = (incoming.authorName || '').trim().toLowerCase();
  if (!localName || !incomingName) return false;
  return localName === incomingName;
};

/**
 * Creates a tamper-resistant full backup `.zip` containing SQLite JSON export,
 * all `HousingInspection` project/report folders, legacy folders, and a checksummed `manifest.json`.
 * Never overwrites existing original author attribution on projects or reports.
 */
export const createFullBackup = async (
  db: SQLite.SQLiteDatabase,
  officialName: string,
  onProgress?: BackupProgressCallback,
  officialAuthorId?: string | null
): Promise<CreateBackupResult> => {
  const cleanOfficialName = officialName.trim();
  if (!cleanOfficialName) {
    throw new Error('Official Name is required to sign the backup.');
  }
  const cleanAuthorId = deriveAuthorId(officialAuthorId);

  onProgress?.('Flushing database journal...', 4);
  await db.execAsync('PRAGMA wal_checkpoint(TRUNCATE);');

  onProgress?.('Preserving original attribution...', 10);
  // Only backfill records that have NEITHER author_id NOR author_name
  await db.runAsync(
    `UPDATE photos
     SET author_name = COALESCE(NULLIF(TRIM(author_name), ''), ?),
         author_id = COALESCE(NULLIF(TRIM(author_id), ''), ?)
     WHERE (author_name IS NULL OR TRIM(author_name) = '')
       AND (author_id IS NULL OR TRIM(author_id) = '')`,
    [cleanOfficialName, cleanAuthorId || null]
  );

  await db.runAsync(
    `UPDATE reports
     SET author_name = COALESCE(NULLIF(TRIM(author_name), ''), ?),
         author_id = COALESCE(NULLIF(TRIM(author_id), ''), ?)
     WHERE (author_name IS NULL OR TRIM(author_name) = '')
       AND (author_id IS NULL OR TRIM(author_id) = '')`,
    [cleanOfficialName, cleanAuthorId || null]
  );

  const inspectedBeneficiaries = await db.getAllAsync<BackupBeneficiaryRow>(
    `SELECT DISTINCT b.*
     FROM beneficiaries b
     WHERE b.is_custom = 1
        OR EXISTS (SELECT 1 FROM photos p WHERE p.beneficiary_code = b.code)
        OR EXISTS (SELECT 1 FROM reports r WHERE r.beneficiary_code = b.code)
     ORDER BY b.code ASC`
  );

  const totalInspected = Math.max(1, inspectedBeneficiaries.length);
  for (let i = 0; i < inspectedBeneficiaries.length; i++) {
    const b = inspectedBeneficiaries[i];
    const pct = 10 + Math.round(((i + 1) / totalInspected) * 15);
    onProgress?.(`Preparing project metadata (${i + 1}/${totalInspected})...`, pct);

    const hasOwnAuthor = Boolean(
      (b.author_name && b.author_name.trim().length > 0) ||
      (b.author_id && b.author_id.trim().length > 0)
    );
    if (!hasOwnAuthor) {
      await db.runAsync(
        `UPDATE beneficiaries SET author_name = ?, author_id = ? WHERE code = ?`,
        [cleanOfficialName, cleanAuthorId || null, b.code]
      );
      b.author_name = cleanOfficialName;
      b.author_id = cleanAuthorId || null;
    }

    const projectDir = getProjectDirectory(b.code);
    if (projectDir.exists) {
      const existingMeta = await readProjectMeta(projectDir);
      await writeProjectMeta(projectDir, {
        beneficiaryCode: b.code,
        originalCode: b.original_code || existingMeta?.originalCode || b.code,
        authorId: existingMeta?.authorId?.trim() || b.author_id?.trim() || cleanAuthorId || undefined,
        authorName: existingMeta?.authorName?.trim() || b.author_name?.trim() || cleanOfficialName,
        createdAt: existingMeta?.createdAt || b.last_updated || new Date().toISOString(),
        updatedAt: existingMeta?.updatedAt || new Date().toISOString(),
        preserveExistingOwner: true,
      });
    }
  }

  onProgress?.('Exporting database records...', 30);
  const allReports = await db.getAllAsync<BackupReportRow>(
    `SELECT * FROM reports ORDER BY created_at ASC`
  );
  const allPhotos = await db.getAllAsync<BackupPhotoRow>(
    `SELECT * FROM photos ORDER BY created_at ASC`
  );
  const appMetadata = await db.getAllAsync<BackupAppMetadataRow>(
    `SELECT key, value FROM app_metadata`
  );

  onProgress?.('Staging project files & photos...', 40);
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
      }
    }
  }

  // Guarantee every DB photo file is present inside staging `files/`
  const exportedPhotos: BackupPhotoRow[] = [];
  const totalPhotos = Math.max(1, allPhotos.length);
  for (let i = 0; i < allPhotos.length; i++) {
    const p = allPhotos[i];
    if (i % 5 === 0 || i === allPhotos.length - 1) {
      const pct = 45 + Math.round(((i + 1) / totalPhotos) * 20);
      onProgress?.(`Verifying photo ${i + 1} of ${allPhotos.length}...`, pct);
    }

    let relPath = toRelativeDocumentPath(p.local_uri);
    let stagedFile = resolveRelativeFileInDir(filesRootDir, relPath);

    if (!stagedFile.exists) {
      const directFile = new File(p.local_uri.split('?')[0]);
      const fallbackDocFile = resolveRelativeToDocumentFile(relPath);
      const sourceFile = directFile.exists
        ? directFile
        : fallbackDocFile.exists
        ? fallbackDocFile
        : findFileRecursiveByName(getProjectDirectory(p.beneficiary_code), p.filename);

      if (sourceFile && sourceFile.exists) {
        const safeCodeDir = getSafeCodeDirName(p.beneficiary_code);
        const destSubDir = p.report_id
          ? new Directory(filesRootDir, 'HousingInspection', safeCodeDir, getSafeCodeDirName(p.report_id))
          : new Directory(filesRootDir, 'HousingInspection', safeCodeDir);
        destSubDir.create({ intermediates: true, idempotent: true });
        const copiedTarget = new File(destSubDir, p.filename);
        if (copiedTarget.exists) copiedTarget.delete();
        sourceFile.copy(copiedTarget);
        relPath = p.report_id
          ? `HousingInspection/${safeCodeDir}/${getSafeCodeDirName(p.report_id)}/${p.filename}`
          : `HousingInspection/${safeCodeDir}/${p.filename}`;
      }
    }

    exportedPhotos.push({
      ...p,
      local_uri: relPath,
      author_id: p.author_id?.trim() || null,
      author_name: p.author_name?.trim() || cleanOfficialName,
    });
  }

  const projectFiles: Record<string, BackupFileEntry[]> = {};
  for (const b of inspectedBeneficiaries) {
    const safeDirName = getSafeCodeDirName(b.code);
    const stagedProjectDir = new Directory(filesRootDir, 'HousingInspection', safeDirName);
    projectFiles[b.code] = collectDirectoryFiles(
      stagedProjectDir,
      `HousingInspection/${safeDirName}`
    );
  }

  const allFileEntries = collectDirectoryFiles(filesRootDir, '');

  const databasePayload: BackupDatabasePayload = {
    beneficiaries: inspectedBeneficiaries,
    reports: allReports,
    photos: exportedPhotos,
    appMetadata,
    projectFiles,
  };
  const databaseJsonString = JSON.stringify(databasePayload, null, 2);

  onProgress?.('Generating tamper-resistant manifest...', 72);
  new File(stagingDir, 'database.json').write(databaseJsonString);

  const checksum = computeDeterministicChecksum(databaseJsonString, allFileEntries);
  const manifest: BackupManifest = {
    backupVersion: 2,
    appVersion: Constants.expoConfig?.version || '1.0.0',
    channel: Updates.channel || 'development',
    createdAt: new Date().toISOString(),
    signedByAuthor: cleanOfficialName,
    signedByAuthorId: cleanAuthorId || undefined,
    checksum,
  };
  new File(stagingDir, 'manifest.json').write(JSON.stringify(manifest, null, 2));

  onProgress?.('Compressing backup archive...', 84);
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
 * and restores projects, reports, photos, notes, and original author metadata without
 * overwriting existing ownership or inserting broken/missing images.
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

  onProgress?.('Reading selected backup archive...', 8);
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
    onProgress?.('Extracting backup archive...', 20);
    await unzip(tempZipFile.uri, restoreStagingDir.uri);

    const manifestFile = new File(restoreStagingDir, 'manifest.json');
    const databaseFile = new File(restoreStagingDir, 'database.json');
    if (!manifestFile.exists || !databaseFile.exists) {
      throw new Error('Invalid backup archive: missing manifest.json or database.json.');
    }

    onProgress?.('Verifying backup integrity...', 34);
    const manifest = JSON.parse(await manifestFile.text()) as BackupManifest;
    const databaseJsonString = await databaseFile.text();
    const dbPayload = JSON.parse(databaseJsonString) as BackupDatabasePayload;

    if (!manifest.checksum || !Array.isArray(dbPayload.beneficiaries) || !Array.isArray(dbPayload.photos)) {
      throw new Error('Backup metadata is malformed.');
    }

    const filesRootDir = new Directory(restoreStagingDir, 'files');

    // Support both v2 full-tree checksum and legacy v1 projectFiles checksum
    const allExtractedEntries = collectDirectoryFiles(filesRootDir, '');
    const checksumV2 = computeDeterministicChecksum(databaseJsonString, allExtractedEntries);

    const legacyEntries: BackupFileEntry[] = [];
    const housingExtractedDir = new Directory(filesRootDir, 'HousingInspection');
    if (housingExtractedDir.exists) {
      for (const b of dbPayload.beneficiaries) {
        const expectedRelFiles = dbPayload.projectFiles?.[b.code] || [];
        for (const f of expectedRelFiles) {
          legacyEntries.push(f);
        }
      }
    }
    if (filesRootDir.exists) {
      for (const item of filesRootDir.list()) {
        if (item instanceof Directory && item.name !== 'HousingInspection') {
          legacyEntries.push(...collectDirectoryFiles(item, item.name));
        }
      }
    }
    const checksumV1 = computeDeterministicChecksum(databaseJsonString, legacyEntries);

    if (checksumV2 !== manifest.checksum && checksumV1 !== manifest.checksum) {
      throw new Error('Backup integrity check failed: the archive may have been modified or corrupted.');
    }

    const extractedByRelPath = new Map<string, File>();
    const extractedByFilename = new Map<string, File[]>();
    if (filesRootDir.exists) {
      indexExtractedFiles(filesRootDir, '', extractedByRelPath, extractedByFilename);
    }

    // Merge all legacy folders file-by-file (do NOT skip if target folder already exists)
    onProgress?.('Merging legacy media folders...', 42);
    if (filesRootDir.exists) {
      for (const item of filesRootDir.list()) {
        if (!(item instanceof Directory)) continue;
        if (item.name === 'HousingInspection' || EXCLUDED_ROOT_DIRS.has(item.name)) continue;
        const targetLegacyDir = new Directory(Paths.document, item.name);
        mergeCopyDirectory(item, targetLegacyDir);
      }
    }

    const resolveExtractedSourceFile = (
      photo: BackupPhotoRow,
      sourceProjectDir: Directory
    ): File | null => {
      const rel = toRelativeDocumentPath(photo.local_uri);
      const exact = extractedByRelPath.get(rel.toLowerCase());
      if (exact && exact.exists) return exact;

      if (photo.report_id) {
        const inReport = new File(
          new Directory(sourceProjectDir, getSafeCodeDirName(photo.report_id)),
          photo.filename
        );
        if (inReport.exists) return inReport;
      }

      const inProjectRoot = new File(sourceProjectDir, photo.filename);
      if (inProjectRoot.exists) return inProjectRoot;

      const foundInProject = findFileRecursiveByName(sourceProjectDir, photo.filename);
      if (foundInProject && foundInProject.exists) return foundInProject;

      const byNameCandidates = extractedByFilename.get(photo.filename.toLowerCase());
      if (byNameCandidates && byNameCandidates.length > 0) {
        const valid = byNameCandidates.find((f) => f.exists);
        if (valid) return valid;
      }

      return null;
    };

    const readFirstNoteText = async (dir: Directory): Promise<{ text: string; filename: string } | null> => {
      if (!dir.exists) return null;
      for (const entry of dir.list()) {
        if (!(entry instanceof Directory) && entry.name.endsWith('_Notes.txt')) {
          try {
            const text = await entry.text();
            return { text, filename: entry.name };
          } catch {
            return null;
          }
        }
      }
      return null;
    };

    let projectsRestored = 0;
    let projectsSkipped = 0;
    let photosRestored = 0;
    const authorsSet = new Set<string>();

    const totalProjects = Math.max(1, dbPayload.beneficiaries.length);

    for (let i = 0; i < dbPayload.beneficiaries.length; i++) {
      const b = dbPayload.beneficiaries[i];
      const pct = 45 + Math.round(((i + 1) / totalProjects) * 50);
      onProgress?.(`Restoring project ${i + 1} of ${totalProjects}...`, pct);

      const hasExplicitAuthor = Boolean(
        (b.author_name && b.author_name.trim().length > 0) ||
        (b.author_id && b.author_id.trim().length > 0)
      );
      const backupAuthorId =
        b.author_id?.trim() ||
        (!hasExplicitAuthor ? manifest.signedByAuthorId?.trim() : '') ||
        '';
      const backupAuthorName =
        b.author_name?.trim() ||
        (!hasExplicitAuthor ? manifest.signedByAuthor : '') ||
        'Field Agent';

      authorsSet.add(backupAuthorName);
      const trueOriginalCode = b.original_code?.trim() || b.code;

      const bReports = (dbPayload.reports || []).filter((r) => r.beneficiary_code === b.code);
      const bPhotos = dbPayload.photos.filter((p) => p.beneficiary_code === b.code);
      const bFiles = dbPayload.projectFiles?.[b.code] || [];

      const sourceProjectDir = new Directory(
        filesRootDir,
        'HousingInspection',
        getSafeCodeDirName(b.code)
      );

      // Find any existing beneficiary row matching trueOriginalCode or b.code
      const existingRows = await db.getAllAsync<BackupBeneficiaryRow>(
        `SELECT * FROM beneficiaries WHERE code = ? OR code = ? OR original_code = ?`,
        [trueOriginalCode, b.code, trueOriginalCode]
      );

      const existingPrimary =
        existingRows.find((r) => r.code === trueOriginalCode) ||
        existingRows.find((r) => r.code === b.code) ||
        existingRows[0] ||
        null;

      const targetCode = existingPrimary?.code || trueOriginalCode;
      const targetOriginalCode = existingPrimary?.original_code || trueOriginalCode;
      const destProjectDir = getProjectDirectory(targetCode);
      destProjectDir.create({ intermediates: true, idempotent: true });

      const existingHasInspection = existingPrimary
        ? Boolean(
            existingPrimary.is_custom === 1 ||
              (await db.getFirstAsync<{ cnt: number }>(
                `SELECT COUNT(*) as cnt FROM photos WHERE beneficiary_code = ?`,
                [targetCode]
              ))?.cnt ||
              (await db.getFirstAsync<{ cnt: number }>(
                `SELECT COUNT(*) as cnt FROM reports WHERE beneficiary_code = ?`,
                [targetCode]
              ))?.cnt
          )
        : false;

      // Preserve existing owner if the local project already has an inspection
      await db.runAsync(
        `INSERT INTO beneficiaries (
          code, original_code, name, serial_number, mobile_number, aadhar_number,
          bank_name, account_number, amount, district_name, city_name,
          annexure_id, father_name, project_name, site_address,
          inspection_status, sync_status, is_custom, author_id, author_name, last_updated
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET
          original_code = COALESCE(beneficiaries.original_code, excluded.original_code),
          name = COALESCE(NULLIF(beneficiaries.name, ''), excluded.name),
          serial_number = COALESCE(NULLIF(beneficiaries.serial_number, ''), excluded.serial_number),
          mobile_number = COALESCE(NULLIF(beneficiaries.mobile_number, ''), excluded.mobile_number),
          aadhar_number = COALESCE(NULLIF(beneficiaries.aadhar_number, ''), excluded.aadhar_number),
          bank_name = COALESCE(NULLIF(beneficiaries.bank_name, ''), excluded.bank_name),
          account_number = COALESCE(NULLIF(beneficiaries.account_number, ''), excluded.account_number),
          amount = COALESCE(NULLIF(beneficiaries.amount, ''), excluded.amount),
          district_name = COALESCE(NULLIF(beneficiaries.district_name, ''), excluded.district_name),
          city_name = COALESCE(NULLIF(beneficiaries.city_name, ''), excluded.city_name),
          annexure_id = COALESCE(NULLIF(beneficiaries.annexure_id, ''), excluded.annexure_id),
          father_name = COALESCE(NULLIF(beneficiaries.father_name, ''), excluded.father_name),
          project_name = COALESCE(NULLIF(beneficiaries.project_name, ''), excluded.project_name),
          site_address = COALESCE(NULLIF(beneficiaries.site_address, ''), excluded.site_address),
          inspection_status = CASE WHEN ? = 1 THEN beneficiaries.inspection_status ELSE excluded.inspection_status END,
          is_custom = MAX(COALESCE(beneficiaries.is_custom, 0), COALESCE(excluded.is_custom, 0)),
          author_id = COALESCE(NULLIF(TRIM(beneficiaries.author_id), ''), excluded.author_id),
          author_name = COALESCE(NULLIF(TRIM(beneficiaries.author_name), ''), excluded.author_name),
          last_updated = COALESCE(beneficiaries.last_updated, excluded.last_updated)`,
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
          backupAuthorId || null,
          backupAuthorName,
          b.last_updated || new Date().toISOString(),
          existingHasInspection ? 1 : 0,
        ]
      );

      // Write .project_meta.json ONLY preserving original owner
      await writeProjectMeta(destProjectDir, {
        beneficiaryCode: targetCode,
        originalCode: targetOriginalCode,
        authorId: backupAuthorId || undefined,
        authorName: backupAuthorName,
        createdAt: b.last_updated || manifest.createdAt,
        updatedAt: new Date().toISOString(),
        preserveExistingOwner: true,
      });

      if (bReports.length > 0) {
        // V2 backup: restore each report into its own subdirectory
        let restoredAnyInProject = false;

        for (const r of bReports) {
          const rAuthorId = r.author_id?.trim() || backupAuthorId;
          const rAuthorName = r.author_name?.trim() || backupAuthorName;
          authorsSet.add(rAuthorName);

          const rPhotos = bPhotos.filter((p) => p.report_id === r.id);
          const srcReportDir = new Directory(sourceProjectDir, getSafeCodeDirName(r.id));
          const incomingReportFiles = collectDirectoryFiles(
            srcReportDir,
            `HousingInspection/${getSafeCodeDirName(b.code)}/${getSafeCodeDirName(r.id)}`
          );

          const existingReport = await db.getFirstAsync<BackupReportRow>(
            `SELECT * FROM reports WHERE id = ?`,
            [r.id]
          );
          if (existingReport) {
            const localReportDir = getReportDirectory(targetCode, r.id);
            const localReportFiles = collectDirectoryFiles(localReportDir, '');
            if (areFileSignaturesEqual(localReportFiles, incomingReportFiles)) {
              continue;
            }
          }

          // Check author + file-signature duplicate against existing reports on targetCode
          const existingTargetReports = await db.getAllAsync<BackupReportRow>(
            `SELECT * FROM reports WHERE beneficiary_code = ?`,
            [targetCode]
          );
          let duplicateReport = false;
          for (const er of existingTargetReports) {
            if (!isSameBackupAuthor(
              { authorId: er.author_id, authorName: er.author_name },
              { authorId: rAuthorId, authorName: rAuthorName }
            )) {
              continue;
            }
            const localReportDir = getReportDirectory(targetCode, er.id);
            const localFiles = collectDirectoryFiles(localReportDir, '');
            if (areFileSignaturesEqual(localFiles, incomingReportFiles)) {
              duplicateReport = true;
              break;
            }
          }
          if (duplicateReport) {
            continue;
          }

          const destReportId = existingReport
            ? generateReportId(`${r.id}_${rAuthorName}_${manifest.createdAt}`)
            : r.id;
          const destReportDir = getReportDirectory(targetCode, destReportId);
          if (srcReportDir.exists) {
            mergeCopyDirectory(srcReportDir, destReportDir);
          } else {
            destReportDir.create({ intermediates: true, idempotent: true });
          }

          if (r.notes && r.note_filename) {
            const noteFile = new File(destReportDir, r.note_filename);
            if (!noteFile.exists) {
              noteFile.write(r.notes);
            }
          }

          await writeReportMeta(destReportDir, {
            reportId: destReportId,
            beneficiaryCode: targetCode,
            authorId: rAuthorId || undefined,
            authorName: rAuthorName,
            originalAuthorId: r.original_author_id?.trim() || undefined,
            originalAuthorName: r.original_author_name?.trim() || undefined,
            isEditedCopy: Boolean(r.is_edited_copy),
            parentReportId: r.parent_report_id || undefined,
            createdAt: r.created_at || b.last_updated || manifest.createdAt,
            updatedAt: r.updated_at || r.created_at || new Date().toISOString(),
          });

          await db.runAsync(
            `INSERT OR IGNORE INTO reports (
              id, beneficiary_code, author_id, author_name,
              original_author_id, original_author_name,
              notes, note_filename, is_edited_copy, parent_report_id,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              destReportId,
              targetCode,
              rAuthorId || null,
              rAuthorName,
              r.original_author_id || null,
              r.original_author_name || null,
              r.notes || null,
              r.note_filename || null,
              r.is_edited_copy ?? 0,
              r.parent_report_id || null,
              r.created_at || new Date().toISOString(),
              r.updated_at || r.created_at || new Date().toISOString(),
            ]
          );

          for (const photo of rPhotos) {
            const destPhotoFile = new File(destReportDir, photo.filename);
            if (!destPhotoFile.exists || destPhotoFile.size === 0) {
              const srcFile = resolveExtractedSourceFile(photo, sourceProjectDir);
              if (srcFile && srcFile.exists) {
                if (destPhotoFile.exists) destPhotoFile.delete();
                srcFile.copy(destPhotoFile);
              }
            }
            if (!destPhotoFile.exists) {
              continue;
            }

            const photoId =
              destReportId !== r.id
                ? `${photo.id}_${makeShortSuffix(destReportId)}`
                : photo.id;

            await db.runAsync(
              `INSERT OR REPLACE INTO photos (
                id, beneficiary_code, report_id, local_uri, filename, latitude, longitude,
                notes, author_id, author_name, sync_status, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                photoId,
                targetCode,
                destReportId,
                destPhotoFile.uri,
                photo.filename,
                photo.latitude,
                photo.longitude,
                photo.notes,
                photo.author_id?.trim() || rAuthorId || null,
                photo.author_name?.trim() || rAuthorName,
                photo.sync_status || 'local_only',
                photo.created_at || new Date().toISOString(),
              ]
            );
            photosRestored++;
          }

          restoredAnyInProject = true;
        }

        // Handle any orphan photos in v2 backup without report_id
        const orphanPhotos = bPhotos.filter((p) => !p.report_id);
        for (const photo of orphanPhotos) {
          const destPhotoFile = resolveRelativeToDocumentFile(toRelativeDocumentPath(photo.local_uri));
          if (!destPhotoFile.exists) {
            const srcFile = resolveExtractedSourceFile(photo, sourceProjectDir);
            if (srcFile && srcFile.exists) {
              destPhotoFile.parentDirectory.create({ intermediates: true, idempotent: true });
              srcFile.copy(destPhotoFile);
            }
          }
          if (!destPhotoFile.exists) continue;
          await db.runAsync(
            `INSERT OR REPLACE INTO photos (
              id, beneficiary_code, report_id, local_uri, filename, latitude, longitude,
              notes, author_id, author_name, sync_status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              photo.id,
              targetCode,
              null,
              destPhotoFile.uri,
              photo.filename,
              photo.latitude,
              photo.longitude,
              photo.notes,
              photo.author_id?.trim() || backupAuthorId || null,
              photo.author_name?.trim() || backupAuthorName,
              photo.sync_status || 'local_only',
              photo.created_at || new Date().toISOString(),
            ]
          );
          photosRestored++;
          restoredAnyInProject = true;
        }

        if (restoredAnyInProject) projectsRestored++;
        else projectsSkipped++;
      } else {
        // V1 legacy backup: restore into its own report subdirectory to isolate & prevent conflicts
        const existingLocalReports = await db.getAllAsync<BackupReportRow>(
          `SELECT * FROM reports WHERE beneficiary_code = ?`,
          [targetCode]
        );

        let isExactDuplicate = false;
        for (const lr of existingLocalReports) {
          if (!isSameBackupAuthor(
            { authorId: lr.author_id, authorName: lr.author_name },
            { authorId: backupAuthorId, authorName: backupAuthorName }
          )) {
            continue;
          }
          const lrDir = getReportDirectory(targetCode, lr.id);
          const lrFiles = collectDirectoryFiles(lrDir, '');
          if (areFileSignaturesEqual(lrFiles, bFiles)) {
            isExactDuplicate = true;
            break;
          }
        }

        if (!isExactDuplicate && existingPrimary && isSameBackupAuthor(
          { authorId: existingPrimary.author_id, authorName: existingPrimary.author_name },
          { authorId: backupAuthorId, authorName: backupAuthorName }
        )) {
          const flatFiles = collectDirectoryFiles(destProjectDir, '');
          if (areFileSignaturesEqual(flatFiles, bFiles)) {
            isExactDuplicate = true;
          }
        }

        if (isExactDuplicate) {
          projectsSkipped++;
          continue;
        }

        const reportId = `rpt_${makeShortSuffix(`${b.code}_${backupAuthorName}_${manifest.createdAt}_${i}`)}`;
        const destReportDir = getReportDirectory(targetCode, reportId);
        destReportDir.create({ intermediates: true, idempotent: true });

        const noteInfo = await readFirstNoteText(sourceProjectDir);
        if (noteInfo) {
          const destNoteFile = new File(destReportDir, noteInfo.filename);
          destNoteFile.write(noteInfo.text);
        }

        const earliestPhotoTime = bPhotos[0]?.created_at || b.last_updated || manifest.createdAt;
        const latestPhotoTime =
          bPhotos[bPhotos.length - 1]?.created_at || b.last_updated || manifest.createdAt;

        await writeReportMeta(destReportDir, {
          reportId,
          beneficiaryCode: targetCode,
          authorId: backupAuthorId || undefined,
          authorName: backupAuthorName,
          createdAt: earliestPhotoTime,
          updatedAt: latestPhotoTime,
        });

        await db.runAsync(
          `INSERT OR REPLACE INTO reports (
            id, beneficiary_code, author_id, author_name,
            notes, note_filename, is_edited_copy, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          [
            reportId,
            targetCode,
            backupAuthorId || null,
            backupAuthorName,
            noteInfo?.text || null,
            noteInfo?.filename || null,
            earliestPhotoTime,
            latestPhotoTime,
          ]
        );

        for (const photo of bPhotos) {
          const destPhotoFile = new File(destReportDir, photo.filename);
          const srcFile = resolveExtractedSourceFile(photo, sourceProjectDir);
          if (srcFile && srcFile.exists) {
            if (destPhotoFile.exists) destPhotoFile.delete();
            srcFile.copy(destPhotoFile);
          }

          if (!destPhotoFile.exists) {
            continue;
          }

          const photoId = `${photo.id}_${makeShortSuffix(reportId)}`;
          await db.runAsync(
            `INSERT OR REPLACE INTO photos (
              id, beneficiary_code, report_id, local_uri, filename, latitude, longitude,
              notes, author_id, author_name, sync_status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              photoId,
              targetCode,
              reportId,
              destPhotoFile.uri,
              photo.filename,
              photo.latitude,
              photo.longitude,
              photo.notes,
              photo.author_id?.trim() || backupAuthorId || null,
              photo.author_name?.trim() || backupAuthorName,
              photo.sync_status || 'local_only',
              photo.created_at || new Date().toISOString(),
            ]
          );
          photosRestored++;
        }

        projectsRestored++;
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
