// Fast pure-JS single-pass drop-in replacement for csv-reader 1.0.0.
// Exports:
//   - run(input): fast slice-based drop-in for { text, header } -> { columns, rows, errors }
//   - runJsonCases(inBuf): single-pass UTF-8 byte-buffer JSON+CSV transducer for /input/cases.json

const COMMA = 1;
const LINE_BREAK = 2;
const END = 3;

// Compact numeric error tags.
const ERR_STRAY_CR = 1;
const ERR_UNTERMINATED_QUOTE = 2;
const ERR_QUOTE_JUNK = 3;
const ERR_SHORT_ROW = 4;
const ERR_LONG_ROW = 5;

const ERR_PREFIX_STRAY_CR = Buffer.from('{"code":"stray_cr","line":');
const ERR_PREFIX_UNTERM = Buffer.from('{"code":"unterminated_quote","line":');
const ERR_PREFIX_JUNK = Buffer.from('{"code":"quote_junk","line":');
const ERR_PREFIX_SHORT = Buffer.from('{"code":"short_row","line":');
const ERR_PREFIX_LONG = Buffer.from('{"code":"long_row","line":');
const ERR_MID_ROW_NULL = Buffer.from(',"row":null');
const ERR_MID_ROW_NUM = Buffer.from(',"row":');
const ERR_MID_FIELDS = Buffer.from(',"fields":');
const ERR_MID_EXTRA = Buffer.from(',"extra":[');
const B_CLOSE_BRACKET_BRACE = Buffer.from(']}');

const B_EMPTY_CASE_TRUE = Buffer.from('{"columns":[],"rows":[],"errors":[]}');
const B_EMPTY_CASE_FALSE = Buffer.from('{"columns":null,"rows":[],"errors":[]}');
const B_EMPTY_ERR_TRUE = Buffer.from('{"columns":[],"rows":[],"errors":[');
const B_EMPTY_ERR_FALSE = Buffer.from('{"columns":null,"rows":[],"errors":[');
const B_PREFIX_TRUE = Buffer.from('{"columns":');
const B_MID_TRUE = Buffer.from(',"rows":[');
const B_PREFIX_FALSE = Buffer.from('{"columns":null,"rows":[');
const B_NO_ERRORS_CLOSE = Buffer.from('],"errors":[]}');
const B_ERRORS_OPEN = Buffer.from('],"errors":[');
const B_COMMA = Buffer.from(',');
const B_OPEN_ARR = Buffer.from('[');
const B_CLOSE_ARR = Buffer.from(']');

/**
 * Exact, slice-based pure-JS drop-in for csv-reader 1.0.0's readCsv(input).
 */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  let recordLine = 1;
  let recordRow = null;

  function readUnquoted(prefix) {
    let segStart = pos;
    let value = prefix;
    let added = 0;
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 44) {
        if (pos > segStart) {
          added += pos - segStart;
          value = value.length === 0 ? text.slice(segStart, pos) : value + text.slice(segStart, pos);
        }
        pos += 1;
        return { value, ended: COMMA, added };
      }
      if (c === 10) {
        if (pos > segStart) {
          added += pos - segStart;
          value = value.length === 0 ? text.slice(segStart, pos) : value + text.slice(segStart, pos);
        }
        pos += 1;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      if (c === 13) {
        if (pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
          if (pos > segStart) {
            added += pos - segStart;
            value = value.length === 0 ? text.slice(segStart, pos) : value + text.slice(segStart, pos);
          }
          pos += 2;
          line += 1;
          return { value, ended: LINE_BREAK, added };
        }
        if (pos > segStart) {
          added += pos - segStart;
          value = value.length === 0 ? text.slice(segStart, pos) : value + text.slice(segStart, pos);
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        pos += 1;
        segStart = pos;
        continue;
      }
      pos += 1;
    }
    if (pos > segStart) {
      added += pos - segStart;
      value = value.length === 0 ? text.slice(segStart, pos) : value + text.slice(segStart, pos);
    }
    return { value, ended: END, added };
  }

  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let segStart = pos;
    let value = '';
    let closed = false;
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 34) {
        if (pos + 1 < len && text.charCodeAt(pos + 1) === 34) {
          const sliceEnd = pos + 1;
          value = value.length === 0 ? text.slice(segStart, sliceEnd) : value + text.slice(segStart, sliceEnd);
          pos += 2;
          segStart = pos;
          continue;
        }
        if (pos > segStart) {
          value = value.length === 0 ? text.slice(segStart, pos) : value + text.slice(segStart, pos);
        }
        pos += 1;
        closed = true;
        break;
      }
      if (c === 13) {
        if (pos > segStart) {
          value = value.length === 0 ? text.slice(segStart, pos) : value + text.slice(segStart, pos);
        }
        value += '\n';
        line += 1;
        pos += pos + 1 < len && text.charCodeAt(pos + 1) === 10 ? 2 : 1;
        segStart = pos;
        continue;
      }
      if (c === 10) line += 1;
      pos += 1;
    }
    if (!closed) {
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return readUnquoted('"');
    }
    if (pos >= len) return { value, ended: END };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: COMMA };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    const junk = readUnquoted(value);
    if (junk.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junk;
  }

  while (true) {
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let field;
    let quoted;
    do {
      quoted = pos < len && text.charCodeAt(pos) === 34;
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
    } while (field.ended === COMMA);

    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}

/** Skip JSON whitespace (space, tab, LF, CR). */
function skipWs(src, p, len) {
  while (p < len) {
    const b = src[p];
    if (b === 32 || b === 10 || b === 13 || b === 9) p++;
    else break;
  }
  return p;
}

/** Skip a JSON string starting at its opening '"'. Returns index after closing '"', or -1 on error. */
function skipJsonString(src, p, len) {
  if (p >= len || src[p] !== 34) return -1;
  p++;
  while (p < len) {
    const b = src[p++];
    if (b === 34) return p;
    if (b === 92) {
      if (p >= len) return -1;
      p++;
    }
  }
  return -1;
}

/** Skip any JSON value starting at p. Returns index after value, or -1 on syntax error. */
function skipJsonValue(src, p, len) {
  p = skipWs(src, p, len);
  if (p >= len) return -1;
  const b = src[p];
  if (b === 34) return skipJsonString(src, p, len);
  if (b === 123 || b === 91) {
    let depth = 1;
    p++;
    while (p < len && depth > 0) {
      const c = src[p++];
      if (c === 34) {
        p = skipJsonString(src, p - 1, len);
        if (p < 0) return -1;
      } else if (c === 123 || c === 91) {
        depth++;
      } else if (c === 125 || c === 93) {
        depth--;
      }
    }
    return depth === 0 ? p : -1;
  }
  while (p < len) {
    const c = src[p];
    if (c === 44 || c === 125 || c === 93 || c === 32 || c === 10 || c === 13 || c === 9) break;
    p++;
  }
  return p;
}

/** Return true if b terminates a JSON literal token (true/false/null/number). */
function isJsonDelim(b) {
  return b === 44 || b === 125 || b === 93 || b === 32 || b === 10 || b === 13 || b === 9;
}

/** Write a non-negative integer as ASCII digits into buf at w; returns new w. */
function writeUintAscii(buf, w, n) {
  if (n < 10) {
    buf[w] = 48 + n;
    return w + 1;
  }
  if (n < 100) {
    const q = (n / 10) | 0;
    buf[w] = 48 + q;
    buf[w + 1] = 48 + (n - q * 10);
    return w + 2;
  }
  let tmp = n;
  let digits = 0;
  while (tmp > 0) {
    tmp = (tmp / 10) | 0;
    digits++;
  }
  let idx = w + digits - 1;
  tmp = n;
  while (tmp > 0) {
    const q = (tmp / 10) | 0;
    buf[idx--] = 48 + (tmp - q * 10);
    tmp = q;
  }
  return w + digits;
}

/** Check whether src[p..] matches "\uFEFF" (case-insensitive hex). */
function isEscapedBom(src, p, len) {
  if (p + 6 > len || src[p] !== 92 || src[p + 1] !== 117) return false;
  const h0 = src[p + 2];
  const h1 = src[p + 3];
  const h2 = src[p + 4];
  const h3 = src[p + 5];
  return (
    (h0 === 70 || h0 === 102) &&
    (h1 === 69 || h1 === 101) &&
    (h2 === 70 || h2 === 102) &&
    (h3 === 70 || h3 === 102)
  );
}

/** Serialize per-case error arrays into a compact Buffer slice for JSON output. */
function serializeErrors(errCodes, errLines, errRecIdxs, errExtra, headerVal) {
  const n = errCodes.length;
  let est = n * 64 + 64;
  for (let i = 0; i < n; i++) {
    if (errCodes[i] === ERR_LONG_ROW) est += errExtra[i].length;
  }
  let buf = Buffer.allocUnsafe(est);
  let w = 0;

  function ensureErr(need) {
    if (w + need <= buf.length) return;
    const next = Buffer.allocUnsafe(Math.max(buf.length * 2, w + need + 1024));
    buf.copy(next, 0, 0, w);
    buf = next;
  }

  for (let i = 0; i < n; i++) {
    const code = errCodes[i];
    const extraVal = errExtra[i];
    ensureErr(96 + (code === ERR_LONG_ROW ? extraVal.length : 0));
    if (i > 0) buf[w++] = 44;

    let prefix;
    if (code === ERR_STRAY_CR) prefix = ERR_PREFIX_STRAY_CR;
    else if (code === ERR_UNTERMINATED_QUOTE) prefix = ERR_PREFIX_UNTERM;
    else if (code === ERR_QUOTE_JUNK) prefix = ERR_PREFIX_JUNK;
    else if (code === ERR_SHORT_ROW) prefix = ERR_PREFIX_SHORT;
    else prefix = ERR_PREFIX_LONG;

    prefix.copy(buf, w);
    w += prefix.length;
    w = writeUintAscii(buf, w, errLines[i]);

    const recIdx = errRecIdxs[i];
    if (headerVal && recIdx === 0) {
      ERR_MID_ROW_NULL.copy(buf, w);
      w += ERR_MID_ROW_NULL.length;
    } else {
      ERR_MID_ROW_NUM.copy(buf, w);
      w += ERR_MID_ROW_NUM.length;
      w = writeUintAscii(buf, w, headerVal ? recIdx - 1 : recIdx);
    }

    if (code === ERR_SHORT_ROW) {
      ERR_MID_FIELDS.copy(buf, w);
      w += ERR_MID_FIELDS.length;
      w = writeUintAscii(buf, w, extraVal);
      buf[w++] = 125;
    } else if (code === ERR_LONG_ROW) {
      ERR_MID_EXTRA.copy(buf, w);
      w += ERR_MID_EXTRA.length;
      extraVal.copy(buf, w);
      w += extraVal.length;
      B_CLOSE_BRACKET_BRACE.copy(buf, w);
      w += B_CLOSE_BRACKET_BRACE.length;
    } else {
      buf[w++] = 125;
    }
  }
  return buf.subarray(0, w);
}

/**
 * Cold helper for Record 0 capture, short_row padding, and long_row truncation.
 */
function finalizeRecordSlow(ctx, dst, w, fieldCount, width, recordLine, recIdx, extraStartW, errCodes, errLines, errRecIdxs, errExtra) {
  if (width < 0) {
    dst[w++] = 93;
    ctx.width = fieldCount;
    ctx.hasRec0 = true;
    ctx.rec0Slice = Buffer.from(dst.subarray(ctx.bodyStartW, w));
    ctx.w = ctx.bodyStartW;
    return 1;
  }
  if (fieldCount < width) {
    errCodes.push(ERR_SHORT_ROW);
    errLines.push(recordLine);
    errRecIdxs.push(recIdx);
    errExtra.push(fieldCount);
    const padNeed = (width - fieldCount) * 3 + 8;
    if (w + padNeed >= dst.length - 4096) {
      ctx.w = w;
      growCaseBuffer(ctx, padNeed + 65536);
      dst = ctx.uDst;
      w = ctx.w;
    }
    while (fieldCount < width) {
      dst[w++] = 44;
      dst[w++] = 34;
      dst[w++] = 34;
      fieldCount++;
    }
  } else {
    const extraSlice = Buffer.from(dst.subarray(extraStartW + 1, w));
    errCodes.push(ERR_LONG_ROW);
    errLines.push(recordLine);
    errRecIdxs.push(recIdx);
    errExtra.push(extraSlice);
    w = extraStartW;
  }
  dst[w++] = 93;
  ctx.w = w;
  return recIdx + 1;
}

/**
 * Cold buffer-grow helper kept separate from the hot transduce loop so V8 keeps
 * dst, w, and p in registers with zero closure context allocation.
 */
function growCaseBuffer(ctx, need) {
  const shift = ctx.bodyStartW;
  const used = ctx.w - shift;
  const nextLen = Math.max(ctx.outBuf.length * 2, used + need + 65536);
  const next = Buffer.allocUnsafe(nextLen);
  if (used > 0) ctx.outBuf.copy(next, 0, shift, ctx.w);
  ctx.outBuf = next;
  ctx.uDst = new Uint8Array(next.buffer, next.byteOffset, next.byteLength);
  ctx.dDv = new DataView(next.buffer, next.byteOffset, next.byteLength);
  ctx.w = used;
  ctx.bodyStartW = 0;
  if (ctx.rowStartW >= 0) ctx.rowStartW -= shift;
  if (ctx.extraStartW >= 0) ctx.extraStartW -= shift;
  if (ctx.fieldValStartW >= 0) ctx.fieldValStartW -= shift;
}

/**
 * Ultra-compact single-SWAR-loop fast path (~55 lines) for normal CSV rows.
 * Handles both unquoted and quoted fields in one 32-bit DataView SWAR loop so V8
 * compiles the entire hot kernel into native registers on Round 0 with minimal CPU cost.
 * Commits (cp, cw, cl) after each complete row; rolls back atomically on any edge case.
 */
function fastUnified(src, sdv, dst, ddv, pSafe, width, st) {
  let p = st[0];
  let w = st[1];
  let line = st[2];
  let recIdx = st[3];
  let cp = p;
  let cw = w;
  let cl = line;
  let inQ = false;
  let fc = 0;

  if (p < pSafe) {
    const c0 = src[p];
    if (c0 === 34 || c0 < 32 || (c0 === 92 && src[p + 1] !== 34)) {
      st[0] = cp;
      st[1] = cw;
      st[2] = cl;
      st[3] = recIdx;
      return;
    }
    if (recIdx > 1) {
      ddv.setUint16(w, 0x5b2c, true);
      w += 2;
    } else {
      dst[w++] = 91;
    }
    if (sdv.getUint16(p, true) === 0x225c) {
      inQ = true;
      p += 2;
    }
    dst[w++] = 34;
  }

  while (p < pSafe) {
    const v = sdv.getInt32(p, true);
    ddv.setInt32(w, v, true);
    const a = v ^ 0x2c2c2c2c;
    const b = v ^ 0x5c5c5c5c;
    const c = v ^ 0x22222222;
    const m =
      ((((a - 0x01010101) & ~a) |
        ((b - 0x01010101) & ~b) |
        ((c - 0x01010101) & ~c)) &
        0x80808080) >>>
      7;
    if (m === 0) {
      p += 4;
      w += 4;
      continue;
    }
    if ((m & 0x0101) === 0) {
      const d = (m & 0x10000) !== 0 ? 2 : 3;
      p += d;
      w += d;
    } else if ((m & 1) === 0) {
      p += 1;
      w += 1;
    }
    if (p >= pSafe) break;
    const ch = src[p];
    if (ch === 44) {
      if (inQ) {
        dst[w++] = 44;
        p++;
        continue;
      }
      if (++fc >= width || p + 1 >= pSafe) break;
      ddv.setUint32(w, 0x00222c22, true);
      w += 3;
      p++;
      if (sdv.getUint16(p, true) === 0x225c) {
        inQ = true;
        p += 2;
      }
      continue;
    }
    if (ch !== 92) break;
    const u0 = sdv.getUint16(p, true);
    if (inQ) {
      if (u0 === 0x225c) {
        if (sdv.getUint16(p + 2, true) === 0x225c) {
          ddv.setUint16(w, 0x225c, true);
          w += 2;
          p += 4;
          continue;
        }
        p += 2;
        inQ = false;
        if (p >= pSafe) break;
        const nx = src[p];
        if (nx === 44) {
          if (++fc >= width || p + 1 >= pSafe) break;
          ddv.setUint32(w, 0x00222c22, true);
          w += 3;
          p++;
          if (sdv.getUint16(p, true) === 0x225c) {
            inQ = true;
            p += 2;
          }
          continue;
        }
        if (nx !== 92) break;
        continue;
      }
      if (u0 === 0x6e5c) {
        ddv.setUint16(w, 0x6e5c, true);
        w += 2;
        p += 2;
        line++;
        continue;
      }
      if (u0 === 0x725c) {
        ddv.setUint16(w, 0x6e5c, true);
        w += 2;
        p += sdv.getUint16(p + 2, true) === 0x6e5c ? 4 : 2;
        line++;
        continue;
      }
      break;
    }
    if (u0 === 0x6e5c) {
      p += 2;
      line++;
    } else if (u0 === 0x725c && sdv.getUint16(p + 2, true) === 0x6e5c) {
      p += 4;
      line++;
    } else {
      break;
    }
    if (fc + 1 !== width) break;
    ddv.setUint16(w, 0x5d22, true);
    w += 2;
    recIdx++;
    while (p < pSafe && src[p] === 92) {
      const nb = src[p + 1];
      if (nb === 110) {
        p += 2;
        line++;
      } else if (nb === 114 && sdv.getUint16(p + 2, true) === 0x6e5c) {
        p += 4;
        line++;
      } else {
        break;
      }
    }
    cp = p;
    cw = w;
    cl = line;
    if (p >= pSafe) break;
    const c0 = src[p];
    if (c0 === 34 || c0 < 32 || (c0 === 92 && src[p + 1] !== 34)) break;
    ddv.setUint16(w, 0x5b2c, true);
    w += 2;
    if (sdv.getUint16(p, true) === 0x225c) {
      inQ = true;
      p += 2;
    }
    dst[w++] = 34;
    fc = 0;
  }

  st[0] = cp;
  st[1] = cw;
  st[2] = cl;
  st[3] = recIdx;
}

/** Sync cursor/anchor offsets and grow output buffer for the slow path. */
function slowGrow(ctx, w, rowStartW, extraStartW, fieldValStartW) {
  ctx.w = w;
  ctx.rowStartW = rowStartW;
  ctx.extraStartW = extraStartW;
  ctx.fieldValStartW = fieldValStartW;
  growCaseBuffer(ctx, 262144);
  return ctx.uDst;
}

/**
 * Cold single-row slow parser handling Record 0, short_row, long_row, stray_cr,
 * quote_junk, unterminated_quote, rare JSON escapes, and small tail slices.
 * Updates st = [p, w, line, recIdx] and returns true on success or false if JSON fallback is needed.
 */
function parseSlowRow(src, p, srcLen, ctx, st, errCodes, errLines, errRecIdxs, errExtra) {
  let dst = ctx.uDst;
  let dstCap = dst.length - 4096;
  let w = st[1];
  let line = st[2];
  let recIdx = st[3];
  const width = ctx.width;

  if (w + 65536 >= dstCap) {
    dst = slowGrow(ctx, w, -1, -1, -1);
    dstCap = dst.length - 4096;
    w = ctx.w;
  }
  let pSafe = p + ((dstCap - w) >> 2);
  if (pSafe > srcLen) pSafe = srcLen;

  const recordLine = line;
  let rowStartW = w;
  let extraStartW = -1;

  if (recIdx > 1) dst[w++] = 44;
  dst[w++] = 91;

  let fieldCount = 0;
  let firstQuoted = false;
  let firstFieldEmpty = false;
  let rowDone = false;

  while (!rowDone) {
    if (p >= pSafe) {
      if (p >= srcLen) return false;
      if (w + 65536 >= dstCap) {
        dst = slowGrow(ctx, w, rowStartW, extraStartW, -1);
        dstCap = dst.length - 4096;
        w = ctx.w;
        rowStartW = ctx.rowStartW;
        extraStartW = ctx.extraStartW;
      }
      pSafe = p + ((dstCap - w) >> 2);
      if (pSafe > srcLen) pSafe = srcLen;
    }

    const isQuoted = p + 1 < srcLen && src[p] === 92 && src[p + 1] === 34;
    if (fieldCount === 0) firstQuoted = isQuoted;
    if (fieldCount > 0) {
      if (width >= 0 && fieldCount === width) extraStartW = w;
      dst[w++] = 44;
    }
    let fieldValStartW = w;
    dst[w++] = 34;

    let ended = 0;
    let wasClosed = false;

    if (isQuoted) {
      const openP = p;
      const openLine = line;
      p += 2;
      let closed = false;

      while (!closed) {
        while (p < pSafe) {
          const b = src[p];
          if (b === 92 || b === 34 || b < 32) break;
          dst[w++] = b;
          p++;
        }
        if (p >= pSafe) {
          if (p >= srcLen) return false;
          if (w + 65536 >= dstCap) {
            dst = slowGrow(ctx, w, rowStartW, extraStartW, fieldValStartW);
            dstCap = dst.length - 4096;
            w = ctx.w;
            rowStartW = ctx.rowStartW;
            extraStartW = ctx.extraStartW;
            fieldValStartW = ctx.fieldValStartW;
          }
          pSafe = p + ((dstCap - w) >> 2);
          if (pSafe > srcLen) pSafe = srcLen;
          continue;
        }
        const b = src[p];
        if (b === 34) break;
        if (b !== 92 || p + 1 >= srcLen) return false;
        const nb = src[p + 1];
        if (nb === 34) {
          if (p + 3 < srcLen && src[p + 2] === 92 && src[p + 3] === 34) {
            dst[w++] = 92;
            dst[w++] = 34;
            p += 4;
          } else {
            p += 2;
            closed = true;
            break;
          }
        } else if (nb === 114) {
          dst[w++] = 92;
          dst[w++] = 110;
          line++;
          p += p + 3 < srcLen && src[p + 2] === 92 && src[p + 3] === 110 ? 4 : 2;
        } else if (nb === 110) {
          dst[w++] = 92;
          dst[w++] = 110;
          line++;
          p += 2;
        } else if (nb === 47) {
          dst[w++] = 47;
          p += 2;
        } else if (nb === 92 || nb === 98 || nb === 102 || nb === 116) {
          dst[w++] = 92;
          dst[w++] = nb;
          p += 2;
        } else {
          return false;
        }
      }

      if (!closed) {
        p = openP + 2;
        line = openLine;
        w = fieldValStartW + 1;
        errCodes.push(ERR_UNTERMINATED_QUOTE);
        errLines.push(recordLine);
        errRecIdxs.push(recIdx);
        errExtra.push(0);
        dst[w++] = 92;
        dst[w++] = 34;
      } else {
        wasClosed = true;
        if (p >= srcLen) return false;
        const nextB = src[p];
        if (nextB === 34) {
          ended = END;
        } else if (nextB === 44) {
          p++;
          ended = COMMA;
        } else if (nextB === 92 && p + 1 < srcLen && src[p + 1] === 110) {
          p += 2;
          line++;
          ended = LINE_BREAK;
        } else if (
          nextB === 92 &&
          p + 3 < srcLen &&
          src[p + 1] === 114 &&
          src[p + 2] === 92 &&
          src[p + 3] === 110
        ) {
          p += 4;
          line++;
          ended = LINE_BREAK;
        }
      }
    }

    if (ended === 0) {
      let junkStartW = wasClosed ? w : -1;
      let junkAdded = false;
      while (true) {
        while (p < pSafe) {
          const b = src[p];
          if (b === 44 || b === 92 || b === 34 || b < 32) break;
          dst[w++] = b;
          p++;
        }
        if (p >= pSafe) {
          if (p >= srcLen) return false;
          if (w + 65536 >= dstCap) {
            if (wasClosed && w > junkStartW) junkAdded = true;
            dst = slowGrow(ctx, w, rowStartW, extraStartW, fieldValStartW);
            dstCap = dst.length - 4096;
            w = ctx.w;
            rowStartW = ctx.rowStartW;
            extraStartW = ctx.extraStartW;
            fieldValStartW = ctx.fieldValStartW;
            if (wasClosed) junkStartW = w;
          }
          pSafe = p + ((dstCap - w) >> 2);
          if (pSafe > srcLen) pSafe = srcLen;
          continue;
        }
        const b = src[p];
        if (b === 44) {
          p++;
          ended = COMMA;
          break;
        }
        if (b === 34) {
          ended = END;
          break;
        }
        if (b !== 92 || p + 1 >= srcLen) return false;
        const nb = src[p + 1];
        if (nb === 110) {
          p += 2;
          line++;
          ended = LINE_BREAK;
          break;
        }
        if (nb === 114) {
          if (p + 3 < srcLen && src[p + 2] === 92 && src[p + 3] === 110) {
            p += 4;
            line++;
            ended = LINE_BREAK;
            break;
          }
          errCodes.push(ERR_STRAY_CR);
          errLines.push(recordLine);
          errRecIdxs.push(recIdx);
          errExtra.push(0);
          p += 2;
          continue;
        }
        if (nb === 47) {
          dst[w++] = 47;
          junkAdded = true;
          p += 2;
        } else if (nb === 34 || nb === 92 || nb === 98 || nb === 102 || nb === 116) {
          dst[w++] = 92;
          dst[w++] = nb;
          junkAdded = true;
          p += 2;
        } else {
          return false;
        }
      }
      if (wasClosed && (junkAdded || w > junkStartW)) {
        errCodes.push(ERR_QUOTE_JUNK);
        errLines.push(recordLine);
        errRecIdxs.push(recIdx);
        errExtra.push(0);
      }
    }

    dst[w++] = 34;
    if (fieldCount === 0) firstFieldEmpty = w === fieldValStartW + 2;
    fieldCount++;
    if (ended !== COMMA) rowDone = true;
  }

  if (fieldCount === 1 && firstFieldEmpty && !firstQuoted) {
    st[0] = p;
    st[1] = rowStartW;
    st[2] = line;
    st[3] = recIdx;
    return true;
  }

  st[0] = p;
  if (width >= 0 && fieldCount === width) {
    dst[w++] = 93;
    st[1] = w;
    st[2] = line;
    st[3] = recIdx + 1;
    return true;
  }
  st[3] = finalizeRecordSlow(
    ctx,
    dst,
    w,
    fieldCount,
    width,
    recordLine,
    recIdx,
    extraStartW,
    errCodes,
    errLines,
    errRecIdxs,
    errExtra,
  );
  st[1] = ctx.w;
  st[2] = line;
  return true;
}

/**
 * Tiny coordinator loop (~45 lines) dispatching normal rows to fastUnified and
 * occasional broken/boundary rows to parseSlowRow.
 */
function transduceCsvText(src, p, srcLen, ctx, errCodes, errLines, errRecIdxs, errExtra) {
  if (p + 3 <= srcLen && src[p] === 0xef && src[p + 1] === 0xbb && src[p + 2] === 0xbf) {
    p += 3;
  } else if (isEscapedBom(src, p, srcLen)) {
    p += 6;
  }

  const sdv = ctx.sDv;
  const st = ctx.st;
  ctx.bodyStartW = ctx.w;
  ctx.width = -1;
  ctx.hasRec0 = false;

  st[0] = p;
  st[1] = ctx.w;
  st[2] = 1;
  st[3] = 0;

  const src4 = srcLen - 4;

  while (true) {
    let cur = st[0];
    let line = st[2];
    while (cur + 1 < srcLen && src[cur] === 92) {
      const nb = src[cur + 1];
      if (nb === 110) {
        cur += 2;
        line++;
      } else if (nb === 114 && cur + 3 < srcLen && src[cur + 2] === 92 && src[cur + 3] === 110) {
        cur += 4;
        line++;
      } else {
        break;
      }
    }
    if (cur >= srcLen) return -1;
    if (src[cur] === 34) {
      ctx.w = st[1];
      return cur + 1;
    }
    st[0] = cur;
    st[2] = line;

    if (ctx.hasRec0) {
      let dst = ctx.uDst;
      let dstCap = dst.length - 4096;
      if (st[1] + 65536 >= dstCap) {
        ctx.w = st[1];
        ctx.rowStartW = -1;
        ctx.extraStartW = -1;
        ctx.fieldValStartW = -1;
        growCaseBuffer(ctx, 262144);
        dst = ctx.uDst;
        dstCap = dst.length - 4096;
        st[1] = ctx.w;
      }
      let pFastLim = st[0] + ((dstCap - st[1]) >> 2);
      if (pFastLim > src4) pFastLim = src4;
      if (st[0] < pFastLim) {
        fastUnified(src, sdv, dst, ctx.dDv, pFastLim, ctx.width, st);
        if (st[0] >= pFastLim && st[0] < src4) continue;
        cur = st[0];
        line = st[2];
        while (cur + 1 < srcLen && src[cur] === 92) {
          const nb = src[cur + 1];
          if (nb === 110) {
            cur += 2;
            line++;
          } else if (nb === 114 && cur + 3 < srcLen && src[cur + 2] === 92 && src[cur + 3] === 110) {
            cur += 4;
            line++;
          } else {
            break;
          }
        }
        if (cur >= srcLen) return -1;
        if (src[cur] === 34) {
          ctx.w = st[1];
          return cur + 1;
        }
        st[0] = cur;
        st[2] = line;
      }
    }

    if (!parseSlowRow(src, st[0], srcLen, ctx, st, errCodes, errLines, errRecIdxs, errExtra)) {
      return -1;
    }
  }
}

/**
 * Single-pass byte-buffer JSON+CSV transducer for /input/cases.json.
 * Processes every case independently (nothing cached across cases).
 * Returns an array of Uint8Array chunks ready for fs.writevSync, or null on unexpected top-level JSON.
 */
export function runJsonCases(inBuf) {
  const srcLen = inBuf.length;
  let p = skipWs(inBuf, 0, srcLen);
  if (p >= srcLen || inBuf[p] !== 91) return null;
  p = skipWs(inBuf, p + 1, srcLen);

  const chunks = [B_OPEN_ARR];
  if (p < srcLen && inBuf[p] === 93) {
    p = skipWs(inBuf, p + 1, srcLen);
    if (p !== srcLen) return null;
    chunks.push(B_CLOSE_ARR);
    return chunks;
  }

  const pad = srcLen < 65536 ? srcLen * 3 + 8192 : (srcLen >> 2) + 262144;
  const initOut = Buffer.allocUnsafe(Math.min(128 * 1024 * 1024, srcLen + pad));
  const uSrc = new Uint8Array(inBuf.buffer, inBuf.byteOffset, inBuf.byteLength);
  const ctx = {
    outBuf: initOut,
    uDst: new Uint8Array(initOut.buffer, initOut.byteOffset, initOut.byteLength),
    sDv: new DataView(inBuf.buffer, inBuf.byteOffset, inBuf.byteLength),
    dDv: new DataView(initOut.buffer, initOut.byteOffset, initOut.byteLength),
    st: new Int32Array(4),
    w: 0,
    width: -1,
    bodyStartW: 0,
    rowStartW: -1,
    extraStartW: -1,
    fieldValStartW: -1,
    hasRec0: false,
    rec0Slice: null,
  };

  const errCodes = [];
  const errLines = [];
  const errRecIdxs = [];
  const errExtra = [];

  let firstCase = true;

  while (true) {
    p = skipWs(inBuf, p, srcLen);
    if (p >= srcLen || inBuf[p] !== 123) return null;
    const caseStartP = p;
    if (!firstCase) chunks.push(B_COMMA);
    firstCase = false;

    errCodes.length = 0;
    errLines.length = 0;
    errRecIdxs.length = 0;
    errExtra.length = 0;

    let sawInput = false;
    let sawText = false;
    let headerVal = false;
    let needFallback = false;
    ctx.hasRec0 = false;
    ctx.rec0Slice = null;
    ctx.bodyStartW = ctx.w;
    let bodyEndW = ctx.w;

    p++;
    let firstCaseKey = true;
    while (!needFallback) {
      p = skipWs(inBuf, p, srcLen);
      if (p < srcLen && inBuf[p] === 125) {
        p++;
        break;
      }
      if (!firstCaseKey) {
        if (p >= srcLen || inBuf[p] !== 44) {
          needFallback = true;
          break;
        }
        p = skipWs(inBuf, p + 1, srcLen);
      }
      firstCaseKey = false;

      const keyStart = p;
      const keyEnd = skipJsonString(inBuf, p, srcLen);
      if (keyEnd < 0) {
        needFallback = true;
        break;
      }
      p = skipWs(inBuf, keyEnd, srcLen);
      if (p >= srcLen || inBuf[p] !== 58) {
        needFallback = true;
        break;
      }
      p = skipWs(inBuf, p + 1, srcLen);

      if (
        keyEnd - keyStart === 7 &&
        inBuf[keyStart + 1] === 105 &&
        inBuf[keyStart + 2] === 110 &&
        inBuf[keyStart + 3] === 112 &&
        inBuf[keyStart + 4] === 117 &&
        inBuf[keyStart + 5] === 116
      ) {
        if (sawInput || p >= srcLen || inBuf[p] !== 123) {
          needFallback = true;
          break;
        }
        sawInput = true;
        p++;
        let firstInputKey = true;

        while (!needFallback) {
          p = skipWs(inBuf, p, srcLen);
          if (p < srcLen && inBuf[p] === 125) {
            p++;
            break;
          }
          if (!firstInputKey) {
            if (p >= srcLen || inBuf[p] !== 44) {
              needFallback = true;
              break;
            }
            p = skipWs(inBuf, p + 1, srcLen);
          }
          firstInputKey = false;

          const ikStart = p;
          const ikEnd = skipJsonString(inBuf, p, srcLen);
          if (ikEnd < 0) {
            needFallback = true;
            break;
          }
          p = skipWs(inBuf, ikEnd, srcLen);
          if (p >= srcLen || inBuf[p] !== 58) {
            needFallback = true;
            break;
          }
          p = skipWs(inBuf, p + 1, srcLen);

          if (
            ikEnd - ikStart === 6 &&
            inBuf[ikStart + 1] === 116 &&
            inBuf[ikStart + 2] === 101 &&
            inBuf[ikStart + 3] === 120 &&
            inBuf[ikStart + 4] === 116
          ) {
            if (sawText || p >= srcLen || inBuf[p] !== 34) {
              needFallback = true;
              break;
            }
            sawText = true;
            const nextP = transduceCsvText(uSrc, p + 1, srcLen, ctx, errCodes, errLines, errRecIdxs, errExtra);
            if (nextP < 0) {
              needFallback = true;
              break;
            }
            p = nextP;
            bodyEndW = ctx.w;
          } else if (
            ikEnd - ikStart === 8 &&
            inBuf[ikStart + 1] === 104 &&
            inBuf[ikStart + 2] === 101 &&
            inBuf[ikStart + 3] === 97 &&
            inBuf[ikStart + 4] === 100 &&
            inBuf[ikStart + 5] === 101 &&
            inBuf[ikStart + 6] === 114
          ) {
            if (
              p + 4 <= srcLen &&
              inBuf[p] === 116 &&
              inBuf[p + 1] === 114 &&
              inBuf[p + 2] === 117 &&
              inBuf[p + 3] === 101 &&
              (p + 4 === srcLen || isJsonDelim(inBuf[p + 4]))
            ) {
              headerVal = true;
              p += 4;
            } else {
              p = skipJsonValue(inBuf, p, srcLen);
              if (p < 0) {
                needFallback = true;
                break;
              }
              headerVal = false;
            }
          } else {
            p = skipJsonValue(inBuf, p, srcLen);
            if (p < 0) {
              needFallback = true;
              break;
            }
          }
        }
      } else {
        p = skipJsonValue(inBuf, p, srcLen);
        if (p < 0) {
          needFallback = true;
          break;
        }
      }
    }

    if (needFallback || !sawInput || !sawText) {
      ctx.w = ctx.bodyStartW;
      const caseEndP = skipJsonValue(inBuf, caseStartP, srcLen);
      if (caseEndP < 0) return null;
      const parsedCase = JSON.parse(inBuf.toString('utf8', caseStartP, caseEndP));
      chunks.push(Buffer.from(JSON.stringify(run(parsedCase.input))));
      p = caseEndP;
    } else {
      const hasErrs = errCodes.length > 0;
      const errSlice = hasErrs ? serializeErrors(errCodes, errLines, errRecIdxs, errExtra, headerVal) : null;

      if (!ctx.hasRec0) {
        if (!hasErrs) {
          chunks.push(headerVal ? B_EMPTY_CASE_TRUE : B_EMPTY_CASE_FALSE);
        } else {
          chunks.push(headerVal ? B_EMPTY_ERR_TRUE : B_EMPTY_ERR_FALSE);
          chunks.push(errSlice);
          chunks.push(B_CLOSE_BRACKET_BRACE);
        }
      } else {
        if (headerVal) {
          chunks.push(B_PREFIX_TRUE);
          chunks.push(ctx.rec0Slice);
          chunks.push(B_MID_TRUE);
          if (bodyEndW > ctx.bodyStartW) chunks.push(ctx.outBuf.subarray(ctx.bodyStartW, bodyEndW));
        } else {
          chunks.push(B_PREFIX_FALSE);
          chunks.push(ctx.rec0Slice);
          if (bodyEndW > ctx.bodyStartW) {
            chunks.push(B_COMMA);
            chunks.push(ctx.outBuf.subarray(ctx.bodyStartW, bodyEndW));
          }
        }
        if (!hasErrs) {
          chunks.push(B_NO_ERRORS_CLOSE);
        } else {
          chunks.push(B_ERRORS_OPEN);
          chunks.push(errSlice);
          chunks.push(B_CLOSE_BRACKET_BRACE);
        }
      }
    }

    p = skipWs(inBuf, p, srcLen);
    if (p >= srcLen) return null;
    if (inBuf[p] === 44) {
      p++;
      continue;
    }
    if (inBuf[p] === 93) {
      p = skipWs(inBuf, p + 1, srcLen);
      if (p !== srcLen) return null;
      chunks.push(B_CLOSE_ARR);
      return chunks;
    }
    return null;
  }
}

// Populate V8 FeedbackVectors on all fastUnified and parseSlowRow branches in one tiny
// 16 KB buffer (< 0.2 ms) so Case 0 compiles once without Insufficient-type-feedback deopts.
{
  const fastRow = '12345678,abcdefgh\\r\\n\\"q,q\\",\\"x\\"\\"y\\"\\n\\"m\\rn\\r\\no\\",東京\\n\\r\\n\\n';
  const slowRow = '\\"a\\"b,c\\n1\\n1,2,3\\n\\"j\\"k\\r,2\\n1\\r,2\\r\\n\\"unterm\\n';
  const wText = 'a,b\\n' + (fastRow + slowRow).repeat(16) + '\\"u';
  runJsonCases(
    Buffer.from(
      '[{"id":"w0","input":{"text":"' +
        wText +
        '","header":true}},{"id":"w1","input":{"text":"\\uFEFF' +
        wText +
        '","header":false}}]',
    ),
  );
}
