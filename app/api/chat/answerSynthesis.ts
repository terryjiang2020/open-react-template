// Answer synthesis utilities for chat API
// Handles generating final answers based on accumulated information

export async function generateFinalAnswer(
  originalQuery: string,
  accumulatedResults: any[],
  apiKey: string,
  stoppedReason?: string,
  usefulData?: string
): Promise<string> {
  try {
    let systemPrompt = `You are a helpful assistant that synthesizes information from API responses to answer user questions.\nProvide a clear, concise, and well-formatted answer based on the accumulated data.\nUse the actual data from the API responses to provide specific, accurate information.`;
    let additionalContext = '';
    if (stoppedReason === 'max_iterations') {
      additionalContext = '\nNOTE: The process stopped due to reaching the maximum number of iterations.';
    } else if (stoppedReason === 'stuck_state') {
      additionalContext = '\nNOTE: The process stopped due to repeated validation failures.';
    }
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: systemPrompt + additionalContext,
          },
          {
            role: 'user',
            content: `Original Question: ${originalQuery}\n\nAPI Response Data:\n${JSON.stringify(accumulatedResults, null, 2)}${usefulData || ''}\n\nIMPORTANT: The data above includes complete arrays. Pay careful attention to:\n- Learning methods for moves (level-up, tutor, machine, egg, etc.)\n- Type information for moves\n- Power values for moves\n- Any other detailed attributes\n\nOnly state facts that are explicitly present in the data. Do not make assumptions about learning methods or other attributes.`,
          },
        ],
        temperature: 0.7,
        max_tokens: 2048,
      }),
    });
    if (!response.ok) {
      return 'Unable to generate answer.';
    }
    const data = await response.json();
    return data.choices[0]?.message?.content || 'Unable to generate answer.';
  } catch (error) {
    console.error('Error generating final answer:', error);
    return 'Unable to generate answer.';
  }
}
