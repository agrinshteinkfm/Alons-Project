import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const DIALOG_API_KEY = process.env.DIALOG_API_KEY
const DEAL_IMAGE_URL = process.env.DEAL_IMAGE_URL
const DIALOG_API_URL = process.env.DIALOG_API_URL || 'https://waba-v2.360dialog.io/messages'
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET // optional: shared secret for webhook auth

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
  return null
}

export async function handler(event) {
  // --- Webhook verification (GET) ---
  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {}
    if (params['hub.mode'] === 'subscribe' && params['hub.challenge']) {
      return { statusCode: 200, body: params['hub.challenge'] }
    }
    return { statusCode: 403, body: 'Forbidden' }
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' }
  }

  // --- Optional webhook authentication ---
  if (WEBHOOK_SECRET) {
    const authHeader = event.headers['x-webhook-secret'] || event.headers['X-Webhook-Secret']
    if (authHeader !== WEBHOOK_SECRET) {
      console.log('Unauthorized webhook request')
      return { statusCode: 401, body: 'Unauthorized' }
    }
  }

  try {
    const payload = JSON.parse(event.body)
    const message = extractMessage(payload)

    if (!message) {
      return { statusCode: 200, body: 'OK' }
    }

    const { from, text, messageId } = message
    console.log(`Message from ${from}: "${text}" (id: ${messageId})`)

    // --- DEDUP: only one of N parallel webhooks can win this insert ---
    if (messageId) {
      const { error: dedupError } = await supabase
        .from('message_dedup')
        .insert({ message_id: messageId })

      if (dedupError) {
        console.log('Duplicate webhook blocked by dedup table, skipping:', messageId)
        return { statusCode: 200, body: 'OK' }
      }
    }

    // --- Not a WINGS message — send instructions ---
    if (!/wings/i.test(text)) {
      await sendWhatsApp(
        from,
        '🍗 Welcome to the KFC Wings deal!\n\nSend the word *WINGS* to claim your exclusive voucher.'
      )
      return { statusCode: 200, body: 'OK' }
    }

    // --- Claim voucher via RPC (atomic: checks phone + locks + claims in one transaction) ---
    console.log('Claiming voucher for', from)
    const { data: voucher, error: voucherError } = await supabase
      .rpc('claim_next_voucher', { claimer_phone: from })

    if (voucherError) {
      console.error('RPC error:', voucherError.message)
    }

    // RPC returns NULL if phone already claimed OR no vouchers left
    if (!voucher) {
      // Determine which case: already claimed or out of stock
      const { data: existingVoucher } = await supabase
        .from('vouchers')
        .select('wicode')
        .eq('claimed_by', from)
        .limit(1)
        .maybeSingle()

      if (existingVoucher) {
        console.log('Phone already claimed:', from)
        await sendWhatsApp(
          from,
          "You've already claimed your KFC Wings deal! 🎉\n\nEnjoy your meal!"
        )
      } else {
        console.log('No vouchers remaining')
        await sendWhatsApp(
          from,
          'Sorry, all vouchers have been claimed! 😔\n\nStay tuned for more KFC deals.'
        )
      }
      return { statusCode: 200, body: 'OK' }
    }

    const wicode = voucher.wicode
    console.log('Voucher claimed:', wicode)

    // --- Log the claim (unique constraint on phone_number prevents duplicates) ---
    const { error: insertError } = await supabase.from('claims_log').insert({
      phone_number: from,
      voucher_id: voucher.id,
      message_id: messageId,
    })

    if (insertError) {
      // Unique constraint violation = duplicate request that slipped through
      if (insertError.code === '23505') {
        console.log('Duplicate claim insert blocked by DB constraint, skipping reply')
        return { statusCode: 200, body: 'OK' }
      }
      console.error('Claims log insert error:', insertError)
    }

    // --- Send image + voucher message ---
    await sendWhatsAppImage(from, DEAL_IMAGE_URL, VOUCHER_MESSAGE(wicode))

    return { statusCode: 200, body: 'OK' }
  } catch (err) {
    console.error('Webhook error:', err.message, err.stack)
    return { statusCode: 200, body: 'OK' }
  }
}
