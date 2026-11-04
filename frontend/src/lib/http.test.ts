import { afterEach, expect, it, vi } from 'vitest'
import { request } from './http'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

function stubFetch(impl: () => Promise<Response>) {
  const fetchMock = vi.fn(impl)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

it('prefixes the path with /api and sends a JSON content type', async () => {
  const fetchMock = stubFetch(async () => jsonResponse([{ id: 1 }]))
  await expect(request('/todos')).resolves.toEqual([{ id: 1 }])
  expect(fetchMock).toHaveBeenCalledWith('/api/todos', {
    headers: { 'Content-Type': 'application/json' },
  })
})

it('lets the caller override headers and passes other options', async () => {
  const fetchMock = stubFetch(async () => jsonResponse({}))
  await request('/todos', {
    method: 'POST',
    body: '{}',
    headers: { 'Content-Type': 'text/plain', 'X-Test': '1' },
  })
  expect(fetchMock).toHaveBeenCalledWith('/api/todos', {
    method: 'POST',
    body: '{}',
    headers: { 'Content-Type': 'text/plain', 'X-Test': '1' },
  })
})

it('returns undefined for a 204 response', async () => {
  stubFetch(async () => new Response(null, { status: 204 }))
  await expect(
    request('/todos/1', { method: 'DELETE' }),
  ).resolves.toBeUndefined()
})

it('shows a connection message when the network fails', async () => {
  stubFetch(async () => {
    throw new TypeError('Failed to fetch')
  })
  await expect(request('/todos')).rejects.toThrow(
    'Cannot connect to the server. Please try again.',
  )
})

it('rethrows the original error when the request was aborted', async () => {
  const controller = new AbortController()
  controller.abort()
  const abortError = new Error('aborted')
  stubFetch(async () => {
    throw abortError
  })
  await expect(request('/todos', { signal: controller.signal })).rejects.toBe(
    abortError,
  )
})

it('shows a validation message for a 422 response', async () => {
  stubFetch(async () => jsonResponse({ detail: 'ignored' }, 422))
  await expect(request('/todos')).rejects.toThrow(/Check the task details/)
})

it('uses the detail text from an error response', async () => {
  stubFetch(async () => jsonResponse({ detail: 'Task not found' }, 404))
  await expect(request('/todos/9')).rejects.toThrow('Task not found')
})

it('uses a generic message when the error body has no text detail', async () => {
  stubFetch(async () => jsonResponse({ detail: 42 }, 500))
  await expect(request('/todos')).rejects.toThrow(
    'The operation failed. Please try again.',
  )
})

it('uses a generic message when the error body is not JSON', async () => {
  stubFetch(async () => new Response('oops', { status: 502 }))
  await expect(request('/todos')).rejects.toThrow(
    'The operation failed. Please try again.',
  )
})
