import { createServer } from 'node:http';

const observation = {
  caption: 'A synthetic archive test image.',
  objects: ['synthetic fixture'], activities: [], tags: ['Synthetic'], ocr: ['夏'], category: 'photo',
  evidence: [{ id: 'fixture', kind: 'visual', text: 'Synthetic runtime response; no real location inference.' }],
  date: { start: '2014-08-01', end: '2014-08-31', precision: 'month', kind: 'capture', confidence: 'high', evidenceIds: ['fixture'] },
  location: { name: 'Paris', latitude: 48.8566, longitude: 2.3522, precision: 'city', kind: 'capture', confidence: 'high', evidenceIds: ['fixture'] },
  event: 'Synthetic archive event',
};

function firstUuid(value) {
  return String(value || '').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

function keeperResponse(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  if (!tools.length) return { content: JSON.stringify(observation) };
  const toolMessages = messages.filter((message) => message?.role === 'tool');
  if (!toolMessages.length) {
    return {
      content: 'I will search the inventoried photos.',
      tool_calls: [{ id: 'keeper-search-1', type: 'function', function: { name: 'search_photos', arguments: JSON.stringify({ query: 'runtime' }) } }],
    };
  }
  if (toolMessages.length === 1) {
    return {
      content: 'I will inspect the owner-authorized preview.',
      tool_calls: [{ id: 'keeper-inspect-1', type: 'function', function: { name: 'inspect_photo', arguments: JSON.stringify({ assetId: firstUuid(toolMessages[0].content) || '00000000-0000-4000-8000-000000000000' }) } }],
    };
  }
  const sawPixels = messages.some((message) => Array.isArray(message?.content) && message.content.some((part) => part?.type === 'image_url' && typeof part.image_url?.url === 'string' && part.image_url.url.startsWith('data:image/')));
  return { content: sawPixels ? 'Keeper inspected the current preview pixels and found the requested runtime photo.' : 'Keeper could not receive the current preview pixels.' };
}

createServer(async (req, res) => {
  const body = await readJson(req);
  const message = Array.isArray(body.tools) && body.tools.length ? keeperResponse(body) : { content: JSON.stringify(observation) };
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ model: body.model || 'glm-5v-test', choices: [{ message }] }));
}).listen(8092, '0.0.0.0');
