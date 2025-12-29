// Function to calculate the dot product of two vectors
function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

// Function to normalize a vector
function normalize(v: number[]): number[] {
  const norm = Math.sqrt(dot(v, v));
  return v.map(x => x / norm);
}

// Function to calculate cosine similarity between two vectors
export function cosineSimilarity(a: number[], b: number[]): number {
  return dot(normalize(a), normalize(b));
}