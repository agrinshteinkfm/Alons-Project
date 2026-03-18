import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const RESEND_API_KEY = process.env.RESEND_API_KEY
const REPORT_EMAILS = ['Alon@samediaco.com', 'Aron@kfmed.co.za']

export const config = {
  schedule: '0 7 * * *', // Every day at 7:00 AM UTC
}

export default async function handler() {
  console.log('Running daily report...')

  try {
    // Get today's date range (UTC)
    const now = new Date()
    const startOfDay = new Date(now)
    startOfDay.setUTCHours(0, 0, 0, 0)
    const endOfDay = new Date(now)
    endOfDay.setUTCHours(23, 59, 59, 999)

    // Yesterday's range for the report
    const startOfYesterday = new Date(startOfDay)
    startOfYesterday.setUTCDate(startOfYesterday.getUTCDate() - 1)
    const endOfYesterday = new Date(startOfDay)
    endOfYesterday.setUTCMilliseconds(-1)

    // Claims from yesterday
    const { data: yesterdayClaims, error: claimsError } = await supabase
      .from('claims_log')
      .select('id, phone_number, created_at, vouchers(wicode)')
      .gte('created_at', startOfYesterday.toISOString())
      .lte('created_at', endOfYesterday.toISOString())
      .order('created_at', { ascending: false })

    if (claimsError) {
      console.error('Error fetching claims:', claimsError)
    }

    const dailyClaimCount = yesterdayClaims?.length || 0

    // Total stats
    const { data: allVouchers } = await supabase
      .from('vouchers')
      .select('id, claimed')

    const totalVouchers = allVouchers?.length || 0
    const totalClaimed = allVouchers?.filter((v) => v.claimed).length || 0
    const remaining = totalVouchers - totalClaimed

    // Format date for display
    const reportDate = startOfYesterday.toLocaleDateString('en-ZA', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })

    // Build claims table rows
    let claimsTableRows = ''
    if (dailyClaimCount > 0) {
      claimsTableRows = yesterdayClaims
        .map(
          (c) =>
            `<tr>
              <td style="padding:8px;border-bottom:1px solid #eee">${c.phone_number}</td>
              <td style="padding:8px;border-bottom:1px solid #eee">${c.vouchers?.wicode || '—'}</td>
              <td style="padding:8px;border-bottom:1px solid #eee">${new Date(c.created_at).toLocaleTimeString('en-ZA')}</td>
            </tr>`
        )
        .join('')
    }

    const emailHtml = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#e4002b;color:#fff;padding:20px;border-radius:12px 12px 0 0">
          <h1 style="margin:0;font-size:22px">KFC Wings Campaign — Daily Report</h1>
          <p style="margin:8px 0 0;opacity:0.9">${reportDate}</p>
        </div>

        <div style="background:#fff;padding:20px;border:1px solid #eee">
          <h2 style="font-size:16px;color:#333;margin-top:0">Summary</h2>

          <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
            <tr>
              <td style="padding:12px;background:#f8f8f8;border-radius:8px;text-align:center;width:33%">
                <div style="font-size:28px;font-weight:bold;color:#e4002b">${dailyClaimCount}</div>
                <div style="font-size:12px;color:#888;text-transform:uppercase">Claims Yesterday</div>
              </td>
              <td style="width:8px"></td>
              <td style="padding:12px;background:#f8f8f8;border-radius:8px;text-align:center;width:33%">
                <div style="font-size:28px;font-weight:bold;color:#e4002b">${totalClaimed}</div>
                <div style="font-size:12px;color:#888;text-transform:uppercase">Total Claimed</div>
              </td>
              <td style="width:8px"></td>
              <td style="padding:12px;background:#f8f8f8;border-radius:8px;text-align:center;width:33%">
                <div style="font-size:28px;font-weight:bold;color:#e4002b">${remaining}</div>
                <div style="font-size:12px;color:#888;text-transform:uppercase">Remaining</div>
              </td>
            </tr>
          </table>

          ${
            dailyClaimCount > 0
              ? `
            <h2 style="font-size:16px;color:#333">Yesterday's Claims</h2>
            <table style="width:100%;border-collapse:collapse">
              <tr style="background:#e4002b;color:#fff">
                <th style="padding:8px;text-align:left;font-size:13px">Phone</th>
                <th style="padding:8px;text-align:left;font-size:13px">wiCode</th>
                <th style="padding:8px;text-align:left;font-size:13px">Time</th>
              </tr>
              ${claimsTableRows}
            </table>
          `
              : '<p style="color:#888;text-align:center">No claims yesterday</p>'
          }
        </div>

        <div style="background:#f8f8f8;padding:12px;border-radius:0 0 12px 12px;text-align:center;font-size:12px;color:#888">
          KFC Wings Voucher Campaign — Automated Daily Report
        </div>
      </div>
    `

    // Send via Resend
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'KFC Wings Campaign <reports@fingerlickingood.netlify.app>',
        to: REPORT_EMAILS,
        subject: `KFC Wings Daily Report — ${dailyClaimCount} claims on ${reportDate}`,
        html: emailHtml,
      }),
    })

    const resBody = await res.text()
    console.log('Resend response:', res.status, resBody)

    if (!res.ok) {
      console.error('Failed to send email:', resBody)
    } else {
      console.log('Daily report sent successfully')
    }
  } catch (err) {
    console.error('Daily report error:', err.message, err.stack)
  }
}
