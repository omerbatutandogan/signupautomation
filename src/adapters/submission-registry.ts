import { readFile, readdir } from 'node:fs/promises';
import { parseSubmissionConfig, type ValidatedSubmissionConfig } from './submission-schema.js';

export const SUBMISSIONS_DIR = 'src/submissions';

export async function loadSubmissionConfig(siteId: string, dir = SUBMISSIONS_DIR): Promise<ValidatedSubmissionConfig> {
  const path = `${dir}/${siteId}.json`;
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new Error(`Listeleme config'i bulunamadı: ${path}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} geçerli JSON değil: ${(err as Error).message}`);
  }
  return parseSubmissionConfig(json, path);
}

export async function listSubmissionIds(dir = SUBMISSIONS_DIR): Promise<string[]> {
  return (await readdir(dir).catch(() => [] as string[]))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}
