import { Directory, File, Paths } from 'expo-file-system';
import * as SQLite from 'expo-sqlite';
import * as XLSX from 'xlsx';
import { zip } from 'react-native-zip-archive';
import { getProjectDirectory, getSafeCodeDirName, readProjectMeta } from './authorHelpers';

export const generatePhotoFilename = (
  srNo: string | number,
  beneficiaryName: string,
  beneficiaryCode: string,
  currentPhotoIndex: number
): string => {
  const cleanSr = srNo ? String(srNo).trim() : '00';
  const cleanName = beneficiaryName ? String(beneficiaryName).trim().replace(/[^a-zA-Z0-9 ]/g, '') : 'UNKNOWN';
  const cleanCode = beneficiaryCode ? String(beneficiaryCode).trim().replace(/[\\/:*?"<>|]/g, '_') : 'NO_CODE';
  
  // First photo has no suffix. Second photo becomes _2, third becomes _3, etc.
  const suffix = currentPhotoIndex === 0 ? '' : `_${currentPhotoIndex + 1}`;
  return `${cleanSr}. ${cleanName} ${cleanCode}${suffix}.jpg`;
};

// Deep copy helper for legacy directories
const recursiveCopy = (srcDir: Directory, destDir: Directory) => {
  destDir.create({ intermediates: true, idempotent: true });
  for (const entry of srcDir.list()) {
    if (entry instanceof Directory) {
      recursiveCopy(entry, new Directory(destDir, entry.name));
    } else {
      const targetFile = new File(destDir, entry.name);
      if (targetFile.exists) {
        targetFile.delete();
      }
      entry.copy(targetFile);
    }
  }
};

export interface ShareableProjectInput {
  code: string;
  name?: string | null;
  is_legacy?: boolean;
  exact_path?: string;
}

interface ShareBeneficiaryRow {
  code: string;
  original_code: string | null;
  name: string | null;
  serial_number: string | null;
  annexure_id: string | null;
  project_name: string | null;
  father_name: string | null;
  city_name: string | null;
  district_name: string | null;
  site_address: string | null;
  author_id: string | null;
  author_name: string | null;
  last_updated: string | null;
}

interface ShareReportRow {
  id: string;
  beneficiary_code: string;
  author_id: string | null;
  author_name: string | null;
  original_author_id: string | null;
  original_author_name: string | null;
  notes: string | null;
  note_filename: string | null;
  is_edited_copy: number | null;
  parent_report_id: string | null;
  created_at: string | null;
  updated_at: string | null;
}

interface SharePhotoRow {
  id: string;
  beneficiary_code: string;
  report_id: string | null;
  local_uri: string;
  filename: string;
  latitude: string | null;
  longitude: string | null;
  author_id: string | null;
  author_name: string | null;
  created_at: string | null;
}

/**
 * Compiles one or more projects' photos, inspection notes, and non-mutated metadata
 * into a shareable `.zip` archive in `Paths.cache`.
 */
export const shareProjectsZipArchive = async (
  db: SQLite.SQLiteDatabase,
  items: ShareableProjectInput[],
  onProgress?: (msg: string, percentage: number) => void,
  cancelRef?: { current: boolean }
): Promise<string | null> => {
  if (!items || items.length === 0) return null;

  const stagingDir = new Directory(Paths.cache, 'Share_Projects_Staging');
  if (stagingDir.exists) {
    stagingDir.delete();
  }
  stagingDir.create({ intermediates: true, idempotent: true });

  const total = items.length;
  let sharedContentCount = 0;

  const hasAnyFiles = (dir: Directory): boolean => {
    if (!dir.exists) return false;
    for (const entry of dir.list()) {
      if (entry instanceof Directory) {
        if (hasAnyFiles(entry)) return true;
      } else {
        return true;
      }
    }
    return false;
  };

  for (let i = 0; i < total; i++) {
    if (cancelRef?.current) throw new Error('Cancelled by user');
    const item = items[i];
    onProgress?.(
      `Packaging project ${i + 1} of ${total}...`,
      Math.round(((i + 1) / total) * 75)
    );

    if (item.is_legacy && item.exact_path) {
      const legacySourceDir = new Directory(item.exact_path);
      if (hasAnyFiles(legacySourceDir)) {
        const legDirName = getSafeCodeDirName(item.code);
        const destDir = new Directory(stagingDir, legDirName);
        recursiveCopy(legacySourceDir, destDir);
        sharedContentCount++;
      }
      continue;
    }

    const b = await db.getFirstAsync<ShareBeneficiaryRow>(
      `SELECT code, original_code, name, serial_number, annexure_id, project_name,
              father_name, city_name, district_name, site_address, author_id, author_name, last_updated
       FROM beneficiaries WHERE code = ?`,
      [item.code]
    );

    if (!b) continue;

    const projectDir = getProjectDirectory(b.code);
    const projectMeta = projectDir.exists ? await readProjectMeta(projectDir) : null;
    const reports = await db.getAllAsync<ShareReportRow>(
      `SELECT * FROM reports WHERE beneficiary_code = ? ORDER BY created_at DESC`,
      [b.code]
    );
    const photos = await db.getAllAsync<SharePhotoRow>(
      `SELECT * FROM photos WHERE beneficiary_code = ? ORDER BY created_at DESC`,
      [b.code]
    );

    const safeCode = getSafeCodeDirName(b.code);
    const safeName = (b.name || 'Beneficiary').replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 32);
    const exportFolderName = safeName ? `${safeCode}_${safeName}` : safeCode;
    const destProjectDir = new Directory(stagingDir, exportFolderName);

    // Collect legacy flat notes if no report rows exist
    let legacyDiskNote: { filename: string; text: string } | null = null;
    if (projectDir.exists) {
      for (const entry of projectDir.list()) {
        if (!(entry instanceof Directory) && entry.name.endsWith('_Notes.txt')) {
          try {
            legacyDiskNote = { filename: entry.name, text: await entry.text() };
            break;
          } catch {
            // ignore read failure
          }
        }
      }
    }

    const existingPhotoFiles = photos.filter((p) => {
      try {
        return new File(p.local_uri.split('?')[0]).exists;
      } catch {
        return false;
      }
    });
    const hasReportNotes = reports.some((r) => Boolean(r.notes && r.notes.trim().length > 0));
    const hasLegacyNote = Boolean(legacyDiskNote && legacyDiskNote.text.trim().length > 0);
    if (existingPhotoFiles.length === 0 && !hasReportNotes && !hasLegacyNote) {
      continue;
    }

    sharedContentCount++;
    destProjectDir.create({ intermediates: true, idempotent: true });

    const metadataPayload = {
      beneficiary: {
        code: b.original_code || b.code,
        storageCode: b.code,
        name: b.name,
        annexureId: b.annexure_id,
        projectName: b.project_name,
        fatherName: b.father_name,
        city: b.city_name,
        district: b.district_name,
        siteAddress: b.site_address,
        originalAuthorId: projectMeta?.authorId || b.author_id || null,
        originalAuthorName: projectMeta?.authorName || b.author_name || null,
        lastUpdated: b.last_updated,
      },
      reports: reports.map((r) => ({
        reportId: r.id,
        authorId: r.author_id,
        authorName: r.author_name,
        originalAuthorId: r.original_author_id,
        originalAuthorName: r.original_author_name,
        isEditedCopy: Boolean(r.is_edited_copy),
        notes: r.notes,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    };
    new File(destProjectDir, 'metadata.json').write(JSON.stringify(metadataPayload, null, 2));

    if (reports.length > 0) {
      for (const r of reports) {
        const reportDir = new Directory(destProjectDir, getSafeCodeDirName(r.id));
        reportDir.create({ intermediates: true, idempotent: true });

        const reportPhotos = photos.filter((p) => p.report_id === r.id);
        for (const p of reportPhotos) {
          const srcFile = new File(p.local_uri.split('?')[0]);
          if (srcFile.exists) {
            const destFile = new File(reportDir, p.filename);
            if (destFile.exists) destFile.delete();
            srcFile.copy(destFile);
          }
        }

        if (r.notes && r.notes.trim().length > 0) {
          const noteName = r.note_filename || `${safeCode}_Notes.txt`;
          new File(reportDir, noteName).write(r.notes.trim());
        }
      }

      // Copy any legacy flat photos not assigned to a report_id
      for (const p of photos.filter((x) => !x.report_id)) {
        const srcFile = new File(p.local_uri.split('?')[0]);
        if (srcFile.exists) {
          const destFile = new File(destProjectDir, p.filename);
          if (destFile.exists) destFile.delete();
          srcFile.copy(destFile);
        }
      }
    } else {
      for (const p of photos) {
        const srcFile = new File(p.local_uri.split('?')[0]);
        if (srcFile.exists) {
          const destFile = new File(destProjectDir, p.filename);
          if (destFile.exists) destFile.delete();
          srcFile.copy(destFile);
        }
      }
      if (legacyDiskNote && legacyDiskNote.text.trim().length > 0) {
        new File(destProjectDir, legacyDiskNote.filename).write(legacyDiskNote.text.trim());
      }
    }
  }

  if (cancelRef?.current) throw new Error('Cancelled by user');
  if (sharedContentCount === 0) {
    if (stagingDir.exists) {
      stagingDir.delete();
    }
    return null;
  }
  onProgress?.('Compressing share package...', 85);

  const pad = (n: number) => String(n).padStart(2, '0');
  const now = new Date();
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(
    now.getHours()
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const prefix =
    items.length === 1 ? `${getSafeCodeDirName(items[0].code)}_Share` : 'Projects_Share';
  const targetZipFile = new File(Paths.cache, `${prefix}_${ts}.zip`);
  if (targetZipFile.exists) {
    targetZipFile.delete();
  }

  await zip(stagingDir.uri, targetZipFile.uri);
  if (stagingDir.exists) {
    stagingDir.delete();
  }

  onProgress?.('Ready to share!', 100);
  return targetZipFile.uri;
};

export interface ZipExportItem {
  code: string;
  name?: string | null;
  is_legacy?: boolean;
  exact_path?: string;
}

export const generateZipArchive = async (
  db: SQLite.SQLiteDatabase,
  items: ZipExportItem[], // Accepts full objects to distinguish legacy vs DB items
  fallbackCity: string,
  onProgress: (msg: string, percentage: number) => void,
  cancelRef: { current: boolean }
): Promise<string | null> => {
  try {
    if (!items || items.length === 0) return null;

    const stagingDir = new Directory(Paths.cache, 'Staging_Export');
    if (stagingDir.exists) {
      stagingDir.delete();
    }
    stagingDir.create({ intermediates: true, idempotent: true });

    // Separate Standard DB Items and Legacy/Manual Items
    const dbItems = items.filter(i => !i.is_legacy);
    const legacyItems = items.filter(i => i.is_legacy);

    let totalProcessed = 0;
    const totalItems = items.length;

    // --- PART 1: Process Database Items (Requires Excel & Renaming) ---
    if (dbItems.length > 0) {
      const placeholders = dbItems.map(() => '?').join(',');
      const query = `
        SELECT 
          b.code, 
          b.name, 
          b.site_address,
          COALESCE(NULLIF(b.city_name, ''), ?) as assigned_city,
          MIN(p.created_at) as earliest_photo
        FROM beneficiaries b
        INNER JOIN photos p ON p.beneficiary_code = b.code
        WHERE b.code IN (${placeholders})
        GROUP BY b.code
        ORDER BY assigned_city ASC, earliest_photo ASC
      `;

      const beneficiaries = await db.getAllAsync<{
        code: string;
        name: string | null;
        site_address: string | null;
        assigned_city: string;
        earliest_photo: string | null;
      }>(query, [fallbackCity, ...dbItems.map(i => i.code)]);

      const groupedByCity: Record<string, typeof beneficiaries> = {};
      for (const b of beneficiaries) {
        const city = b.assigned_city || 'Unspecified_City';
        if (!groupedByCity[city]) groupedByCity[city] = [];
        groupedByCity[city].push(b);
      }

      for (const city of Object.keys(groupedByCity)) {
        if (cancelRef.current) throw new Error("Cancelled by user");
        const safeCityName = city.replace(/[^a-zA-Z0-9 _-]/g, '_').trim();
        const cityDir = new Directory(stagingDir, safeCityName);
        cityDir.create({ intermediates: true, idempotent: true });

        const cityBeneficiaries = groupedByCity[city];
        const excelData = [];

        for (let i = 0; i < cityBeneficiaries.length; i++) {
          if (cancelRef.current) throw new Error("Cancelled by user");
          const b = cityBeneficiaries[i];
          const srNo = i + 1; 

          const photos = await db.getAllAsync<{ local_uri: string }>(
            `SELECT local_uri FROM photos WHERE beneficiary_code = ? ORDER BY created_at ASC`, [b.code]
          );

          let photoCount = 0;
          for (const photo of photos) {
            const photoFileName = generatePhotoFilename(srNo, b.name || '', b.code, photoCount);
            const sourcePhoto = new File(photo.local_uri.split('?')[0]);
            if (sourcePhoto.exists) {
              const destPhoto = new File(cityDir, photoFileName);
              if (destPhoto.exists) {
                destPhoto.delete();
              }
              sourcePhoto.copy(destPhoto);
              photoCount++;
            }
          }

          const newNameFormat = `${srNo}. ${b.name || ""}\n${b.code || ""}`.trim();

          excelData.push({
            "IDD": "", "PHASE": "", "S_No": srNo,
            "Application_ Number": b.code || "", "Name": b.name || "",
            "Mobile_No": "", "Address": b.site_address || "",
            "Account_No": "", "IFSC_Code": "", "Bank_Name": "",
            "Adharcard_Number ": "", "New_Name": newNameFormat
          });

          totalProcessed++;
          const pct = Math.round((totalProcessed / totalItems) * 70);
          onProgress(`Processing ${safeCityName}: ${i+1}/${cityBeneficiaries.length}`, pct);
        }

        const ws = XLSX.utils.json_to_sheet(excelData);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Inspection_Data");

        const wscols = [
          { wch: 10 }, { wch: 10 }, { wch: 8 }, { wch: 25 },
          { wch: 30 }, { wch: 15 }, { wch: 40 }, { wch: 20 },
          { wch: 15 }, { wch: 20 }, { wch: 20 }, { wch: 35 }
        ];
        ws['!cols'] = wscols;
        const wbout = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
        
        const excelFileName = `${safeCityName}_Export.xlsx`;
        const excelFile = new File(cityDir, excelFileName);
        excelFile.write(wbout, { encoding: 'base64' });
      }
    }

    // --- PART 2: Process Legacy Items (Exact Directory Copy, No Excel) ---
    if (legacyItems.length > 0) {
      for (let i = 0; i < legacyItems.length; i++) {
        if (cancelRef.current) throw new Error("Cancelled by user");
        const leg = legacyItems[i];
        
        // Use the exact folder name as it was
        const legDirName = leg.code.replace(/[^a-zA-Z0-9 _-]/g, '_').trim();
        const destDir = new Directory(stagingDir, legDirName);

        if (leg.exact_path) {
          recursiveCopy(new Directory(leg.exact_path), destDir);
        }

        totalProcessed++;
        const pct = Math.round((totalProcessed / totalItems) * 70);
        onProgress(`Packaging Manual Folder: ${leg.name || leg.code}...`, pct);
      }
    }

    onProgress("Compressing structured folders...", 80);
    const timestamp = new Date().toISOString().split('T')[0] + "_" + new Date().getHours() + new Date().getMinutes();
    const zipFileName = `Projects_Export_${timestamp}.zip`;
    const targetZipFile = new File(Paths.cache, zipFileName);
    if (targetZipFile.exists) {
      targetZipFile.delete();
    }

    if (cancelRef.current) throw new Error("Cancelled by user");
    await zip(stagingDir.uri, targetZipFile.uri);
    if (cancelRef.current) throw new Error("Cancelled by user");

    if (stagingDir.exists) {
      stagingDir.delete();
    }
    
    return targetZipFile.uri;

  } catch (error: unknown) {
    if (error instanceof Error && error.message !== "Cancelled by user") {
      throw error;
    }
    return null;
  }
};