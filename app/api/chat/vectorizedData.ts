// Vectorized data utilities for chat API
// Handles loading and searching vectorized data

import { cosineSimilarity } from '@/src/utils/cosineSimilarity';
import fs from 'fs';
import path from 'path';

// TypeScript global augmentation for custom globalThis property
declare global {
  // eslint-disable-next-line no-var
  var __rag_entity: string | undefined;
}

const vectorizedDataPath = path.join(process.cwd(), 'src/doc/vectorized-data/vectorized-data.json');
const vectorizedDataApiPath = path.join(process.cwd(), 'src/doc/vectorized-data/api/vectorized-data.json');
const vectorizedDataTablePath = path.join(process.cwd(), 'src/doc/vectorized-data/table/vectorized-data.json');
// Ensure vectorizedData is always an array
let rawData = JSON.parse(fs.readFileSync(vectorizedDataPath, 'utf-8'));
let apiData = JSON.parse(fs.readFileSync(vectorizedDataApiPath, 'utf-8'));
let tableData = JSON.parse(fs.readFileSync(vectorizedDataTablePath, 'utf-8'));
export const vectorizedData = Array.isArray(rawData) ? rawData : Object.values(rawData);
export const vectorizedApiData = Array.isArray(apiData) ? apiData : Object.values(apiData);
export const vectorizedTableData = Array.isArray(tableData) ? tableData : Object.values(tableData);

export function findTopKSimilar(queryEmbedding: number[], topK: number = 3, intention: string = 'all'): any[] {
    console.log(`Searching for top ${topK} similar items with intention "${intention}"`);
  // vectorizedData is always an array
    let targetedData = vectorizedData;
    if (intention == 'fetch') {
        targetedData = vectorizedTableData;
    }
    else if (intention == 'mutate') {
        targetedData = vectorizedApiData;
    }
    return targetedData
        .map((item: any) => {
            let tags: string[] = [];
            let jsonStr = item.content;
            const jsonStartIdx = item.content.indexOf('{');
            if (jsonStartIdx > 0) {
                tags = item.content.substring(0, jsonStartIdx).split(',').map((t: string) => t.trim()).filter(Boolean);
                jsonStr = item.content.substring(jsonStartIdx);
            }
            let summary = '';
            try {
                const parsed = JSON.parse(jsonStr);
                summary = parsed.summary || '';
            } catch {}
            let similarity = cosineSimilarity(queryEmbedding, item.embedding);
            const entityText = (globalThis.__rag_entity || '').toLowerCase();
            const tagHit = tags.some(t => entityText.includes(t.toLowerCase()) || t.toLowerCase().includes(entityText));
            const summaryHit = summary && (entityText.includes(summary) || summary.includes(entityText));
            if (tagHit) similarity += 0.15;
            if (summaryHit) similarity += 0.10;
            return {
                ...item,
                similarity,
            };
        })
        .sort((a: any, b: any) => b.similarity - a.similarity)
        .slice(0, topK);
}
