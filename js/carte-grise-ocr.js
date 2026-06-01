/**
 * KIA Service — Tunisian Carte Grise OCR Engine
 * Specialized post-processing for Certificat d'Immatriculation Tunisien
 * Based on real document analysis:
 *   - Vertical left sidebar: N° immatriculation (e.g. "170 تونس 1867")
 *   - VIN: ZFA1990000P011861 (17 chars, no I/O/Q)
 *   - Marque: under "Constructeur" label
 *   - Modèle: under "Type commercial" label
 *   - Owner name: Arabic, top-right block
 *   - Address: Arabic, under owner name
 *   - CIN: 8-digit number near "CIN (ou MF)" label
 *   - DPMC: date yyyy/mm/dd near "DPMC" label
 */

window.CarteGriseOCR = (function () {

  // ──────────────────────────────────────────────
  //  TEXT CLEANING
  // ──────────────────────────────────────────────
  function cleanText(raw) {
    return (raw || '')
      .replace(/\r\n/g, '\n')
      .replace(/\t/g, ' ')
      .replace(/ {2,}/g, ' ')
      .trim();
  }

  // Normalize OCR noise in alphanumeric contexts
  function fixOcrNoise(str) {
    return str
      .replace(/[oO]/g, '0')   // O → 0 in codes
      .replace(/[lI|]/g, '1')  // l/I/| → 1 in codes
      .replace(/§/g, 'S')
      .replace(/©/g, 'C')
      .replace(/°/g, '0');
  }

  // ──────────────────────────────────────────────
  //  1. IMMATRICULATION
  //  Located on left vertical sidebar.
  //  Real format: number + "تونس" (Tunis) + number
  //  Examples seen: "170 تونس 1867", "123 TUN 456"
  // ──────────────────────────────────────────────
  function extractImmatriculation(text, lines) {
    // Strategy A: Arabic Tunis format  "NNN تونس NNNN"
    const arabicTunisRx = /(\d{1,4})\s*تونس\s*(\d{1,4})/;
    const atM = text.match(arabicTunisRx);
    if (atM) {
      return {
        value: `${atM[1]} تونس ${atM[2]}`,
        confidence: 0.98
      };
    }

    // Strategy B: Latin TUN format "NNN TUN NNNN"
    const latinTunRx = /\b(\d{1,4})\s*TUN\s*(\d{1,4})\b/i;
    const ltM = text.match(latinTunRx);
    if (ltM) {
      return {
        value: `${ltM[1]} TUN ${ltM[2]}`,
        confidence: 0.97
      };
    }

    // Strategy C: "N° d'immatriculation" label → value below
    const labelRx = /N[°o]?\s*d[''']?\s*immatriculation[^\n]*\n([^\n]+)/i;
    const lM = text.match(labelRx);
    if (lM) {
      const candidate = lM[1].trim();
      if (candidate.length >= 3) return { value: candidate, confidence: 0.82 };
    }

    // Strategy D: look for short number sequences near left margin
    // Tunisian plate: 2-3 digit prefix + separator + 4 digit suffix
    const shortPlateRx = /\b(\d{2,3})\s+(\d{3,4})\b/;
    for (const line of lines) {
      const m = line.match(shortPlateRx);
      if (m && line.length < 20) {
        return { value: `${m[1]} ${m[2]}`, confidence: 0.60 };
      }
    }

    // Strategy E: reconstruct from sidebar lines
    // The sidebar contains numbers vertically — look for isolated numbers
    const sidebarNumbers = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^\d{2,4}$/.test(trimmed)) sidebarNumbers.push(trimmed);
    }
    if (sidebarNumbers.length >= 2) {
      return {
        value: sidebarNumbers.slice(0, 2).join(' تونس '),
        confidence: 0.55
      };
    }

    return { value: '', confidence: 0 };
  }

  // ──────────────────────────────────────────────
  //  2. VIN (Numéro de châssis / N° Série du type)
  //  17 characters, no I, O, Q
  //  Real example: ZFA1990000P011861
  // ──────────────────────────────────────────────
  function extractVIN(text, lines) {
    // Primary: strict 17-char VIN regex
    const strictVinRx = /\b([A-HJ-NPR-Z0-9]{17})\b/g;
    let best = null;

    const allMatches = [...text.matchAll(strictVinRx)];
    for (const m of allMatches) {
      const vin = m[1];
      const score = scoreVIN(vin);
      if (!best || score > best.confidence) {
        best = { value: vin, confidence: score };
      }
    }
    if (best && best.confidence > 0.5) return best;

    // Fallback: relax OCR noise (O→0, I→1) then retry
    const relaxed = text.toUpperCase()
      .replace(/\bO\b/g, '0')
      .replace(/\bI\b/g, '1');
    const relaxedMatches = [...relaxed.matchAll(strictVinRx)];
    for (const m of relaxedMatches) {
      const vin = m[1];
      const score = scoreVIN(vin) * 0.85;
      if (!best || score > best.confidence) {
        best = { value: vin, confidence: score };
      }
    }
    if (best) return best;

    // Strategy: look for 17-char alphanumeric near "Série" or "châssis" label
    const labelRx = /(?:N[°o]?\s*[Ss][eé]rie|[Cc]h[aâ]ssis|ZFA|KNA|VF|WBA|WDD)[^\n]*?([A-Z0-9]{15,20})/i;
    const lM = text.match(labelRx);
    if (lM) {
      const candidate = lM[1].replace(/[^A-HJ-NPR-Z0-9]/g, '').substring(0, 17);
      if (candidate.length === 17) {
        return { value: candidate, confidence: 0.72 };
      }
    }

    return { value: '', confidence: 0 };
  }

  function scoreVIN(vin) {
    if (!vin || vin.length !== 17) return 0;
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return 0.4;

    // Check digit (position 9, index 8) validation
    const weights = [8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2];
    const charValues = {
      A:1,B:2,C:3,D:4,E:5,F:6,G:7,H:8,
      J:1,K:2,L:3,M:4,N:5,P:7,R:9,
      S:2,T:3,U:4,V:5,W:6,X:7,Y:8,Z:9
    };
    let sum = 0;
    for (let i = 0; i < 17; i++) {
      const c = vin[i];
      const v = isNaN(parseInt(c)) ? (charValues[c] || 0) : parseInt(c);
      sum += v * weights[i];
    }
    const remainder = sum % 11;
    const expected  = remainder === 10 ? 'X' : String(remainder);
    return vin[8] === expected ? 1.0 : 0.75;
  }

  // ──────────────────────────────────────────────
  //  3. MARQUE (Constructeur)
  //  Label "Constructeur" → value on NEXT line
  //  Real example: FIAT
  // ──────────────────────────────────────────────
  function extractMarque(text, lines) {
    // Strategy A: "Constructeur" label → next non-empty line
    for (let i = 0; i < lines.length; i++) {
      if (/constructeur/i.test(lines[i])) {
        // Value is typically on the next line
        for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
          const candidate = lines[j].trim();
          // Filter out other labels
          if (candidate && !/^(N°|marque|modèle|commercial|genre|activité)/i.test(candidate)
              && candidate.length >= 2 && candidate.length <= 30) {
            return { value: candidate, confidence: 0.93 };
          }
        }
      }
    }

    // Strategy B: known brands lookup
    const knownBrands = [
      'KIA','HYUNDAI','TOYOTA','VOLKSWAGEN','VW','RENAULT','PEUGEOT',
      'CITROËN','CITROEN','BMW','MERCEDES','FORD','HONDA','NISSAN',
      'MAZDA','SUZUKI','MITSUBISHI','FIAT','SEAT','SKODA','OPEL',
      'DACIA','VOLVO','AUDI','JEEP','CHEVROLET','MINI','ALFA','LANCIA',
      'SUBARU','ISUZU','CATERPILLAR','MAHINDRA'
    ];
    const upperText = text.toUpperCase();
    for (const brand of knownBrands) {
      if (upperText.includes(brand)) {
        return { value: brand.charAt(0) + brand.slice(1).toLowerCase(), confidence: 0.90 };
      }
    }

    // Strategy C: text after "D.1" label
    const d1Rx = /D\.?1[\s:]+([A-Z][A-Z\s\-]{1,20})/i;
    const d1M  = text.match(d1Rx);
    if (d1M) return { value: d1M[1].trim(), confidence: 0.75 };

    return { value: '', confidence: 0 };
  }

  // ──────────────────────────────────────────────
  //  4. MODÈLE (Type commercial)
  //  Label "Type commercial" → value on NEXT line
  //  Real example: PUNTO
  // ──────────────────────────────────────────────
  function extractModele(text, lines) {
    // Strategy A: "Type commercial" label → next non-empty line
    for (let i = 0; i < lines.length; i++) {
      if (/type\s+commercial/i.test(lines[i])) {
        for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
          const candidate = lines[j].trim();
          if (candidate && !/^(type|N°|marque|constructeur|genre|activité)/i.test(candidate)
              && candidate.length >= 2 && candidate.length <= 40) {
            return { value: candidate, confidence: 0.93 };
          }
        }
      }
    }

    // Strategy B: same line — "Type commercial PUNTO" pattern
    const inlineRx = /type\s+commercial[\s:]+([A-Z0-9][A-Z0-9\s\-\.]{1,30})/i;
    const iM = text.match(inlineRx);
    if (iM) return { value: iM[1].trim(), confidence: 0.85 };

    // Strategy C: D.2 label
    const d2Rx = /D\.?2[\s:]+([A-Z0-9][A-Z0-9\s\-\.]{1,25})/i;
    const d2M  = text.match(d2Rx);
    if (d2M) return { value: d2M[1].trim(), confidence: 0.78 };

    return { value: '', confidence: 0 };
  }

  // ──────────────────────────────────────────────
  //  5. NOM DU TITULAIRE (Owner name — Arabic)
  //  Top-right of document. First Arabic text block.
  //  Real example: عواطف بوصلاح
  // ──────────────────────────────────────────────
  const arabicRx = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;

  function extractOwnerName(text, lines) {
    // Strategy A: after "Nom et Prénom" label
    for (let i = 0; i < lines.length; i++) {
      if (/nom\s+et\s+pr[ée]nom|الاسم\s+واللقب/i.test(lines[i])) {
        for (let j = i - 2; j <= i + 3; j++) {
          if (j < 0 || j >= lines.length || j === i) continue;
          const candidate = lines[j].trim();
          // Prefer line with Arabic content
          if (arabicRx.test(candidate) && candidate.length >= 3) {
            return { value: candidate, confidence: 0.95 };
          }
        }
      }
    }

    // Strategy B: first Arabic-heavy line in top half of document
    const topLines = lines.slice(0, Math.ceil(lines.length * 0.4));
    for (const line of topLines) {
      const trimmed = line.trim();
      if (arabicRx.test(trimmed)) {
        // Count Arabic chars — owner name should be mostly Arabic
        const arabicCount = (trimmed.match(/[\u0600-\u06FF]/g) || []).length;
        const ratio = arabicCount / trimmed.length;
        if (ratio > 0.4 && trimmed.length >= 4 && trimmed.length <= 60) {
          return { value: trimmed, confidence: 0.85 };
        }
      }
    }

    // Strategy C: "الاسم" label context
    const nameArabicRx = /الاسم[^\n]*\n([^\n]+)/;
    const nM = text.match(nameArabicRx);
    if (nM && nM[1].trim()) {
      return { value: nM[1].trim(), confidence: 0.80 };
    }

    return { value: '', confidence: 0 };
  }

  // ──────────────────────────────────────────────
  //  6. ADRESSE (Arabic, under owner name)
  //  Real example: 40نهج الجامع الكبير الجم . المهدية
  // ──────────────────────────────────────────────
  function extractAdresse(text, lines) {
    // Strategy A: after "Adresse" or "العنوان" label
    for (let i = 0; i < lines.length; i++) {
      if (/adresse|العنوان/i.test(lines[i])) {
        for (let j = i - 2; j <= i + 3; j++) {
          if (j < 0 || j >= lines.length || j === i) continue;
          const candidate = lines[j].trim();
          if (arabicRx.test(candidate) && candidate.length >= 5) {
            return { value: candidate, confidence: 0.92 };
          }
        }
      }
    }

    // Strategy B: second Arabic-heavy line
    const arabicLines = [];
    for (const line of lines) {
      const trimmed = line.trim();
      const arabicCount = (trimmed.match(/[\u0600-\u06FF]/g) || []).length;
      if (arabicCount > 3) arabicLines.push(trimmed);
    }
    if (arabicLines.length >= 2) {
      return { value: arabicLines[1], confidence: 0.72 };
    }

    return { value: '', confidence: 0 };
  }

  // ──────────────────────────────────────────────
  //  7. CIN (Carte d'Identité Nationale)
  //  8-digit number near "CIN (ou MF)" label
  //  Real example: 03989990
  // ──────────────────────────────────────────────
  function extractCIN(text, lines) {
    // Strategy A: near "CIN" label — number on same or adjacent line
    const cinLabelRx = /CIN\s*[\(\[ou\)MF\s]*[\):]*\s*(\d{6,12})/i;
    const cM = text.match(cinLabelRx);
    if (cM) return { value: cM[1], confidence: 0.97 };

    // Strategy B: "CIN" on one line, number nearby
    for (let i = 0; i < lines.length; i++) {
      if (/\bCIN\b/i.test(lines[i])) {
        // Check same line for number
        const sameLineNum = lines[i].match(/\b(\d{6,12})\b/);
        if (sameLineNum) return { value: sameLineNum[1], confidence: 0.95 };
        // Check adjacent lines
        for (let delta = -1; delta <= 2; delta++) {
          const j = i + delta;
          if (j < 0 || j >= lines.length || j === i) continue;
          const numM = lines[j].match(/\b(\d{6,12})\b/);
          if (numM) return { value: numM[1], confidence: 0.88 };
        }
      }
    }

    // Strategy C: "بت.و" (Arabic abbreviation for CIN)
    const arabicCinRx = /بت[.\s]*و[^\n]*?(\d{6,12})/;
    const acM = text.match(arabicCinRx);
    if (acM) return { value: acM[1], confidence: 0.85 };

    // Strategy D: standalone 8-digit number (Tunisian CIN is exactly 8 digits)
    const eightDigitRx = /\b(\d{8})\b/g;
    const allEight = [...text.matchAll(eightDigitRx)];
    // Filter out years and other date-like patterns
    const cinCandidates = allEight
      .map(m => m[1])
      .filter(n => !n.startsWith('201') && !n.startsWith('202') && !n.startsWith('199') && !n.startsWith('200'));
    if (cinCandidates.length > 0) {
      return { value: cinCandidates[0], confidence: 0.65 };
    }

    return { value: '', confidence: 0 };
  }

  // ──────────────────────────────────────────────
  //  8. DPMC (Date — yyyy/mm/dd)
  //  Near "DPMC" label, after Activité/Genre section
  //  Real example: 2013/12/13
  // ──────────────────────────────────────────────
  function extractDPMC(text, lines) {
    // Strategy A: "DPMC" label — date on same or adjacent line
    for (let i = 0; i < lines.length; i++) {
      if (/DPMC/i.test(lines[i])) {
        // Check same line first
        const sameLine = lines[i].match(/(\d{4}[\/\.\-]\d{2}[\/\.\-]\d{2})/);
        if (sameLine) return { value: normalizeDate(sameLine[1]), confidence: 0.98 };

        // Check adjacent lines
        for (let delta = -2; delta <= 2; delta++) {
          const j = i + delta;
          if (j < 0 || j >= lines.length || j === i) continue;
          const dateM = lines[j].match(/(\d{4}[\/\.\-]\d{2}[\/\.\-]\d{2})/);
          if (dateM) return { value: normalizeDate(dateM[1]), confidence: 0.95 };
        }
      }
    }

    // Strategy B: any date matching yyyy/mm/dd or yyyy-mm-dd
    const isoDateRx = /\b(\d{4})[\/\.\-](\d{2})[\/\.\-](\d{2})\b/g;
    const isoDates  = [...text.matchAll(isoDateRx)];
    if (isoDates.length > 0) {
      // DPMC is a registration date — prefer dates between 1990–current year
      const currentYear = new Date().getFullYear();
      for (const m of isoDates) {
        const year = parseInt(m[1]);
        if (year >= 1990 && year <= currentYear) {
          return {
            value: `${m[1]}/${m[2]}/${m[3]}`,
            confidence: isoDates.length === 1 ? 0.85 : 0.72
          };
        }
      }
    }

    // Strategy C: تاريخ label (Arabic "date" label)
    const arabicDateRx = /تاريخ[^\n]*?(\d{4}[\/\.\-]\d{2}[\/\.\-]\d{2})/;
    const adM = text.match(arabicDateRx);
    if (adM) return { value: normalizeDate(adM[1]), confidence: 0.90 };

    return { value: '', confidence: 0 };
  }

  function normalizeDate(raw) {
    // Ensure yyyy/mm/dd format
    const m = raw.match(/(\d{4})[\/\.\-](\d{2})[\/\.\-](\d{2})/);
    if (m) return `${m[1]}/${m[2]}/${m[3]}`;
    return raw;
  }

  // ──────────────────────────────────────────────
  //  CONFIDENCE SUMMARY
  // ──────────────────────────────────────────────
  function buildSummary(fields) {
    const values = Object.values(fields);
    const filled = values.filter(f => f.value !== '');
    const total  = values.length;
    const avgConf = filled.length > 0
      ? filled.reduce((s, f) => s + f.confidence, 0) / filled.length
      : 0;
    return {
      fieldsDetected: filled.length,
      fieldsTotal:    total,
      matchPercent:   Math.round((avgConf * 0.65 + (filled.length / total) * 0.35) * 100)
    };
  }

  // ──────────────────────────────────────────────
  //  PUBLIC API
  // ──────────────────────────────────────────────
  return {

    /**
     * process(rawText) → { fields, summary, json }
     * rawText: string from Tesseract or any OCR engine
     */
    process(rawText) {
      const text  = cleanText(rawText);
      const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

      const fields = {
        immatriculation: extractImmatriculation(text, lines),
        vin:             extractVIN(text, lines),
        marque:          extractMarque(text, lines),
        modele:          extractModele(text, lines),
        ownerName:       extractOwnerName(text, lines),
        address:         extractAdresse(text, lines),
        cin:             extractCIN(text, lines),
        dpmc:            extractDPMC(text, lines),
      };

      const summary = buildSummary(fields);

      // Build clean JSON output (values only)
      const json = {};
      for (const [k, f] of Object.entries(fields)) {
        json[k] = f.value;
      }

      return { fields, summary, json };
    },

    /**
     * Apply a user edit to a field — marks it as manually edited
     */
    applyEdit(fields, key, newValue) {
      if (!fields[key]) return fields;
      return {
        ...fields,
        [key]: { value: newValue, confidence: 1.0, source: 'user' }
      };
    },

    // Human-readable labels matching the Tunisian carte grise layout
    FIELD_LABELS: {
      immatriculation: 'N° Immatriculation',
      vin:             'VIN (N° Châssis)',
      marque:          'Marque (Constructeur)',
      modele:          'Modèle (Type commercial)',
      ownerName:       'Nom du titulaire',
      address:         'Adresse',
      cin:             'CIN (ou MF)',
      dpmc:            'DPMC (Date)',
    },

    FIELD_ORDER: [
      'immatriculation',
      'vin',
      'marque',
      'modele',
      'ownerName',
      'address',
      'cin',
      'dpmc',
    ]
  };

})();