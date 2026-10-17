import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

/** Build a small multi-page techpack-like PDF with known facts (used as a Files API / document input). */
export async function makeSamplePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pages: Array<{ title: string; lines: string[] }> = [
    { title: "TECHPACK TP-2026-HD01 - Harbor Hoodie", lines: ["Season: Fall/Winter 2026", "Fabric: 380gsm brushed-back cotton fleece", "Colourway: Harbor Navy (Pantone 19-4025 TCX)", "Factory code: ZEBRA-7731", "Base size: M"] },
    { title: "POINTS OF MEASURE (cm)", lines: ["A  Chest width 1 inch below armhole: 61 (+/- 1.0)", "B  Body length HPS: 70 (+/- 1.0)", "C  Shoulder drop: 6.5 (+/- 0.5)", "D  Sleeve length from CB: 84 (+/- 1.0)", "E  Cuff opening relaxed: 9 (+/- 0.5)"] },
    { title: "BILL OF MATERIALS", lines: ["Shell: 380gsm cotton fleece, 1.9 m per piece", "Rib 2x2 97/3 cotton elastane, 0.25 m per piece", "Drawcord: 1.5 m flat cotton, 2 pcs", "Eyelets: 2 metal, antique brass", "Main label: woven, centre back neck"] },
  ];
  for (const p of pages) {
    const page = doc.addPage([595, 842]);
    page.drawText(p.title, { x: 50, y: 780, size: 18, font: bold, color: rgb(0, 0, 0) });
    p.lines.forEach((l, i) => page.drawText(l, { x: 50, y: 740 - i * 24, size: 12, font }));
  }
  return doc.save();
}

export async function pdfPageCount(bytes: Uint8Array | Buffer): Promise<number> {
  const d = await PDFDocument.load(bytes, { ignoreEncryption: true });
  return d.getPageCount();
}
