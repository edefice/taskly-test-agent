import { describe, expect, it, vi } from 'vitest';
import { initialize } from '../src/core/database.ts';
import type { Database } from '../src/features/todos/types.ts';

function fakeDatabase(executeRaw: ReturnType<typeof vi.fn>) {
  return { $executeRaw: executeRaw } as unknown as Database;
}

describe('initialize', () => {
  it('creates the todos table once, only if it does not exist, with its constraints', async () => {
    const executeRaw = vi.fn().mockResolvedValue(0);
    await initialize(fakeDatabase(executeRaw));
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const sql = (executeRaw.mock.calls[0][0] as string[]).join('');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS todos');
    expect(sql).toContain('todo_title_not_empty');
    expect(sql).toContain("priority IN ('low', 'medium', 'high')");
  });

  it('rejects when the database fails', async () => {
    const executeRaw = vi.fn().mockRejectedValue(new Error('connection refused'));
    await expect(initialize(fakeDatabase(executeRaw))).rejects.toThrow('connection refused');
  });
});
