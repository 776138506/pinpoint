// 协议实测：直连 localhost:8897，创建新会话并发送文本/图片 session.prompt
const BASE = process.env.DSH_POINT_BASE || 'http://localhost:8897'

const tinyPngB64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function rpc(method, payload) {
  const rpcId = crypto.randomUUID()
  return fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  }).then(async (r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`)
    const full = await r.json()
    return { rpcId, full }
  })
}

async function main() {
  console.log('--- 1. list sessions ---')
  const list = await rpc('session.list', {})
  console.log(JSON.stringify(list.full, null, 2))

  console.log('\n--- 2. create test session ---')
  const created = await rpc('session.create', {})
  console.log(JSON.stringify(created.full, null, 2))
  const sessionId = created.full.result?.value?.sessionId
  if (!sessionId) throw new Error('创建会话未返回 sessionId')

  console.log('\n--- 3. session.prompt text only ---')
  const textPrompt = await rpc('session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: '[所指 #1] 来源：页面\n文本摘录：协议测试文本消息\n选择器：body > div\n评论：这是扩展 D1 协议实测的纯文本所指。' }],
    clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  })
  console.log(JSON.stringify(textPrompt.full, null, 2))

  console.log('\n--- 4. session.prompt with image ---')
  const imagePrompt = await rpc('session.prompt', {
    sessionId,
    mode: 'queue',
    content: [
      { type: 'text', text: '[所指 #2] 来源：页面\n评论：这是带图片附件的所指，附件为 1x1 PNG。' },
      { type: 'image', mediaType: 'image/png', data: tinyPngB64, name: 'point-test.png' },
    ],
    clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  })
  console.log(JSON.stringify(imagePrompt.full, null, 2))

  console.log('\n--- 5. session.history tail ---')
  await new Promise((r) => setTimeout(r, 500))
  const history = await rpc('session.history', { sessionId, maxMessages: 10 })
  console.log(JSON.stringify(history.full, null, 2))

  console.log('\nSESSION_ID=', sessionId)
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})
