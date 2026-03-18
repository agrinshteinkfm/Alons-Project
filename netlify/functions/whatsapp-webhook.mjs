import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const DIALOG_API_KEY = process.env.DIALOG_API_KEY
const DEAL_IMAGE_URL = process.env.DEAL_IMAGE_URL
// Try Cloud API v2 endpoint first; fall back with DIALOG_API_URL env var if needed
const DIALOG_API_URL = process.env.DIALOG_API_URL || 'https://waba-v2.360dialog.io/messages'

async function sendWhatsApp(to, body) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body },
  }
  console.log('Sending text message:', JSON.stringify(payload))
  const res = await fetch(DIALOG_API_URL, {
    method: 'POST',
    headers: {
      'D360-API-KEY': DIALOG_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  const resBody = await res.text()
  console.log('360dialog text response:', res.status, resBody)
  return res
}

async function sendWhatsAppImage(to, imageUrl, caption) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'image',
    image: { link: imageUrl, caption },
  }
  console.log('Sending image message:', JSON.stringify(payload))
  const res = await fetch(DIALOG_API_URL, {
    method: 'POST',
    headers: {
      'D360-API-KEY': DIALOG_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  const resBody = await res.text()
  console.log('360dialog image response:', res.status, resBody)
  return res
}

function extractMessage(payload) {
  // Format 1: Cloud API / Meta format (entry.changes.value.messages)
  const entry = payload?.entry?.[0]
  const changes = entry?.changes?.[0]
  const messages = changes?.value?.messages
  if (messages && messages.length > 0) {
    const msg = messages[0]
    return {
      from: msg.from,
      text: (msg.text?.body || '').trim(),
      messageId: msg.id,
    }
  }

  // Format 2: Older 360dialog on-premise format (messages array at root)
  if (payload?.messages && payload.messages.length > 0) {
    const msg = payload.messages[0]
    return {
      from: msg.from,
      text: (msg.text?.body || '').trim(),
      messageId: msg.id,
    }
  }

  // Format 3: contacts + messages at root
  if (payload?.contacts && payload?.messages) {
    const msg = payload.messages[0]
    return {
      from: msg.from || payload.contacts[0]?.wa_id,
      text: (msg.text?.body || '').trim(),
      messageId: msg.id,
    }
  }

  return null
}

export async function handler(event) {
  console.log('Webhook hit:', event.httpMethod)

  // Webhook verification (GET)
  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {}
    const mode = params['hub.mode']
    const challenge = params['hub.challenge']

    if (mode === 'subscribe' && challenge) {
      console.log('Webhook verified, challenge:', challenge)
      return { statusCode: 200, body: challenge }
    }
    return { statusCode: 403, body: 'Forbidden' }
  }

  // Incoming message (POST)
  if (event.httpMethod === 'POST') {
    try {
      const payload = JSON.parse(event.body)
      console.log('Incoming payload:', JSON.stringify(payload))

      const message = extractMessage(payload)

      if (!message) {
        console.log('No message found in payload (likely a status update)')
        return { statusCode: 200, body: 'OK' }
      }

      const { from, text, messageId } = message
      console.log(`Message from ${from}: "${text}" (id: ${messageId})`)

      // Check env vars
      console.log('DIALOG_API_KEY set:', !!DIALOG_API_KEY)
      console.log('DEAL_IMAGE_URL:', DEAL_IMAGE_URL)
      console.log('SUPABASE_URL set:', !!process.env.SUPABASE_URL)

      // Check if message contains "WINGS"
      if (!/wings/i.test(text)) {
        console.log('Message does not contain WINGS, sending instructions')
        await sendWhatsApp(
          from,
          '🍗 Welcome to the KFC Wings deal!\n\nSend the word *WINGS* to claim your exclusive voucher.'
        )
        return { statusCode: 200, body: 'OK' }
      }

      console.log('WINGS detected, checking for existing claim...')

      // Check if this phone number already claimed
      const { data: existingClaim, error: claimCheckError } = await supabase
        .from('claims_log')
        .select('id')
        .eq('phone_number', from)
        .limit(1)
        .maybeSingle()

      if (claimCheckError) {
        console.error('Error checking existing claim:', claimCheckError)
      }

      if (existingClaim) {
        console.log('Phone already claimed, sending duplicate message')
        await sendWhatsApp(
          from,
          "You've already claimed your KFC Wings deal! 🎉\n\nEnjoy your meal!"
        )
        return { statusCode: 200, body: 'OK' }
      }

      // Find and claim next available voucher (atomic with row-level locking)
      console.log('Trying RPC claim_next_voucher...')
      const { data: voucher, error: voucherError } = await supabase
        .rpc('claim_next_voucher', { claimer_phone: from })

      if (voucherError) {
        console.error('RPC error:', voucherError)
      }

      if (voucherError || !voucher) {
        console.log('RPC failed or no voucher, trying fallback...')
        // Fallback: try manual select + update
        const { data: available, error: selectError } = await supabase
          .from('vouchers')
          .select('id, wicode')
          .eq('claimed', false)
          .limit(1)
          .maybeSingle()

        if (selectError) {
          console.error('Fallback select error:', selectError)
        }

        if (!available) {
          console.log('No vouchers available')
          await sendWhatsApp(
            from,
            'Sorry, all vouchers have been claimed! 😔\n\nStay tuned for more KFC deals.'
          )
          return { statusCode: 200, body: 'OK' }
        }

        console.log('Claiming voucher:', available.wicode)

        // Mark as claimed
        const { error: updateError } = await supabase
          .from('vouchers')
          .update({
            claimed: true,
            claimed_by: from,
            claimed_at: new Date().toISOString(),
          })
          .eq('id', available.id)
          .eq('claimed', false)

        if (updateError) {
          console.error('Update error:', updateError)
        }

        // Log the claim
        const { error: insertError } = await supabase.from('claims_log').insert({
          phone_number: from,
          voucher_id: available.id,
          message_id: messageId,
        })

        if (insertError) {
          console.error('Claims log insert error:', insertError)
        }

        // Send deal image + voucher code
        await sendWhatsAppImage(
          from,
          DEAL_IMAGE_URL,
          `🍗 HERE'S YOUR KFC WINGS DEAL!\n\nYour wiCode voucher: *${available.wicode}*\n\nShow this code at any KFC to redeem your deal. Enjoy! 🎉`
        )

        return { statusCode: 200, body: 'OK' }
      }

      // RPC succeeded
      const claimedCode = voucher.wicode || voucher
      console.log('RPC claimed voucher:', claimedCode)

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
      console.error('Webhook error:', err.message, err.stack)
      return { statusCode: 200, body: 'OK' }
    }
  }

  return { statusCode: 405, body: 'Method Not Allowed' }
}
