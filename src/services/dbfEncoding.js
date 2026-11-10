// Détection de l'encodage des .dbf de shapefile (sans dépendance, utilisable
// aussi bien dans le navigateur que dans un script Node).
//
// shpjs décode le .dbf en UTF-8 quand aucun .cpg n'est fourni. Or beaucoup de
// shapefiles agricoles ne sont pas en UTF-8 : les accents deviennent alors « � »
// (ex. « RAY-GRASS D�ROB�E ») et les cultures ne sont plus reconnues.
//
// Encodages rencontrés :
//  - Windows-1252 / ISO-8859-1 : exports SIG Windows, Télépac ;
//  - CP850 / CP437 (DOS) : logiciels de gestion agricole et outils dBase
//    anciens. TextDecoder ne les connaît pas : on décode alors en Windows-1252
//    (bijectif octet → caractère), puis on retranscrit chaque caractère via la
//    table DOS (voir createRecoder).
//
// Ordre de décision : .cpg explicite et compris > UTF-8 valide > octet LDID du
// .dbf et analyse des octets accentués (le jeu qui donne des lettres gagne).

const C1 = (code) => String.fromCharCode(code);

// Caractères 0x80 à 0xFF des pages DOS, 16 par ligne.
const CP850_HIGH =
  "ÇüéâäàåçêëèïîìÄÅ" +
  "ÉæÆôöòûùÿÖÜø£Ø×ƒ" +
  "áíóúñÑªº¿®¬½¼¡«»" +
  "░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐" +
  "└┴┬├─┼ãÃ╚╔╩╦╠═╬¤" +
  "ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀" +
  "ÓßÔÒõÕµþÞÚÛÙýÝ¯´" +
  C1(0xad) + "±‗¾¶§÷¸°¨·¹³²■" + C1(0xa0);

const CP437_HIGH =
  "ÇüéâäàåçêëèïîìÄÅ" +
  "ÉæÆôöòûùÿÖÜ¢£¥₧ƒ" +
  "áíóúñÑªº¿⌐¬½¼¡«»" +
  "░▒▓│┤╡╢╖╕╣║╗╝╜╛┐" +
  "└┴┬├─┼╞╟╚╔╩╦╠═╬╧" +
  "╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀" +
  "αßΓπΣσµτΦΘΩδ∞φε∩" +
  "≡±≥≤⌠⌡÷≈°∙·√ⁿ²■" + C1(0xa0);

export const DOS_CODEPAGES = {
  cp850: Array.from(CP850_HIGH),
  cp437: Array.from(CP437_HIGH),
};

// Octet 29 du .dbf (« language driver ID ») → encodage.
const LDID_ENCODINGS = {
  0x01: "cp437",
  0x02: "cp850",
  0x03: "windows-1252",
  0x57: "windows-1252",
  0x26: "ibm866",
  0x64: "windows-1250", // CP852 non géré par TextDecoder : approximation
  0xc8: "windows-1250",
  0xc9: "windows-1251",
};

let win1252ByteOf = null;
function win1252Inverse() {
  if (!win1252ByteOf) {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const chars = Array.from(new TextDecoder("windows-1252").decode(bytes));
    win1252ByteOf = new Map(chars.map((ch, i) => [ch, i]));
  }
  return win1252ByteOf;
}

// Retrouve l'encodage canonique d'un libellé de .cpg, en tolérant les écritures
// courantes des logiciels SIG : « 1252 », « ANSI 1252 », « ISO 8859-1 »,
// « iso_8859_1 », « UTF8 », « 850 », « OEM 850 »… Renvoie un nom compris par
// TextDecoder, « cp850 » / « cp437 », ou null si inconnu.
export function resolveCpgEncoding(cpgText) {
  const raw = String(cpgText ?? "").trim().toLowerCase();
  if (!raw) return null;
  const digits = raw.match(/^(?:ansi|cp|windows|ibm|oem|pc|dos)?[\s_-]*(\d{3,4})$/);
  if (digits && DOS_CODEPAGES[`cp${digits[1]}`]) return `cp${digits[1]}`;
  const candidates = [
    digits ? `windows-${digits[1]}` : null,
    raw === "unicode" ? "utf-8" : null,
    raw,
    raw.replace(/[\s_]+/g, "-"),
    raw.replace(/^iso[\s_-]*/, "iso-").replace(/[\s_]+/g, "-"),
  ].filter(Boolean);
  for (const label of candidates) {
    try {
      return new TextDecoder(label).encoding;
    } catch {
      // libellé suivant
    }
  }
  return null;
}

export function isValidUtf8(bytes) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function charForByte(encoding, byte) {
  if (byte < 0x80) return String.fromCharCode(byte);
  const dos = DOS_CODEPAGES[encoding];
  if (dos) return dos[byte - 0x80];
  return new TextDecoder(encoding).decode(Uint8Array.of(byte));
}

// Accents courants en français : « é » vaut bien plus que « Ú ».
const COMMON_ACCENT_RE = /[éèêëàâäçôöûüùîïÉÈÊËÀÂÇÔÛÙÎÏœŒ]/;
const LETTER_RE = /[A-Za-zÀ-ÖØ-öø-ÿŒœŠšŽžŸĂăÂâÎîȘșȚțŞşŢţ]/;

// Note un encodage d'après les octets accentués des enregistrements : un
// accent français courant rapporte beaucoup, une autre lettre latine un peu,
// un caractère de contrôle, de dessin ou grec coûte.
function scoreEncoding(highBytes, encoding) {
  const cache = new Map();
  let score = 0;
  for (const [byte, count] of highBytes) {
    if (!cache.has(byte)) cache.set(byte, charForByte(encoding, byte));
    const ch = cache.get(byte);
    const weight = COMMON_ACCENT_RE.test(ch) ? 3 : LETTER_RE.test(ch) ? 1 : -2;
    score += weight * count;
  }
  return score;
}

function recordHighBytes(dbfBytes) {
  const view = new DataView(dbfBytes.buffer, dbfBytes.byteOffset, dbfBytes.byteLength);
  const headerLen = dbfBytes.byteLength >= 10 ? view.getUint16(8, true) : 0;
  const counts = new Map();
  for (let i = headerLen; i < dbfBytes.byteLength; i += 1) {
    const b = dbfBytes[i];
    if (b >= 0x80) counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  return counts;
}

/**
 * Encodage réel d'un .dbf, ou null s'il est en UTF-8 (défaut de shpjs).
 * Renvoie un nom compris par TextDecoder, ou « cp850 » / « cp437 ».
 */
export function chooseDbfEncoding(dbfBytes, cpgText) {
  // Des accents qui forment de l'UTF-8 valide n'arrivent quasiment jamais par
  // hasard en Windows-1252 ou DOS : c'est de l'UTF-8, quoi qu'annonce le .cpg.
  // (Sans accent du tout, l'encodage n'a pas d'importance.)
  if (isValidUtf8(dbfBytes)) return null;
  const declared = resolveCpgEncoding(cpgText);

  // Le .cpg et l'octet LDID ne sont qu'une préférence : on a vu des fichiers
  // en Windows-1252 annoncés en DOS 850 (« DÉROBÉE » lu « DÚROBÚE »). Un autre
  // encodage les remplace s'il donne des accents plus plausibles.
  const fromLdid = LDID_ENCODINGS[dbfBytes[29]] ?? null;
  const preferred = declared && declared !== "utf-8" ? declared : fromLdid;
  const highBytes = recordHighBytes(dbfBytes);
  if (!highBytes.size && preferred) return preferred;
  const candidates = ["windows-1252", "cp850", "cp437"];
  let best = preferred ?? "windows-1252";
  let bestScore = scoreEncoding(highBytes, best);
  for (const encoding of candidates) {
    const score = scoreEncoding(highBytes, encoding);
    if (score > bestScore) {
      best = encoding;
      bestScore = score;
    }
  }
  return best;
}

/** Ancien nom, conservé pour les appels existants. */
export const detectDbfEncoding = chooseDbfEncoding;

/** Valeur à écrire dans le .cpg pour que shpjs décode avec TextDecoder. */
export function cpgForEncoding(encoding) {
  return DOS_CODEPAGES[encoding] ? "windows-1252" : encoding;
}

/**
 * Pour une page DOS, fonction qui corrige une chaîne décodée en Windows-1252
 * (via le .cpg écrit par cpgForEncoding). null pour les autres encodages.
 */
export function createRecoder(encoding) {
  const table = DOS_CODEPAGES[encoding];
  if (!table) return null;
  const byteOf = win1252Inverse();
  return (text) => {
    let out = "";
    for (const ch of String(text)) {
      const byte = ch.charCodeAt(0) < 0x80 ? -1 : byteOf.get(ch) ?? -1;
      out += byte >= 0x80 ? table[byte - 0x80] : ch;
    }
    return out;
  };
}

/** Décode des octets bruts selon un encodage renvoyé par chooseDbfEncoding. */
export function decodeWithEncoding(bytes, encoding) {
  const text = new TextDecoder(cpgForEncoding(encoding ?? "utf-8")).decode(bytes);
  const recoder = createRecoder(encoding);
  return recoder ? recoder(text) : text;
}
