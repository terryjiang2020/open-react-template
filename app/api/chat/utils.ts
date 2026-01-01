import fs from 'fs';
import path from 'path';

export function createTempFile(prefix: string, content: string): string {
  const tempDir = path.join(process.cwd(), '.temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
  }
  const filePath = path.join(tempDir, `${prefix}-${Date.now()}.txt`);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}
