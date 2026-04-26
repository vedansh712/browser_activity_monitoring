import { DEFAULT_CATEGORIES } from '../shared/constants.js';
import * as storage from './storage-manager.js';

// Cache AI results per domain to avoid repeated calls
const aiCache = new Map();

/**
 * Attempt AI classification. Tries Chrome built-in AI first, then external API.
 * Returns categoryId or null if AI is unavailable.
 */
export async function aiClassify({ domain, title, metaDescription }) {
  // Check cache first
  if (aiCache.has(domain)) {
    return aiCache.get(domain);
  }

  // Build the category list for the prompt
  const categoryNames = DEFAULT_CATEGORIES
    .filter((c) => c.id !== 'uncategorized')
    .map((c) => c.name);

  const prompt = buildPrompt(domain, title, metaDescription, categoryNames);

  // Try Chrome built-in AI (Gemini Nano) first
  let result = await tryBuiltInAI(prompt);

  // Fall back to external API if built-in is unavailable
  if (!result) {
    result = await tryExternalAPI(prompt);
  }

  if (result) {
    const categoryId = mapResponseToCategory(result);
    if (categoryId) {
      aiCache.set(domain, categoryId);
      return categoryId;
    }
  }

  return null;
}

function buildPrompt(domain, title, metaDescription, categoryNames) {
  const categoriesList = categoryNames.join(', ');
  const desc = metaDescription ? `, description='${metaDescription.slice(0, 150)}'` : '';
  return `Classify this website into exactly one of these categories: ${categoriesList}. Website: domain='${domain}', title='${title}'${desc}. Reply with ONLY the category name, nothing else.`;
}

// ─── Chrome Built-in AI (Gemini Nano) ──────────────────────────────

async function tryBuiltInAI(prompt) {
  try {
    // Check if the API is available
    if (!self.ai || !self.ai.languageModel) {
      return null;
    }

    const capabilities = await self.ai.languageModel.capabilities();
    if (capabilities.available === 'no') {
      return null;
    }

    const session = await self.ai.languageModel.create({
      temperature: 0,
      topK: 1,
    });

    const response = await session.prompt(prompt);
    session.destroy();

    return response ? response.trim() : null;
  } catch (err) {
    console.warn('[Track Daily] Built-in AI unavailable:', err.message);
    return null;
  }
}

// ─── External API (User-provided key) ──────────────────────────────

async function tryExternalAPI(prompt) {
  try {
    const settings = await storage.getSettings();
    if (!settings.aiApiKey || !settings.aiProvider) {
      return null;
    }

    switch (settings.aiProvider) {
      case 'openai':
        return await callOpenAI(settings.aiApiKey, prompt);
      case 'anthropic':
        return await callAnthropic(settings.aiApiKey, prompt);
      case 'gemini':
        return await callGemini(settings.aiApiKey, prompt);
      default:
        return null;
    }
  } catch (err) {
    console.warn('[Track Daily] External AI error:', err.message);
    return null;
  }
}

async function callOpenAI(apiKey, prompt) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 20,
      temperature: 0,
    }),
  });
  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || null;
}

async function callAnthropic(apiKey, prompt) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 20,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await response.json();
  return data.content?.[0]?.text?.trim() || null;
}

async function callGemini(apiKey, prompt) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 20, temperature: 0 },
      }),
    }
  );
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
}

// ─── Map AI response to our category ID ────────────────────────────

function mapResponseToCategory(response) {
  const normalized = response.toLowerCase().trim();

  for (const category of DEFAULT_CATEGORIES) {
    if (category.id === 'uncategorized') continue;
    if (normalized === category.name.toLowerCase()) return category.id;
    if (normalized.includes(category.name.toLowerCase())) return category.id;
    // Partial match on key words
    const words = category.name.toLowerCase().split(/[\s&]+/);
    if (words.some((w) => w.length > 3 && normalized.includes(w))) return category.id;
  }

  return null;
}

/**
 * Check if any AI classification method is available.
 */
export async function isAIAvailable() {
  // Check built-in
  if (self.ai && self.ai.languageModel) {
    try {
      const capabilities = await self.ai.languageModel.capabilities();
      if (capabilities.available !== 'no') return true;
    } catch { /* ignore */ }
  }

  // Check external API key
  const settings = await storage.getSettings();
  return !!(settings.aiApiKey && settings.aiProvider);
}
