import fs from 'fs';
import NodeCache from 'node-cache';

export class CacheService {
  private cache: NodeCache;
  private filePath: string;

  public constructor(filePath: string) {
    this.cache = new NodeCache({ stdTTL: 0, checkperiod: 0 });
    this.filePath = filePath;
  }

  public set<T>(key: string, value: T, ttlSeconds?: string | number) {
    this.cache.set(key, value, ttlSeconds ?? 0);
  }

  public mset(entries: Record<string, unknown>) {
    this.cache.mset(Object.entries(entries).map(([key, value]) => ({ key, val: value })));
  }

  public get<T = unknown>(key: string) {
    return this.cache.get<T>(key);
  }

  public del(key: string) {
    this.cache.del(key);
  }

  public persistToDisk() {
    const content = this.cache.keys().reduce((acc, key) => {
      const value = this.cache.get(key);
      if (value !== undefined) acc[key] = value;
      return acc;
    }, {} as Record<string, unknown>);
    fs.writeFileSync(this.filePath, JSON.stringify(content, null, 2));
  }

  public loadFromDisk() {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const content = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      this.mset(content);
    } catch (err) {
      console.error('Failed to load cache from disk:', err);
    }
  }
}
