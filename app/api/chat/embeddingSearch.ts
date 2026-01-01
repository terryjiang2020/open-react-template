// Embedding search utilities for chat API
// Handles multi-entity embedding search and top-K API result logic

export async function getAllMatchedApis({ entities, apiKey }: { entities: string[], apiKey: string }): Promise<Map<string, any>> {
  const allMatchedApis = new Map();
  for (const entity of entities) {
    console.log(`\n--- Searching for entity: "${entity}" ---`);
    const embeddingResponse = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'text-embedding-ada-002',
        input: entity,
      }),
    });
    if (!embeddingResponse.ok) continue;
    const embeddingData = await embeddingResponse.json();
    const entityEmbedding = embeddingData.data[0].embedding;
    const entityResults = findTopKSimilar(entityEmbedding, 10);
    const relevantResults = entityResults;
    console.log(`Found ${entityResults.length} APIs for entity "${entity}", ${relevantResults.length} after filtering:`,
      relevantResults.map((item: any) => ({ id: item.id, similarity: item.similarity.toFixed(3) }))
    );
    relevantResults.forEach((result: any) => {
      if (!allMatchedApis.has(result.id)) {
        allMatchedApis.set(result.id, result);
      }
    });
  }
  return allMatchedApis;
}

export async function getTopKResults(allMatchedApis: Map<string, any>, topK: number): Promise<any[]> {
  let topKResults = Array.from(allMatchedApis.values())
    .sort((a: any, b: any) => b.similarity - a.similarity)
    .slice(0, topK);
  console.log(`\n✅ Combined Results: Found ${allMatchedApis.size} unique APIs across all entities`);
  console.log(`📋 Top ${topKResults.length} APIs selected:`,
    topKResults.map((item: any) => ({
      id: item.id,
      similarity: item.similarity.toFixed(3)
    }))
  );
  if (topKResults.length === 0) {
    return [];
  }
  topKResults = topKResults.map((item: any) => {
    let tags: string[] = [];
    let jsonStr = item.content;
    const jsonStartIdx = item.content.indexOf('{');
    if (jsonStartIdx > 0) {
      tags = item.content.substring(0, jsonStartIdx).split(',').map((t: string) => t.trim()).filter(Boolean);
      jsonStr = item.content.substring(jsonStartIdx);
    }
    const content = JSON.parse(jsonStr);
    content.tags = tags.length > 0 ? tags : (content.tags || []);
    return content;
  });
  return topKResults;
}

// Dummy implementation for findTopKSimilar, should be replaced by actual logic from vectorizedData
function findTopKSimilar(queryEmbedding: number[], topK: number = 3): any[] {
  // This should be implemented in vectorizedData.ts and imported here
  return [];
}
