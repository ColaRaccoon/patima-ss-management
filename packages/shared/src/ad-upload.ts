/** Daily advertising exports: YYMMDD_<store>[메인|서브].xlsx. */
export function parseAdUploadFileName(fileName: string): {
  reportDate: string;
  storeName: string;
} | null {
  const match = /^(\d{2})(\d{2})(\d{2})_(인피니티|파티마)(?:메인|서브)?\.xlsx$/i.exec(fileName.normalize("NFC"));
  if (!match) return null;
  const reportDate = `20${match[1]}-${match[2]}-${match[3]}`;
  const date = new Date(`${reportDate}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== reportDate) return null;
  return { reportDate, storeName: `${match[4]}스토어` };
}
