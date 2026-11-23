const xml = (value: string) => new TextEncoder().encode(value);

/** Tiny stored ZIP writer for valid, CRC-checked OOXML test documents; no production parser dependency. */
export function officeZip(entries: Record<string, string | Uint8Array>): ArrayBuffer {
  const parts = Object.entries(entries).map(([name, value]) => {
    const data = typeof value === "string" ? xml(value) : value;
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return { name: xml(name), data, crc: (crc ^ 0xffffffff) >>> 0 };
  });
  const localBytes = parts.reduce((sum, part) => sum + 30 + part.name.length + part.data.length, 0);
  const centralBytes = parts.reduce((sum, part) => sum + 46 + part.name.length, 0);
  const bytes = new Uint8Array(localBytes + centralBytes + 22);
  const view = new DataView(bytes.buffer);
  let local = 0;
  let central = localBytes;
  for (const part of parts) {
    view.setUint32(local, 0x04034b50, true);
    view.setUint16(local + 4, 20, true);
    view.setUint32(local + 14, part.crc, true);
    view.setUint32(local + 18, part.data.length, true);
    view.setUint32(local + 22, part.data.length, true);
    view.setUint16(local + 26, part.name.length, true);
    bytes.set(part.name, local + 30);
    bytes.set(part.data, local + 30 + part.name.length);
    view.setUint32(central, 0x02014b50, true);
    view.setUint16(central + 4, 20, true);
    view.setUint16(central + 6, 20, true);
    view.setUint32(central + 16, part.crc, true);
    view.setUint32(central + 20, part.data.length, true);
    view.setUint32(central + 24, part.data.length, true);
    view.setUint16(central + 28, part.name.length, true);
    view.setUint32(central + 42, local, true);
    bytes.set(part.name, central + 46);
    local += 30 + part.name.length + part.data.length;
    central += 46 + part.name.length;
  }
  view.setUint32(central, 0x06054b50, true);
  view.setUint16(central + 8, parts.length, true);
  view.setUint16(central + 10, parts.length, true);
  view.setUint32(central + 12, centralBytes, true);
  view.setUint32(central + 16, localBytes, true);
  return bytes.buffer;
}

const relationshipNamespace = "http://schemas.openxmlformats.org/package/2006/relationships";
const officeRel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const spreadsheetNamespace = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const presentationNamespace = "http://schemas.openxmlformats.org/presentationml/2006/main";
const drawingNamespace = "http://schemas.openxmlformats.org/drawingml/2006/main";
function types(overrides: [string, string][]) {
  return `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>${overrides.map(([part, type]) => `<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.${type}+xml"/>`).join("")}</Types>`;
}
function relationships(items: [string, string, string][]) {
  return `<Relationships xmlns="${relationshipNamespace}">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${officeRel}/${type}" Target="${target}"/>`).join("")}</Relationships>`;
}
export function workbookFixture(): ArrayBuffer {
  const entries: Record<string, string> = {
    "[Content_Types].xml": types([
      ["xl/workbook.xml", "spreadsheetml.sheet.main"],
      ["xl/styles.xml", "spreadsheetml.styles"],
      ["xl/worksheets/sheet1.xml", "spreadsheetml.worksheet"],
      ["xl/worksheets/sheet2.xml", "spreadsheetml.worksheet"],
    ]),
    "_rels/.rels": relationships([["rId1", "officeDocument", "xl/workbook.xml"]]),
    "xl/workbook.xml": `<workbook xmlns="${spreadsheetNamespace}" xmlns:r="${officeRel}"><sheets><sheet name="Numbers" sheetId="1" r:id="rId1"/><sheet name="Evidence" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": relationships([
      ["rId1", "worksheet", "worksheets/sheet1.xml"],
      ["rId2", "worksheet", "worksheets/sheet2.xml"],
      ["rId3", "styles", "styles.xml"],
    ]),
    "xl/styles.xml": `<styleSheet xmlns="${spreadsheetNamespace}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><color rgb="FF0055AA"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFDD00"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="2" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyNumberFormat="1"/></cellXfs></styleSheet>`,
  };
  for (let index = 1; index <= 2; index++) {
    entries[`xl/worksheets/sheet${index}.xml`] =
      `<worksheet xmlns="${spreadsheetNamespace}"><dimension ref="A1:L60"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${index === 1 ? "Styled value" : "第二张表"}</t></is></c><c r="B1" s="1"><v>${index === 1 ? "42.5" : "99"}</v></c><c r="C1" t="inlineStr"><is><t>Multi&#10;line &quot;value&quot;</t></is></c></row><row r="26"><c r="A26" t="inlineStr"><is><t>Second page</t></is></c></row><row r="60"><c r="L60"><v>123</v></c></row></sheetData></worksheet>`;
  }
  return officeZip(entries);
}

export function presentationFixture(picture?: string | { format: "bmp" | "tiff"; bytes: Uint8Array }): ArrayBuffer {
  const entries: Record<string, string | Uint8Array> = {
    "[Content_Types].xml": types([
      ["ppt/presentation.xml", "presentationml.presentation.main"],
      ["ppt/slides/slide1.xml", "presentationml.slide"],
      ["ppt/slides/slide2.xml", "presentationml.slide"],
      ["ppt/notesSlides/notesSlide1.xml", "presentationml.notesSlide"],
    ]),
    "_rels/.rels": relationships([["rId1", "officeDocument", "ppt/presentation.xml"]]),
    "ppt/presentation.xml": `<p:presentation xmlns:p="${presentationNamespace}" xmlns:r="${officeRel}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": relationships([
      ["rId1", "slide", "slides/slide1.xml"],
      ["rId2", "slide", "slides/slide2.xml"],
    ]),
    "ppt/slides/_rels/slide1.xml.rels": relationships([
      ["rIdImage", "image", "../media/image1.png"],
      ["rIdNotes", "notesSlide", "../notesSlides/notesSlide1.xml"],
    ]),
    "ppt/media/image1.png": Uint8Array.from(
      atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY1EAAAAASUVORK5CYII="),
      (char) => char.charCodeAt(0),
    ),
  };
  const shape = (text: string) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="300000" y="300000"/><a:ext cx="7000000" cy="1000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="FFFF00"/></a:solidFill></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="2400" b="1"><a:latin typeface="Calibri"/></a:rPr><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
  const group = `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>`;
  const image = `<p:pic><p:nvPicPr><p:cNvPr id="3" name="Embedded PNG"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdImage"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="300000" y="1500000"/><a:ext cx="1000000" cy="1000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
  for (let index = 1; index <= 2; index++)
    entries[`ppt/slides/slide${index}.xml`] =
      `<p:sld xmlns:p="${presentationNamespace}" xmlns:a="${drawingNamespace}" xmlns:r="${officeRel}"><p:cSld><p:spTree>${group}${shape(`Slide ${index}`)}${index === 1 ? image : ""}</p:spTree></p:cSld></p:sld>`;
  entries["ppt/notesSlides/notesSlide1.xml"] =
    `<p:notes xmlns:p="${presentationNamespace}" xmlns:a="${drawingNamespace}"><p:cSld><p:spTree>${group}${shape("Speaker notes").replace("<p:nvPr/>", '<p:nvPr><p:ph type="body" idx="1"/></p:nvPr>')}</p:spTree></p:cSld></p:notes>`;
  if (picture !== undefined) {
    const format = typeof picture === "string" ? "svg" : picture.format;
    const mime = format === "svg" ? "image/svg+xml" : `image/${format}`;
    delete entries["ppt/media/image1.png"];
    entries[`ppt/media/image1.${format}`] = typeof picture === "string" ? picture : picture.bytes;
    entries["[Content_Types].xml"] = String(entries["[Content_Types].xml"]).replace(
      "</Types>",
      `<Default Extension="${format}" ContentType="${mime}"/></Types>`,
    );
    entries["ppt/slides/_rels/slide1.xml.rels"] = String(entries["ppt/slides/_rels/slide1.xml.rels"]).replace(
      "image1.png",
      `image1.${format}`,
    );
  }
  return officeZip(entries);
}

/** Valid two-by-two uncompressed RGB images, generated independently of the decoder. */
export function officeBitmapFixture(format: "bmp" | "tiff"): Uint8Array<ArrayBuffer> {
  if (format === "bmp") {
    const bytes = new Uint8Array(70);
    const view = new DataView(bytes.buffer);
    bytes.set([0x42, 0x4d]);
    view.setUint32(2, bytes.length, true);
    view.setUint32(10, 54, true);
    view.setUint32(14, 40, true);
    view.setInt32(18, 2, true);
    view.setInt32(22, 2, true);
    view.setUint16(26, 1, true);
    view.setUint16(28, 24, true);
    view.setUint32(34, 16, true);
    bytes.set([255, 0, 0, 0, 255, 0, 0, 0, 0, 0, 255, 255, 255, 255, 0, 0], 54);
    return bytes;
  }
  const entries = [
    [256, 4, 1, 2],
    [257, 4, 1, 2],
    [258, 3, 3, 134],
    [259, 3, 1, 1],
    [262, 3, 1, 2],
    [273, 4, 1, 140],
    [277, 3, 1, 3],
    [278, 4, 1, 2],
    [279, 4, 1, 12],
    [284, 3, 1, 1],
  ];
  const bytes = new Uint8Array(152);
  const view = new DataView(bytes.buffer);
  bytes.set([0x49, 0x49, 42, 0]);
  view.setUint32(4, 8, true);
  view.setUint16(8, entries.length, true);
  entries.forEach(([tag = 0, type = 0, count = 0, value = 0], index) => {
    const offset = 10 + index * 12;
    view.setUint16(offset, tag, true);
    view.setUint16(offset + 2, type, true);
    view.setUint32(offset + 4, count, true);
    view.setUint32(offset + 8, value, true);
  });
  view.setUint16(134, 8, true);
  view.setUint16(136, 8, true);
  view.setUint16(138, 8, true);
  bytes.set([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255], 140);
  return bytes;
}
