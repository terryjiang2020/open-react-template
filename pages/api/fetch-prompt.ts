import { promises as fs } from 'fs';
import path from 'path';
import type { NextApiRequest, NextApiResponse } from 'next';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { fileName } = req.query;

  if (typeof fileName !== 'string') {
    return res.status(400).json({ error: 'Invalid file name' });
  }

  try {
    const filePath = path.join(process.cwd(), 'src', 'doc', fileName);
    const fileContent = await fs.readFile(filePath, 'utf-8');
    res.status(200).send(fileContent);
  } catch (error: any) {
    res.status(500).json({ error: `Failed to fetch prompt file: ${error.message}` });
  }
}