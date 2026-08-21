// Protocol probe for dsh-point batch D1: verify the external apiproxy envelope
// against the running acceptance host at http://localhost:8897 (point-test profile).
//
// Read-only list first; then create a dedicated throwaway session and send
// session.prompt (text-only and text+image) into it. Never touches user sessions.
//
// Usage: node spike/probe-8897.mjs [method]

const BASE = 'http://localhost:8897'
let seq = 0
function rpcId() {
  seq += 1
  return `d1-probe-${Date.now()}-${seq}`
}

async function rpc(method, payload = {}) {
  const id = rpcId()
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: id, method, payload }),
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text }
  }
  return { status: res.status, id, json }
}

function brief(result) {
  if (!result.ok) return result
  return { ok: true, value: result.value }
}

const cmd = process.argv[2] ?? 'list'

if (cmd === 'list') {
  const { status, json } = await rpc('session.list', {})
  console.log('session.list status:', status)
  console.log(JSON.stringify(json, null, 2))
} else if (cmd === 'describe') {
  const { status, json } = await rpc('host.describe', {})
  console.log('host.describe status:', status)
  console.log(JSON.stringify(json, null, 2))
} else if (cmd === 'create') {
  const { status, json } = await rpc('session.create', {})
  console.log('session.create status:', status)
  console.log(JSON.stringify(json, null, 2))
} else if (cmd === 'prompt-text') {
  const sessionId = process.argv[3]
  const { status, json } = await rpc('session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: '[D1 探针] 纯文本所指到达测试' }],
  })
  console.log('session.prompt(text) status:', status)
  console.log(JSON.stringify(json, null, 2))
} else if (cmd === 'prompt-image') {
  const sessionId = process.argv[3]
  // 1x1 red PNG.
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const { status, json } = await rpc('session.prompt', {
    sessionId,
    mode: 'queue',
    content: [
      { type: 'text', text: '[D1 探针] 带图片附件的所指' },
      { type: 'image', mediaType: 'image/png', data: b64, name: 'probe.png' },
    ],
  })
  console.log('session.prompt(image) status:', status)
  console.log(JSON.stringify(json, null, 2))
} else if (cmd === 'history') {
  const sessionId = process.argv[3]
  const { status, json } = await rpc('session.history', { sessionId, maxMessages: 20 })
  console.log('session.history status:', status)
  // Print a compact view: message events + whether image attachment refs appear.
  const out = json?.result?.value?.events?.map((e) => ({
    type: e.event?.type,
    seq: e.event?.seq,
    source: e.event?.data?.source?.kind,
    dataType: Array.isArray(e.event?.data?.content) ? e.event.data.content.map(c => c.type) : undefined,
    text: typeof e.event?.data?.content === 'string' ? e.event.data.content.slice(0, 120) : undefined,
  }))
  console.log(JSON.stringify(out ?? json, null, 2))
} else {
  console.log('unknown cmd:', cmd)
}
