/**
 * Generates the strictly formatted filename requested for the Housing Inspection App.
 * Format: [Serial Number] [Beneficiary Name] [Beneficiary Code]_[Photo Count].jpg
 */
export const generatePhotoFilename = (
  serialNumber: string | number,
  beneficiaryName: string,
  beneficiaryCode: string,
  currentPhotoCount: number
): string => {
  // Clean inputs to ensure safe filesystem naming
  const cleanSerial = serialNumber ? String(serialNumber).trim() : '00';
  const cleanName = beneficiaryName ? String(beneficiaryName).trim().replace(/[^a-zA-Z0-9 ]/g, '') : 'UNKNOWN';
  const cleanCode = beneficiaryCode ? String(beneficiaryCode).trim() : 'NO_CODE';
  const nextCount = currentPhotoCount + 1;

  // Expected output: "01 THAKOR PRATAPJI 248024799667000041_1.jpg"
  return `${cleanSerial} ${cleanName} ${cleanCode}_${nextCount}.jpg`;
};

/**
 * Future helper for generating the HTML string for the PDF Export
 * based on user-defined Rows x Columns
 */
export const calculateGridDimensions = (rows: number, cols: number, isLandscape: boolean) => {
  const pageWidth = isLandscape ? 297 : 210; // A4 sizes in mm
  const pageHeight = isLandscape ? 210 : 297;
  
  return {
    imageWidth: (pageWidth / cols) - 4, // Subtracting margin
    imageHeight: (pageHeight / rows) - 4
  };
};