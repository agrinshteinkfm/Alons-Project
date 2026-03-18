import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const DIALOG_API_KEY = process.env.DIALOG_API_KEY
const DEAL_IMAGE_URL = process.env.DEAL_IMAGE_URL
const DIALOG_API_URL = process.env.DIALOG_API_URL || 'https://waba-v2.360dialog.io/messages'

const VOUCHER_MESSAGE = (wicode) => `Congratulations on claiming your deal at KFC! Your Wicode details are:

wiCode: *${wicode}*
Expires 30 June 2026
Only valid at selected KFC stores, see the image for details or the store list below:

KFC Braamfontein
https://maps.app.goo.gl/kdSaPNMhvz6kLif69?g_st=ic

KFC Park Central
https://maps.app.goo.gl/UAjFcJ2QssqMJKwH8?g_st=ic

KFC Kensington
https://maps.app.goo.gl/QZJbASbrBootzkzT7?g_st=ic

KFC Malvern
https://maps.app.goo.gl/3FehXRtfLopQBYnU7?g_st=ic

KFC Bedford Centre
https://maps.app.goo.gl/WmQVUhB3MUdca39u8?g_st=ic

Give this wiCode to the cashier when buying 10 Zinger Wings or 10 Dunked Wings, or use at the self-service kiosk. Ask the lobby host for assistance.

It's finger lickin' good.`

// Track processed message IDs in memory to handle rapid duplicate webhooks
const processedMessages = new Set()

async function sendWhatsApp(to, body) {
  const res = await fetch(DIALOG_API_URL, {
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
  const resBody = await res.text()
  console.log('360dialog text response:', res.status, resBody)
  return res
}

async function sendWhatsAppImage(to, imageUrl, caption) {
  const res = await fetch(DIALOG_API_URL, {
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
  const resBody = await res.text()
  console.log('360dialog image response:', res.status, resBody)
  return res
}

function extractMessage(payload) {
  const entry = payload?.entry?.[0]
  const changes = entry?.changes?.[0]
  const messages = changes?.value?.messages
  if (messages && messages.length > 0) {
    const msg = messages[0]
    return { from: msg.from, text: (msg.text?.body || '').trim(), messageId: msg.id }
  }
  if (payload?.messages && payload.messages.length > 0) {
    const msg = payload.messages[0]
    return { from: msg.from, text: (msg.text?.body || '').trim(), messageId: msg.id }
  }
  if (payload?.contacts && payload?.messages) {
    const msg = payload.messages[0]
    return { from: msg.from || payload.contacts[0]?.wa_id, text: (msg.text?.body || '').trim(), messageId: msg.id }
  }
  return null
}

export async function handler(event) {
  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {}
    if (params['hub.mode'] === 'subscribe' && params['hub.challenge']) {
      return { statusCode: 200, body: params['hub.challenge'] }
    }
    return { statusCode: 403, body: 'Forbidden' }
  }

  if (event.httpMethod === 'POST') {
    try {
      const payload = JSON.parse(event.body)
      const message = extractMessage(payload)

      if (!message) {
        return { statusCode: 200, body: 'OK' }
      }

      const { from, text, messageId } = message
      console.log(`Message from ${from}: "${text}" (id: ${messageId})`)

      // --- DEDUP: in-memory guard for rapid duplicate webhooks ---
      if (messageId) {
        if (processedMessages.has(messageId)) {
          console.log('Duplicate webhook (in-memory), skipping:', messageId)
          return { statusCode: 200, body: 'OK' }
        }
        processedMessages.add(messageId)
        // Clean up old entries to prevent memory leak
        if (processedMessages.size > 1000) {
          const first = processedMessages.values().next().value
          processedMessages.delete(first)
        }
      }

      // --- DEDUP: check DB for message ID (cross-instance) ---
      if (messageId) {
        const { data: existingMsg } = await supabase
          .from('claims_log')
          .select('id')
          .eq('message_id', messageId)
          .limit(1)
          .maybeSingle()

        if (existingMsg) {
          console.log('Duplicate webhook (DB), skipping:', messageId)
          return { statusCode: 200, body: 'OK' }
        }
      }

      // Not a WINGS message — send instructions
      if (!/wings/i.test(text)) {
        await sendWhatsApp(
          from,
          '🍗 Welcome to the KFC Wings deal!\n\nSend the word *WINGS* to claim your exclusive voucher.'
        )
        return { statusCode: 200, body: 'OK' }
      }

      // --- Check if phone already claimed (using vouchers table — written atomically by RPC) ---
      const { data: alreadyClaimed } = await supabase
        .from('vouchers')
        .select('wicode')
        .eq('claimed_by', from)
        .limit(1)
        .maybeSingle()

      if (alreadyClaimed) {
        console.log('Phone already claimed (vouchers table), sending notice')
        await sendWhatsApp(
          from,
          "You've already claimed your KFC Wings deal! 🎉\n\nEnjoy your meal!"
        )
        return { statusCode: 200, body: 'OK' }
      }

      // --- Claim next voucher atomically ---
      console.log('Claiming voucher for', from)
      const { data: voucher, error: voucherError } = await supabase
        .rpc('claim_next_voucher', { claimer_phone: from })

      let claimedVoucher = voucher

      if (voucherError || !voucher) {
        console.log('RPC failed, trying fallback. Error:', voucherError?.message)

        // Check again if another instance already claimed for this phone (race condition)
        const { data: raceCheck } = await supabase
          .from('vouchers')
          .select('wicode')
          .eq('claimed_by', from)
          .limit(1)
          .maybeSingle()

        if (raceCheck) {
          console.log('Race condition resolved — voucher already claimed by parallel request')
          return { statusCode: 200, body: 'OK' }
        }

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

        await supabase
          .from('vouchers')
          .update({ claimed: true, claimed_by: from, claimed_at: new Date().toISOString() })
          .eq('id', available.id)
          .eq('claimed', false)

        claimedVoucher = available
      }

      const wicode = claimedVoucher.wicode || claimedVoucher
      console.log('Voucher claimed:', wicode)

      // Log the claim
      await supabase.from('claims_log').insert({
        phone_number: from,
        voucher_id: claimedVoucher.id,
        message_id: messageId,
      })

      // Send image + voucher message
      await sendWhatsAppImage(from, DEAL_IMAGE_URL, VOUCHER_MESSAGE(wicode))

      return { statusCode: 200, body: 'OK' }
    } catch (err) {
      console.error('Webhook error:', err.message, err.stack)
      return { statusCode: 200, body: 'OK' }
    }
  }

  return { statusCode: 405, body: 'Method Not Allowed' }
}
