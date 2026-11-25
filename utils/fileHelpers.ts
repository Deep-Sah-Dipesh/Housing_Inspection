import { Directory, File, Paths } from 'expo-file-system';
import * as SQLite from 'expo-sqlite';
import * as XLSX from 'xlsx';
import { zip } from 'react-native-zip-archive';

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

export const generateZipArchive = async (
  db: SQLite.SQLiteDatabase,
  items: any[], // Accepts full objects to distinguish legacy vs DB items
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

      const beneficiaries = await db.getAllAsync<any>(query, [fallbackCity, ...dbItems.map(i => i.code)]);

      const groupedByCity: Record<string, any[]> = {};
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

          const photos = await db.getAllAsync<any>(
            `SELECT * FROM photos WHERE beneficiary_code = ? ORDER BY created_at ASC`, [b.code]
          );

          let photoCount = 0;
          for (const photo of photos) {
            const photoFileName = generatePhotoFilename(srNo, b.name, b.code, photoCount);
            const sourcePhoto = new File(photo.local_uri);
            const destPhoto = new File(cityDir, photoFileName);
            if (destPhoto.exists) {
              destPhoto.delete();
            }
            sourcePhoto.copy(destPhoto);
            photoCount++;
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
        onProgress(`Packaging Manual Folder: ${leg.name}...`, pct);
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

  } catch (error: any) {
    if (error.message !== "Cancelled by user") {
      throw error;
    }
    return null;
  }
};