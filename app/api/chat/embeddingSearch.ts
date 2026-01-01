import fs from 'fs';
import path from 'path';
// Load prompt dictionary for normalization
let promptDictionary: string[] = [];
try {
    const dictPath = path.resolve(process.cwd(), 'src/doc/prompt-dictionary.txt');
    if (fs.existsSync(dictPath)) {
        promptDictionary = fs.readFileSync(dictPath, 'utf-8')
            .split(/\r?\n/)
            .map(line => line.trim().toLowerCase())
            .filter(Boolean);
    }
} catch (e) {
    console.warn('Could not load prompt dictionary:', e);
}
// Embedding search utilities for chat API
// Handles multi-entity embedding search and top-K API result logic

import { findTopKSimilar } from "./vectorizedData";
import { classifyIntent } from "./planner";

export async function getAllMatchedApis(entity: string): Promise<Map<string, any>> {
    const allMatchedApis = new Map();
    // Accepts an optional intentType: 'fetch' | 'mutate' | 'unknown'
    // If not provided, defaults to 'unknown' (no filtering)
    let intentType: 'fetch' | 'mutate' | 'unknown' = 'unknown';
    if (entity) {
        // Use the entity as the intent string for classification
        intentType = await classifyIntent(entity);
        console.log(`[RAG] Intent classified as: ${intentType}`);
    }
    console.log(`\n--- Searching for entity: "${entity}" ---`);
    const embeddingResponse = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.NEXT_PUBLIC_OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
            model: 'text-embedding-ada-002',
            input: entity,
        }),
    });
    if (!embeddingResponse.ok) return allMatchedApis;
    const embeddingData = await embeddingResponse.json();
    const entityEmbedding = embeddingData.data[0].embedding;
    let entityResults = findTopKSimilar(entityEmbedding, 10, intentType);
    // Filter results by intent type
    let relevantResults = entityResults;
    console.log(`Found ${entityResults.length} candidates for entity "${entity}", ${relevantResults.length} after intent filtering:`,
        relevantResults.map((item: any) => ({ id: item.id, similarity: item.similarity.toFixed(3) }))
    );
    relevantResults.forEach((result: any) => {
        delete result.embedding;
        if (!allMatchedApis.has(result.id)) {
        allMatchedApis.set(result.id, result);
        }
    });
    return allMatchedApis;
}

export async function locateKeyEntityInIntention(intent: string): Promise<string | null> {
    // Classify intent type first
    const intentType = await classifyIntent(intent);
    let systemPrompt = '';
    if (intentType === 'mutate') {
        systemPrompt = `You are an assistant that identifies the minimal, API-aligned action-object phrase in a user's intent. For add/remove/update actions, return the minimal phrase (e.g., "add watchlist", "remove team"). Use the dictionary below to normalize the entity/object. Do not return the subject being added.\n\nDICTIONARY:\n${promptDictionary.join(', ')}`;
    } else if (intentType === 'fetch') {
        systemPrompt = `You are an assistant that identifies the minimal, API-aligned property/object phrase in a user's intent. For fetch/get actions, return the minimal phrase (e.g., "pokemon search", "get id"). Use the dictionary below to normalize the entity/object. Do not return the subject being fetched.\n\nDICTIONARY:\n${promptDictionary.join(', ')}`;
    } else {
        systemPrompt = `You are an assistant that identifies the key entity in a user's intent. Use the dictionary below to normalize the entity/object.\n\nDICTIONARY:\n${promptDictionary.join(', ')}`;
    }

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.NEXT_PUBLIC_OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: intent },
            ],
            temperature: 0
        }),
    });

    if (!res.ok) {
        console.error('Retry planner request failed');
        throw new Error('Failed to get retry response from planner');
    }

    const resData = await res.json();
    let resp = resData.choices[0]?.message?.content || '';
    resp = resp.trim().toLowerCase();
    // Try to match/normalize to dictionary
    if (promptDictionary.length > 0) {
      for (const dictEntry of promptDictionary) {
        if (resp.includes(dictEntry)) {
          return dictEntry;
        }
      }
    }
    return resp || null;
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
  return topKResults;
}

