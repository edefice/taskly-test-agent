import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveDatabaseUrl } from '../src/core/config.ts';

const parts = {
  POSTGRES_USER: 'user',
  POSTGRES_PASSWORD: 'secret',
  POSTGRES_HOST: 'db.example',
  DB_PORT: '5433',
  POSTGRES_DB: 'taskly',
};

beforeEach(() => {
  vi.stubEnv('DATABASE_URL', '');
  for (const [name, value] of Object.entries(parts)) vi.stubEnv(name, value);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveDatabaseUrl', () => {
  it('prefers the override over the environment', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://env/db');
    expect(resolveDatabaseUrl('postgresql://override/db')).toBe('postgresql://override/db');
  });

  it('uses DATABASE_URL when there is no override', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://env/db');
    expect(resolveDatabaseUrl()).toBe('postgresql://env/db');
  });

  it('rewrites the postgresql+psycopg scheme', () => {
    expect(resolveDatabaseUrl('postgresql+psycopg://u:p@h:1/d')).toBe('postgresql://u:p@h:1/d');
  });

  it('builds the URL from the separate variables', () => {
    expect(resolveDatabaseUrl()).toBe('postgresql://user:secret@db.example:5433/taskly');
  });

  it('encodes special characters in the database name', () => {
    vi.stubEnv('POSTGRES_DB', 'a/b');
    expect(resolveDatabaseUrl()).toBe('postgresql://user:secret@db.example:5433/a%2Fb');
  });

  it('encodes a percent sign in the database name', () => {
    vi.stubEnv('POSTGRES_DB', 'a%b');
    expect(resolveDatabaseUrl()).toBe('postgresql://user:secret@db.example:5433/a%25b');
  });

  it.each(Object.keys(parts))('throws when %s is missing', (name) => {
    vi.stubEnv(name, '');
    expect(() => resolveDatabaseUrl()).toThrow(`Missing environment variable: ${name}`);
  });
});
