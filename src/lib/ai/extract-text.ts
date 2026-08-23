import { PDFParse } from 'pdf-parse'
import mammoth from 'mammoth'
import ExcelJS from 'exceljs'
import { parse as parseCsv } from 'csv-parse/sync'
import { AiError } from './types'

// ============================================================
// Text extraction for knowledge-base file uploads.
//
// One dispatcher, one extractor per format. The knowledge base only
// ever wants plain text — everything here throws it away wrapped in
// enough structure (sheet names, row separators) for `chunkText` to
// produce sane retrieval units, then hands off to the same
// ingestDocument() pipeline a pasted document uses.
//
// Format is resolved from the file EXTENSION, not the browser-supplied
// MIME type: browsers/OSes report inconsistent (or generic
// application/octet-stream) types for .csv and .docx in particular, so
// trusting the extension is more reliable here. The extension is still
// cross-checked against an allow-list, so an unsupported file is
// rejected rather than guessed at.
// ============================================================

export type SupportedUploadExt = 'pdf' | 'docx' | 'xlsx' | 'csv' | 'txt' | 'md'

const SUPPORTED_EXTENSIONS: readonly SupportedUploadExt[] = [
  'pdf',
  'docx',
  'xlsx',
  'csv',
  'txt',
  'md',
]

/** 16 MB — matches the media-upload ceiling used elsewhere (see MEDIA_MAX_BYTES). */
export const KB_UPLOAD_MAX_BYTES = 16 * 1024 * 1024

export function resolveUploadExt(fileName: string): SupportedUploadExt | null {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)
    ? (ext as SupportedUploadExt)
    : null
}

async function extractPdf(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer })
  try {
    const result = await parser.getText()
    return result.text
  } finally {
    await parser.destroy()
  }
}

async function extractDocx(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer })
  return result.value
}

function cellToString(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    const v = value as { text?: unknown; result?: unknown; richText?: { text: string }[] }
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('')
    if (v.text !== undefined) return String(v.text)
    if (v.result !== undefined) return String(v.result)
    return ''
  }
  return String(value)
}

async function extractXlsx(buffer: Buffer): Promise<string> {
  const workbook = new ExcelJS.Workbook()
  // ExcelJS's typings want a Node Buffer as ArrayBuffer-like; a Buffer
  // satisfies its runtime expectations even though the .d.ts is stricter.
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer)

  const parts: string[] = []
  workbook.eachSheet((sheet) => {
    parts.push(`# ${sheet.name}`)
    sheet.eachRow((row) => {
      const values = row.values as unknown[]
      // row.values is 1-indexed (values[0] is always empty) — drop it.
      const cells = values.slice(1).map(cellToString)
      if (cells.some((c) => c.trim())) parts.push(cells.join(' | '))
    })
  })
  return parts.join('\n')
}

function extractCsv(buffer: Buffer): string {
  const text = buffer.toString('utf-8')
  let records: string[][]
  try {
    records = parseCsv(text, { skip_empty_lines: true, relax_column_count: true })
  } catch {
    throw new AiError('The CSV file could not be parsed.', {
      code: 'extraction_failed',
      status: 400,
    })
  }
  return records.map((row) => row.join(' | ')).join('\n')
}

/**
 * Extract plain text from an uploaded file's raw bytes. Throws
 * `AiError('extraction_failed')` on a corrupt/unreadable file so the
 * upload route can surface a clean 400 instead of a raw parser
 * exception.
 */
export async function extractTextFromFile(
  buffer: Buffer,
  ext: SupportedUploadExt,
): Promise<string> {
  try {
    switch (ext) {
      case 'pdf':
        return (await extractPdf(buffer)).trim()
      case 'docx':
        return (await extractDocx(buffer)).trim()
      case 'xlsx':
        return (await extractXlsx(buffer)).trim()
      case 'csv':
        return extractCsv(buffer).trim()
      case 'txt':
      case 'md':
        return buffer.toString('utf-8').trim()
    }
  } catch (err) {
    if (err instanceof AiError) throw err
    console.error(`[extract-text] failed to parse .${ext}:`, err)
    throw new AiError(`The file could not be read as a valid .${ext} document.`, {
      code: 'extraction_failed',
      status: 400,
    })
  }
}
