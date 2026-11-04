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

## What to cover

- The success path, with the exact status code and body.
- Each validation rule, at the limit and just past it. Titles allow 120 characters, so test 120 and 121.
- Each error path: not found, invalid JSON, a repository that rejects.
- Defaults and trimming that the route applies before calling the repository.

## Quality checklist

- [ ] No test connects to a database or the network. `createDatabase` with the fake URL is fine, because it connects only when a query runs, and you mock the query.
- [ ] Each test asserts on the response or on what reached the repository, not on private helpers.
- [ ] A rejected request also asserts that the repository was not called.
- [ ] You can describe each test in one sentence about behavior.
- [ ] You did not write an assertion that makes a bug listed in `CLAUDE.md` look correct.
