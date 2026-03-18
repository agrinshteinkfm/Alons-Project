import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const DIALOG_API_KEY = process.env.DIALOG_API_KEY
const DEAL_IMAGE_URL = process.env.DEAL_IMAGE_URL
const DIALOG_API_URL = 'https://waba.360dialog.io/v1/messages'

async function sendWhatsApp(to, body) {
  return fetch(DIALOG_API_URL, {
    method: 'POST',
    headers: {
      'D360-API-KEY': DIALOG_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body },
    }),
  })
}

async function sendWhatsAppImage(to, imageUrl, caption) {
  return fetch(DIALOG_API_URL, {
    method: 'POST',
    headers: {
      'D360-API-KEY': DIALOG_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'image',
      image: { link: imageUrl, caption },
    }),
  })
}

export async function handler(event) {
  // Webhook verification (GET)
  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {}
    const mode = params['hub.mode']
    const token = params['hub.verify_token']
    const challenge = params['hub.challenge']

    // Accept any verify token for simplicity — tighten if needed
    if (mode === 'subscribe' && challenge) {
      return { statusCode: 200, body: challenge }
    }
    return { statusCode: 403, body: 'Forbidden' }
  }

  // Incoming message (POST)
  if (event.httpMethod === 'POST') {
    try {
      const payload = JSON.parse(event.body)

      // 360dialog webhook structure
      const entry = payload?.entry?.[0]
      const changes = entry?.changes?.[0]
      const messages = changes?.value?.messages

      if (!messages || messages.length === 0) {
        // Could be a status update — acknowledge it
        return { statusCode: 200, body: 'OK' }
      }

      const msg = messages[0]
      const from = msg.from // sender phone number (e.g. "27821234567")
      const text = (msg.text?.body || '').trim()
      const messageId = msg.id

      // Check if message contains "WINGS"
      if (!/wings/i.test(text)) {
        await sendWhatsApp(
          from,
          '🍗 Welcome to the KFC Wings deal!\n\nSend the word *WINGS* to claim your exclusive voucher.'
        )
        return { statusCode: 200, body: 'OK' }
      }

      // Check if this phone number already claimed
      const { data: existingClaim } = await supabase
        .from('claims_log')
        .select('id')
        .eq('phone_number', from)
        .limit(1)
        .maybeSingle()

      if (existingClaim) {
        await sendWhatsApp(
          from,
          "You've already claimed your KFC Wings deal! 🎉\n\nEnjoy your meal!"
        )
        return { statusCode: 200, body: 'OK' }
      }

      // Find and claim next available voucher (atomic with row-level locking)
      const { data: voucher, error: voucherError } = await supabase
        .rpc('claim_next_voucher', { claimer_phone: from })

      if (voucherError || !voucher) {
        // Fallback: try manual select + update
        const { data: available } = await supabase
          .from('vouchers')
          .select('id, wicode')
          .eq('claimed', false)
          .limit(1)
          .maybeSingle()

        if (!available) {
          await sendWhatsApp(
            from,
            'Sorry, all vouchers have been claimed! 😔\n\nStay tuned for more KFC deals.'
          )
          return { statusCode: 200, body: 'OK' }
        }

        // Mark as claimed
        await supabase
          .from('vouchers')
          .update({
            claimed: true,
            claimed_by: from,
            claimed_at: new Date().toISOString(),
          })
          .eq('id', available.id)
          .eq('claimed', false) // optimistic lock

        // Log the claim
        await supabase.from('claims_log').insert({
          phone_number: from,
          voucher_id: available.id,
          message_id: messageId,
        })

        // Send deal image + voucher code
        await sendWhatsAppImage(
          from,
          DEAL_IMAGE_URL,
          `🍗 HERE'S YOUR KFC WINGS DEAL!\n\nYour wiCode voucher: *${available.wicode}*\n\nShow this code at any KFC to redeem your deal. Enjoy! 🎉`
        )

        return { statusCode: 200, body: 'OK' }
      }

      // RPC succeeded — voucher is the claimed row
      const claimedCode = voucher.wicode || voucher

      // Log the claim
      await supabase.from('claims_log').insert({
        phone_number: from,
        voucher_id: voucher.id,
        message_id: messageId,
      })

      // Send deal image + voucher code
      await sendWhatsAppImage(
        from,
        DEAL_IMAGE_URL,
        `🍗 HERE'S YOUR KFC WINGS DEAL!\n\nYour wiCode voucher: *${claimedCode}*\n\nShow this code at any KFC to redeem your deal. Enjoy! 🎉`
      )

      return { statusCode: 200, body: 'OK' }
    } catch (err) {
      console.error('Webhook error:', err)
      return { statusCode: 200, body: 'OK' } // Always 200 to prevent retries
    }
  }

  return { statusCode: 405, body: 'Method Not Allowed' }
}
