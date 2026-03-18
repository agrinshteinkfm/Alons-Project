import { useState, useRef } from 'react'
import Papa from 'papaparse'
import { supabase } from '../lib/supabase'

export default function VoucherUpload({ onUploadComplete }) {
  const [uploading, setUploading] = useState(false)
  const [result, setResult] = useState(null)
  const fileRef = useRef()

  const handleUpload = async () => {
    const file = fileRef.current?.files[0]
    if (!file) return

    setUploading(true)
    setResult(null)

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (results) => {
        // Expect a column named "wicode" (case-insensitive header match)
        const codes = results.data
          .map((row) => {
            // Find the wicode column regardless of case
            const key = Object.keys(row).find(
              (k) => k.toLowerCase().trim() === 'wicode'
            )
            return key ? row[key]?.trim() : null
          })
          .filter(Boolean)

        if (codes.length === 0) {
          setResult({ ok: false, message: 'No wicode column found in CSV' })
          setUploading(false)
          return
        }

        const rows = codes.map((code) => ({ wicode: code }))

        const { error } = await supabase.from('vouchers').insert(rows)

        if (error) {
          setResult({ ok: false, message: error.message })
        } else {
          setResult({ ok: true, message: `Uploaded ${rows.length} voucher codes` })
          fileRef.current.value = ''
          onUploadComplete?.()
        }

        setUploading(false)
      },
    })
  }

  return (
    <div className="upload-section">
      <h2>Upload Voucher Codes (CSV)</h2>
      <p style={{ fontSize: '0.85rem', color: '#888', marginBottom: '0.75rem' }}>
        CSV must have a <strong>wicode</strong> column
      </p>
      <div className="upload-row">
        <input type="file" accept=".csv" ref={fileRef} />
        <button onClick={handleUpload} disabled={uploading}>
          {uploading ? 'Uploading...' : 'Upload'}
        </button>
      </div>
      {result && (
        <p
          className="upload-result"
          style={{ color: result.ok ? '#28a745' : '#e4002b' }}
        >
          {result.message}
        </p>
      )}
    </div>
  )
}
