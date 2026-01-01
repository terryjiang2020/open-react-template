// Data extraction utilities for chat API
// Handles extracting useful data from API responses

export async function extractUsefulDataFromApiResponses(
  refinedQuery: string,
  finalDeliverable: string,
  existingUsefulData: string,
  apiResponse: string
): Promise<string> {
  try {
    const prompt = `You are an expert at extracting useful information from API responses to help answer user queries.\n\nGiven the original user query, the refined query, and the final deliverable generated so far,\nextract any useful data points, facts, or details from the API responses that could aid in answering the user's question.\n\nIf there is already existing useful data, integrate the new findings with it.\n\nReturn the extracted useful data in a concise format. If no new useful data is found, return the existing useful data as is.\n\nRefined User Query: ${refinedQuery}\nFinal Deliverable: ${finalDeliverable}\nExisting Useful Data: ${existingUsefulData}\nAPI Response: ${apiResponse}\n\nExtracted Useful Data: `;
    const apiKey = process.env.NEXT_PUBLIC_OPENAI_API_KEY;
    if (!apiKey) {
      return existingUsefulData;
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
            content: prompt,
          },
        ],
        temperature: 0.5,
        max_tokens: 4096,
      }),
    });
    if (!response.ok) {
      return existingUsefulData;
    }
    const data = await response.json();
    const extractedData = (existingUsefulData + ' ' + data.choices[0]?.message?.content) || existingUsefulData;
    return extractedData;
  } catch (error) {
    console.error('Error extracting useful data:', error);
    return existingUsefulData;
  }
}
