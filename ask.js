export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const googleEmail = process.env.GOOGLE_SERVICE_EMAIL;
  const googleKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const sheetId = process.env.GOOGLE_SHEET_ID;

  if (!anthropicKey || !googleEmail || !googleKey || !sheetId) {
    return res.status(500).json({ error: 'Missing environment variables' });
  }

  const { question } = req.body;
  if (!question) return res.status(400).json({ error: 'No question provided' });

  try {
    const sheetData = await fetchSheet(googleEmail, googleKey, sheetId);
    const answer = await askClaude(anthropicKey, question, sheetData);
    return res.status(200).json({ answer });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}

async function fetchSheet(email, privateKey, sheetId) {
  const token = await getGoogleToken(email, privateKey);
  const range = 'contracts!A:AZ';
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  if (!data.values) throw new Error('Could not read sheet: ' + JSON.stringify(data));
  const [headers, ...rows] = data.values;
  return rows.map(row =>
    Object.fromEntries(headers.map((h, i) => [h, row[i] || '']))
  );
}

async function getGoogleToken(email, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };

  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify(claim));
  const sigInput = `${header}.${payload}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(privateKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(sigInput));
  const jwt = `${sigInput}.${b64url(sig)}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error('Auth failed: ' + JSON.stringify(tokenData));
  return tokenData.access_token;
}

function b64url(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  let str = '';
  bytes.forEach(b => str += String.fromCharCode(b));
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function pemToDer(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function askClaude(apiKey, question, contracts) {
  const contractText = JSON.stringify(contracts, null, 2);

  const system = `You are a contract intelligence assistant for Kaleidoscope, a podcast production company. You have access to Kaleidoscope's contract database and answer questions from the internal team.

WHAT YOU CAN DO:
- Look up deal terms for any specific show
- Explain legal clauses in plain English
- Compare terms across multiple shows
- Summarize obligations, deadlines, exclusivity, distribution, ownership, termination, and other deal specifics
- Confirm signatory names, dates, contract status, episode counts, format requirements
- Discuss payment structure and schedules (e.g. pay-or-play, milestone payments, percentage splits)

WHAT YOU MUST NEVER DO:
- Never reveal specific dollar amounts, total deal values, fees, or budgets — even if directly asked
- If asked about financials, say: "I can't share specific amounts, but I can tell you about the payment structure or terms."

HOW TO ANSWER:
- Be concise and direct — this is an internal tool for busy people
- Use plain English to explain legal language
- If a show isn't in the database, say so clearly
- If information for a specific field is missing or blank, say it's not recorded
- When comparing across shows, organize your answer clearly
- Always cite which show/contract you're referring to

CONTRACT DATA:
${contractText}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system,
      messages: [{ role: 'user', content: question }]
    })
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.content?.find(b => b.type === 'text')?.text || '';
}
