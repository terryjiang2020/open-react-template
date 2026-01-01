// Message utilities for chat API
// Handles message extraction, token estimation, and summarization

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

// 从混合响应中提取JSON部分
export function extractJSON(content: string): { json: string; text: string } | null {
  try {
    const trimmed = content.trim();
    let jsonStart = -1;
    let jsonEnd = -1;
    const objStart = trimmed.indexOf('{');
    const arrStart = trimmed.indexOf('[');
    if (objStart === -1 && arrStart === -1) return null;
    if (objStart !== -1 && (arrStart === -1 || objStart < arrStart)) {
      jsonStart = objStart;
      let braceCount = 0;
      for (let i = jsonStart; i < trimmed.length; i++) {
        if (trimmed[i] === '{') braceCount++;
        if (trimmed[i] === '}') braceCount--;
        if (braceCount === 0) {
          jsonEnd = i + 1;
          break;
        }
      }
    } else if (arrStart !== -1) {
      jsonStart = arrStart;
      let bracketCount = 0;
      for (let i = jsonStart; i < trimmed.length; i++) {
        if (trimmed[i] === '[') bracketCount++;
        if (trimmed[i] === ']') bracketCount--;
        if (bracketCount === 0) {
          jsonEnd = i + 1;
          break;
        }
      }
    }
    if (jsonStart === -1 || jsonEnd === -1) return null;
    const json = trimmed.substring(jsonStart, jsonEnd);
    const text = trimmed.substring(0, jsonStart).trim();
    JSON.parse(json);
    return { json, text };
  } catch {
    return null;
  }
}

// 估算JSON的token数量（粗略估计：1 token ≈ 4 字符）
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// 摘要用户消息以减少token使用
export async function summarizeMessages(messages: Message[], apiKey: string): Promise<Message[]> {
  if (messages.length <= 10) return messages;
  const recentMessages = messages.slice(-5);
  const oldMessages = messages.slice(0, -5);
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.NEXT_PUBLIC_OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content: '请将以下对话历史总结成简洁的要点，保留关键信息和上下文。用中文回复。',
          },
          {
            role: 'user',
            content: `对话历史：\n${oldMessages.map(m => `${m.role}: ${m.content}`).join('\n')}`,
          },
        ],
        temperature: 0,
        max_tokens: 4096,
      }),
    });
    if (response.ok) {
      const data = await response.json();
      const summary = data.choices[0]?.message?.content || '';
      return [
        { role: 'system', content: '对话历史摘要：' },
        { role: 'assistant', content: summary },
        ...recentMessages,
      ];
    }
  } catch (error: any) {
    console.warn('Error summarizing messages:', error);
  }
  return recentMessages;
}
