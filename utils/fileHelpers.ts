import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { zip } from 'react-native-zip-archive';
import { Alert } from 'react-native';

/**
 * Generates the strictly formatted filename requested for the Housing Inspection App.
 */
export const generatePhotoFilename = (
  serialNumber: string | number,
  beneficiaryName: string,
  beneficiaryCode: string,
  currentPhotoCount: number
): string => {
  const cleanSerial = serialNumber ? String(serialNumber).trim().padStart(2, '0') : '00';
  const cleanName = beneficiaryName ? String(beneficiaryName).trim().replace(/[^a-zA-Z0-9 ]/g, '') : 'UNKNOWN';
  const cleanCode = beneficiaryCode ? String(beneficiaryCode).trim() : 'NO_CODE';
  const nextCount = currentPhotoCount + 1;
  return `${cleanSerial} ${cleanName} ${cleanCode}_${nextCount}.jpg`;
};

/**
 * Zips a SINGLE beneficiary's folder (Used in the Album Screen)
 */
export const exportBeneficiaryAsZip = async (beneficiaryCode: string, beneficiaryName: string) => {
  try {
    const sourceDir = `${FileSystem.documentDirectory}HousingInspection/${beneficiaryCode}/`;
    const dirInfo = await FileSystem.getInfoAsync(sourceDir);
    
    if (!dirInfo.exists) {
      Alert.alert("No Data", "No photos or notes found for this beneficiary to export.");
      return;
    }

    const safeName = (beneficiaryName || 'Unknown').replace(/[^a-zA-Z0-9]/g, '_');
    const zipFileName = `${safeName}_${beneficiaryCode}_Export.zip`;
    const targetZipPath = `${FileSystem.cacheDirectory}${zipFileName}`;

    await zip(sourceDir, targetZipPath);

    const canShare = await Sharing.isAvailableAsync();
    if (canShare) {
      await Sharing.shareAsync(targetZipPath, {
        mimeType: 'application/zip',
        dialogTitle: `Save or Share ${zipFileName}`,
        UTI: 'public.zip-archive'
      });
    }
  } catch (error) {
    Alert.alert("Export Failed", "Could not create the ZIP file.");
  }
};

/**
 * Zips MULTIPLE beneficiaries' folders into one master ZIP archive (Used in Dashboard)
 * It groups them into subdirectories named by their beneficiary code.
 */
export const exportMultipleBeneficiariesAsZip = async (beneficiaryCodes: string[], method: 'share' | 'save' = 'share') => {
  try {
    if (!beneficiaryCodes || beneficiaryCodes.length === 0) return;

    // 1. Create a Master Staging Directory
    const stagingDir = `${FileSystem.cacheDirectory}Staging_Export/`;
    
    // Clean up any previous failed exports
    const stagingInfo = await FileSystem.getInfoAsync(stagingDir);
    if (stagingInfo.exists) {
      await FileSystem.deleteAsync(stagingDir, { idempotent: true });
    }
    await FileSystem.makeDirectoryAsync(stagingDir, { intermediates: true });

    let addedCount = 0;

    // 2. Copy each selected beneficiary folder into the Staging Directory
    for (const code of beneficiaryCodes) {
      const sourceDir = `${FileSystem.documentDirectory}HousingInspection/${code}/`;
      const sourceInfo = await FileSystem.getInfoAsync(sourceDir);
      
      if (sourceInfo.exists) {
        // Create a subdirectory inside staging named after the code
        const destDir = `${stagingDir}${code}/`;
        await FileSystem.copyAsync({ from: sourceDir, to: destDir });
        addedCount++;
      }
    }

    if (addedCount === 0) {
      Alert.alert("No Data", "None of the selected projects have any photos or notes saved yet.");
      await FileSystem.deleteAsync(stagingDir, { idempotent: true });
      return;
    }

    // 3. Zip the Staging Directory
    const timestamp = new Date().toISOString().split('T')[0]; // e.g., 2026-07-30
    const zipFileName = `Bulk_Projects_Export_${timestamp}.zip`;
    const targetZipPath = `${FileSystem.cacheDirectory}${zipFileName}`;

    await zip(stagingDir, targetZipPath);

    // 4. Share or Save the Master ZIP
    if (method === 'save') {
      const permissions = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
      if (permissions.granted) {
        try {
          const base64Data = await FileSystem.readAsStringAsync(targetZipPath, { encoding: FileSystem.EncodingType.Base64 });
          const savedUri = await FileSystem.StorageAccessFramework.createFileAsync(permissions.directoryUri, zipFileName, 'application/zip');
          if (savedUri) {
             await FileSystem.writeAsStringAsync(savedUri, base64Data, { encoding: FileSystem.EncodingType.Base64 });
             Alert.alert("Success", "ZIP file successfully saved to your selected folder.");
          }
        } catch (e) {
          Alert.alert("Error", "Could not save the file to that specific folder. Please try another folder or use Share.");
        }
      }
    } else {
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(targetZipPath, {
          mimeType: 'application/zip',
          dialogTitle: `Save or Share Bulk Export`,
          UTI: 'public.zip-archive'
        });
      }
    }

    // 5. Cleanup the staging directory so it doesn't waste storage space
    await FileSystem.deleteAsync(stagingDir, { idempotent: true });

  } catch (error) {
    console.error("Multi-Zip Export Error:", error);
    Alert.alert("Export Failed", "Could not create the combined ZIP file.");
  }
};