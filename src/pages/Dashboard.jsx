import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import VoucherUpload from '../components/VoucherUpload'

export default function Dashboard() {
  const [stats, setStats] = useState({ total: 0, claimed: 0, remaining: 0 })
  const [claims, setClaims] = useState([])
  const [loading, setLoading] = useState(true)

  const fetchData = async () => {
    // Fetch voucher stats
    const { data: vouchers } = await supabase
      .from('vouchers')
      .select('id, claimed')

    if (vouchers) {
      const total = vouchers.length
      const claimed = vouchers.filter((v) => v.claimed).length
      setStats({ total, claimed, remaining: total - claimed })
    }

    // Fetch recent claims
    const { data: recentClaims } = await supabase
      .from('claims_log')
      .select('id, phone_number, created_at, voucher_id, vouchers(wicode)')
      .order('created_at', { ascending: false })
      .limit(50)

    if (recentClaims) {
      setClaims(recentClaims)
    }

    setLoading(false)
  }

  useEffect(() => {
    fetchData()
  }, [])

  const handleLogout = async () => {
    await supabase.auth.signOut()
  }

  return (
    <div className="container">
      <div className="header">
        <h1>KFC Wings Campaign</h1>
        <button className="logout-btn" onClick={handleLogout}>
          Sign Out
        </button>
      </div>

      {/* Stats */}
      <div className="stats">
        <div className="stat-card">
          <h3>Total Vouchers</h3>
          <div className="value">{stats.total}</div>
        </div>
        <div className="stat-card">
          <h3>Claimed</h3>
          <div className="value">{stats.claimed}</div>
        </div>
        <div className="stat-card">
          <h3>Remaining</h3>
          <div className="value">{stats.remaining}</div>
        </div>
      </div>

      {/* Upload */}
      <VoucherUpload onUploadComplete={fetchData} />

      {/* Claims table */}
      <h2 className="section-title">Recent Claims</h2>
      {loading ? (
        <p>Loading...</p>
      ) : claims.length === 0 ? (
        <div className="empty-state">No claims yet</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Phone Number</th>
              <th>wiCode</th>
              <th>Claimed At</th>
            </tr>
          </thead>
          <tbody>
            {claims.map((claim) => (
              <tr key={claim.id}>
                <td>{claim.phone_number}</td>
                <td>{claim.vouchers?.wicode || '—'}</td>
                <td>{new Date(claim.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
