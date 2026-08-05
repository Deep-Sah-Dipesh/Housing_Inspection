import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { zip } from 'react-native-zip-archive';
import { Alert } from 'react-native';

/**
 * Generates the strictly formatted filename requested.
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

export const exportProjects = async (
  beneficiaryCodes: string[], 
  method: 'share' | 'save',
  onProgress: (msg: string, percentage: number) => void,
  cancelRef: { current: boolean }
) => {
  try {
    if (!beneficiaryCodes || beneficiaryCodes.length === 0) return;

    let permissions;
    if (method === 'save') {
      permissions = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
      if (!permissions.granted) return;
    }

    // 1. Stage all files in cache
    const stagingDir = `${FileSystem.cacheDirectory}Staging_Export/`;
    const stagingInfo = await FileSystem.getInfoAsync(stagingDir);
    if (stagingInfo.exists) {
      await FileSystem.deleteAsync(stagingDir, { idempotent: true });
    }
    await FileSystem.makeDirectoryAsync(stagingDir, { intermediates: true });

    let addedCount = 0;
    for (const code of beneficiaryCodes) {
      if (cancelRef.current) throw new Error("Cancelled by user");
      addedCount++;
      const percent = Math.round((addedCount / beneficiaryCodes.length) * 50); 
      onProgress(`Staging Project ${addedCount} of ${beneficiaryCodes.length}...`, percent);

      const sourceDir = `${FileSystem.documentDirectory}HousingInspection/${code}/`;
      const sourceInfo = await FileSystem.getInfoAsync(sourceDir);
      
      if (sourceInfo.exists) {
        const destDir = `${stagingDir}${code}/`;
        await FileSystem.copyAsync({ from: sourceDir, to: destDir });
      }
    }

    // 2. Compress into a ZIP to lock in the proper tree hierarchy
    onProgress("Compressing structured files...", 60);
    const timestamp = new Date().toISOString().split('T')[0] + "_" + new Date().getHours() + new Date().getMinutes();
    const zipFileName = `Projects_Export_${timestamp}.zip`;
    const targetZipPath = `${FileSystem.cacheDirectory}${zipFileName}`;

    if (cancelRef.current) throw new Error("Cancelled by user");
    await zip(stagingDir, targetZipPath);
    
    // CRITICAL FIX: Check if user cancelled while the native zipping was happening
    if (cancelRef.current) throw new Error("Cancelled by user");

    // 3. Output based on user choice
    if (method === 'share') {
      onProgress("Ready to Share!", 100);
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(targetZipPath, {
          mimeType: 'application/zip',
          dialogTitle: `Share Bulk Export`,
          UTI: 'public.zip-archive'
        });
      }
    } else if (method === 'save' && permissions) {
      onProgress("Saving structured ZIP to device...", 90);
      
      const fileUri = await FileSystem.StorageAccessFramework.createFileAsync(
        permissions.directoryUri, 
        zipFileName, 
        'application/zip'
      );
      
      if (cancelRef.current) throw new Error("Cancelled by user");
      const base64Data = await FileSystem.readAsStringAsync(targetZipPath, { encoding: FileSystem.EncodingType.Base64 });
      
      if (cancelRef.current) throw new Error("Cancelled by user");
      await FileSystem.writeAsStringAsync(fileUri, base64Data, { encoding: FileSystem.EncodingType.Base64 });

      onProgress("Save Complete!", 100);
      setTimeout(() => Alert.alert("Saved Successfully", `${beneficiaryCodes.length} project${beneficiaryCodes.length !== 1 ? 's' : ''} saved successfully! Extract the ZIP file in your File Manager.`), 500);
    }

    // Cleanup
    await FileSystem.deleteAsync(stagingDir, { idempotent: true });
    await FileSystem.deleteAsync(targetZipPath, { idempotent: true });

  } catch (error: any) {
    if (error.message === "Cancelled by user") {
      // Handled silently by the UI modal
    } else {
      console.error("Export Error:", error);
      Alert.alert("Export Failed", `Details: ${error.message}`);
    }
  }
};