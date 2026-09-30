import xlsx from 'xlsx';

try {
  const workbook = xlsx.readFile('e:\\\\cfdcms\\\\Savitribai fule -1.xls');
  console.log('Sheet Names:', workbook.SheetNames);
  
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(sheet!, { header: 1 });
    console.log(`\n--- Sheet: ${sheetName} ---`);
    console.log('Rows:', data.length);
    if (data.length > 0) {
      console.log('Row 1 (Header):', data[0]);
    }
  }
} catch (err) {
  console.error('Failed to read excel:', err);
}
