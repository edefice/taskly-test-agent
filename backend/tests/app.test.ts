import request from 'supertest';
import { afterEach, expect, it, vi } from 'vitest';
import { createApp } from '../src/factory.ts';
import type { Database } from '../src/features/todos/types.ts';

function setup() {
  const findFirst = vi.fn().mockResolvedValue(null);
  const findMany = vi.fn().mockResolvedValue([]);
  const database = { todo: { findFirst, findMany } } as unknown as Database;
  return { app: createApp(database), findFirst, findMany };
}

afterEach(() => vi.restoreAllMocks());

it('returns ok on the health route when the database answers', async () => {
  const { app, findFirst } = setup();
  const response = await request(app).get('/api/health');
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ status: 'ok' });
  expect(findFirst).toHaveBeenCalledWith({ select: { id: true } });
});

it('returns 500 on the health route when the database fails', async () => {
  const { app, findFirst } = setup();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  findFirst.mockRejectedValue(new Error('down'));
  const response = await request(app).get('/api/health');
  expect(response.status).toBe(500);
  expect(response.body).toEqual({ detail: 'Internal Server Error' });
});

it('mounts the todos router under /api/todos', async () => {
  const { app, findMany } = setup();
  const response = await request(app).get('/api/todos');
  expect(response.status).toBe(200);
  expect(response.body).toEqual([]);
  expect(findMany).toHaveBeenCalled();
});

it('serves the OpenAPI specification', async () => {
  const { app } = setup();
  const response = await request(app).get('/openapi.json');
  expect(response.status).toBe(200);
  expect(response.body).toHaveProperty('openapi');
});

it('returns 404 with a detail for unknown routes', async () => {
  const { app } = setup();
  const response = await request(app).get('/nope');
  expect(response.status).toBe(404);
  expect(response.body).toEqual({ detail: 'Not Found' });
});

it('returns 422 for a malformed JSON body', async () => {
  const { app } = setup();
  const response = await request(app).post('/api/todos').set('Content-Type', 'application/json').send('{bad');
  expect(response.status).toBe(422);
  expect(response.body).toEqual({ detail: 'Invalid JSON.' });
});

it('returns 413 for a body over the size limit', async () => {
  const { app } = setup();
  const response = await request(app).post('/api/todos').send({ title: 'a'.repeat(200_000) });
  expect(response.status).toBe(413);
  expect(response.body).toEqual({ detail: 'Request body too large.' });
});

it('does not send the x-powered-by header', async () => {
  const { app } = setup();
  const response = await request(app).get('/api/health');
  expect(response.headers['x-powered-by']).toBeUndefined();
});
