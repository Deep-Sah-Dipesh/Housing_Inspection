import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as SQLite from 'expo-sqlite';
import * as XLSX from 'xlsx';

export const exportFilteredDataToExcel = async (
  db: SQLite.SQLiteDatabase,
  district: string | null,
  city: string | null,
  selectedCodes?: string[]
) => {
  try {
    let query = `
      SELECT 
        b.code, 
        b.name, 
        b.site_address,
        MIN(p.created_at) as photo_timestamp
      FROM beneficiaries b
      LEFT JOIN photos p ON p.beneficiary_id = b.id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (district) {
      query += ` AND b.district_name = ?`;
      params.push(district);
    }
    if (city) {
      query += ` AND b.city_name = ?`;
      params.push(city);
    }
    if (selectedCodes && selectedCodes.length > 0) {
      const placeholders = selectedCodes.map(() => '?').join(',');
      query += ` AND b.code IN (${placeholders})`;
      params.push(...selectedCodes);
    }

    query += `
      GROUP BY b.code, b.name, b.site_address
      ORDER BY 
        CASE WHEN MIN(p.created_at) IS NULL THEN 1 ELSE 0 END, 
        MIN(p.created_at) ASC
    `;

    const rawData = await db.getAllAsync<any>(query, params);
    if (!rawData || rawData.length === 0) return false;

    const formattedData = rawData.map((row, index) => {
      const srNo = index + 1;
      return {
        "IDD": "",
        "PHASE": "",
        "S_No": srNo,
        "Application_ Number": row.code || "",
        "Name": row.name || "",
        "Mobile_No": "",
        "Address": row.site_address || "",
        "Account_No": "",
        "IFSC_Code": "",
        "Bank_Name": "",
        "Adharcard_Number": "",
        "New_Name": `${srNo}. ${row.name || ""}\n${row.code || ""}`
      };
    });

    const ws = XLSX.utils.json_to_sheet(formattedData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Inspection_Template");

    ws['!cols'] = [
      { wch: 10 }, { wch: 10 }, { wch: 8 }, { wch: 25 },
      { wch: 30 }, { wch: 15 }, { wch: 40 }, { wch: 20 },
      { wch: 15 }, { wch: 20 }, { wch: 20 }, { wch: 35 }
    ];

    const wbout = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const locationTag = city || district || 'Dashboard_Selection';
    const fileName = `Export_${locationTag}_${timestamp}.xlsx`;
    const fileUri = `${FileSystem.documentDirectory}${fileName}`;

    await FileSystem.writeAsStringAsync(fileUri, wbout, {
      encoding: FileSystem.EncodingType.Base64,
    });

    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(fileUri, {
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        dialogTitle: 'Export Beneficiary Template',
      });
      return true;
    }
    return false;
  } catch (error) {
    console.error("Failed to generate Excel export:", error);
    throw error;
  }
};