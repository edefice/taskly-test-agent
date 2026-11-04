---
name: backend-unit-tests
description: How to write unit tests for the Express and Prisma backend in backend/, using Vitest and Supertest with no database. Use when a backend source file needs new or changed tests.
---

# Backend unit tests

Test what an API client can observe: status codes, response bodies, and what reaches the repository or the database layer. No test may need PostgreSQL or a network connection.

## When to use

When `backend/src/**` has a change that needs tests. If the change has no behavior to check, `pr-change-analysis` tells you to stop before this skill.

## Steps

1. Read the source file and its existing test in `backend/tests/`.
2. List the behaviors the change adds or alters, including errors and rejected input.
3. Add tests to the existing file. If there is none, create `backend/tests/<name>.test.ts`.
4. Reuse `record` and `todo` from `backend/tests/fixture.ts`.
5. Verify with the `test-verification` skill.

## Conventions

- Test files are `backend/tests/*.test.ts` and are the only files Vitest includes.
- Import source files with the `.ts` extension: `'../src/features/todos/router.ts'`.
- Import from `vitest` explicitly. The backend has no test globals.
- Semicolons and single quotes. The backend has no formatter, so match the file you are in.
- Restore spies with `afterEach(() => vi.restoreAllMocks())` when you use `vi.spyOn`.

## Choosing the level

| Code under test | How to test it |
|---|---|
| A route | Mount the router on a real Express app with a fake repository, and call it with Supertest. |
| A repository | Build the real Prisma client with a fake URL and spy on its delegate. |
| A validator or mapper | Call the function directly. These two files have a 100% coverage threshold per file. |
| `createApp` | Pass a fake `Database` and call it with Supertest. |
| Code with a time limit, a port or process signals | See "Timers and the process lifecycle" below. |

## Examples from this repository

A route test uses a fake repository, so no database is needed (`backend/tests/router.test.ts`):

```ts
function setup() {
  const repository = { list: vi.fn().mockResolvedValue([todo]), create: vi.fn().mockResolvedValue(todo), get: vi.fn(), update: vi.fn(), delete: vi.fn() };
  const app = express();
  app.use(express.json());
  app.use('/api/todos', createTodosRouter(repository));
  return { app, repository };
}
```

Rejected input must fail and must not reach the repository (`backend/tests/router.test.ts`):

```ts
    expect((await request(app).post('/api/todos').send(payload)).status).toBe(422);
    expect(repository.create).not.toHaveBeenCalled();
```

A repository test uses the real Prisma client and mocks only its IO (`backend/tests/repository.test.ts`):

```ts
  const database = createDatabase('postgresql://test:test@localhost:5432/test');
  return { database, repository: new TodoRepository(database) };
```

```ts
  const findMany = vi.spyOn(database.todo, 'findMany').mockResolvedValue([record]);
  expect(await repository.list()).toEqual([todo]);
  expect(findMany).toHaveBeenCalledWith({ orderBy: [{ created_at: 'desc' }, { id: 'desc' }] });
```

## Timers and the process lifecycle

A test must not wait for real time, end the test process, depend on a free fixed port, or leave a listener behind.

| Code under test uses | In the test |
|---|---|
| A time limit | `vi.useFakeTimers()`. Check just before the limit and at the limit. Use `await vi.advanceTimersByTimeAsync(...)` when the code also waits for a promise. |
| `process.exit` | Replace it with `vi.spyOn(process, 'exit')`, and check the exit code. |
| A port from the environment | `vi.stubEnv` with port `0`, so the system picks a free one. A local listener is fine. Close it in the test. |
| Process signals | Call `process.emit('SIGTERM')`. Never use `process.kill`. In `afterEach`, remove only the listeners the test added, because the test runner can have its own. |

The module in this example is made up. It does not exist in this repository, so read the real file and test what it does. For this module:

```ts
import type { Express } from 'express';
import type { Server } from 'node:http';

export function listenOnExamplePort(app: Express): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(Number(process.env.EXAMPLE_PORT || 9000), '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

export function stopOnSignal(stop: () => Promise<void>) {
  process.once('SIGTERM', () => {
    const limit = setTimeout(() => process.exit(1), 5000);
    limit.unref();
    void stop().then(() => clearTimeout(limit));
  });
}
```

the test looks like this:

```ts
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { listenOnExamplePort, stopOnSignal } from '../src/example.ts';

const runnerListeners = process.listeners('SIGTERM');

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const listener of process.listeners('SIGTERM')) {
    if (!runnerListeners.includes(listener)) process.removeListener('SIGTERM', listener);
  }
});

const mockExit = () => vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

it('exits with an error when stopping takes too long', () => {
  vi.useFakeTimers();
  const exit = mockExit();
  stopOnSignal(() => new Promise(() => {}));
  process.emit('SIGTERM');
  vi.advanceTimersByTime(4999);
  expect(exit).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(exit).toHaveBeenCalledWith(1);
});

it('does not exit when stopping finishes in time', async () => {
  vi.useFakeTimers();
  const exit = mockExit();
  stopOnSignal(() => Promise.resolve());
  process.emit('SIGTERM');
  await vi.advanceTimersByTimeAsync(5000);
  expect(exit).not.toHaveBeenCalled();
});

it('listens on the port from the environment', async () => {
  vi.stubEnv('EXAMPLE_PORT', '0');
  const server = await listenOnExamplePort(express());
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  expect(port).not.toBe(9000);
});
```

## What to cover

- The success path, with the exact status code and body.
- Each validation rule, at the limit and just past it. Titles allow 120 characters, so test 120 and 121.
- Each error path: not found, invalid JSON, a repository that rejects.
- Defaults and trimming that the route applies before calling the repository.

## Quality checklist

- [ ] No test connects to a database or the network. `createDatabase` with the fake URL is fine, because it connects only when a query runs, and you mock the query.
- [ ] Nothing waits for real time, uses a fixed port, ends the test process or leaves a signal listener behind.
- [ ] Each test asserts on the response or on what reached the repository, not on private helpers.
- [ ] A rejected request also asserts that the repository was not called.
- [ ] You can describe each test in one sentence about behavior.
- [ ] You did not write an assertion that makes a bug listed in `CLAUDE.md` look correct.
