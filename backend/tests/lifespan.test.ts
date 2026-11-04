import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createDatabase: vi.fn(),
  initialize: vi.fn(),
  resolveDatabaseUrl: vi.fn(),
  createApp: vi.fn(),
}));

vi.mock('../src/core/database.ts', () => ({ createDatabase: mocks.createDatabase, initialize: mocks.initialize }));
vi.mock('../src/core/config.ts', () => ({ resolveDatabaseUrl: mocks.resolveDatabaseUrl }));
vi.mock('../src/factory.ts', () => ({ createApp: mocks.createApp }));

import { start } from '../src/core/lifespan.ts';

const signals = ['SIGTERM', 'SIGINT'] as const;
const runnerListeners = Object.fromEntries(signals.map((s) => [s, process.listeners(s)]));
const originalExitCode = process.exitCode;

function setup(port = 4321) {
  const database = { $connect: vi.fn().mockResolvedValue(undefined), $disconnect: vi.fn().mockResolvedValue(undefined) };
  const server = {
    address: vi.fn().mockReturnValue({ port }),
    close: vi.fn(),
    once: vi.fn(),
  };
  const listen = vi.fn((_port: number, _host: string, callback: () => void) => {
    void Promise.resolve().then(callback);
    return server;
  });
  mocks.createDatabase.mockReturnValue(database);
  mocks.createApp.mockReturnValue({ listen });
  return { database, server, listen };
}

const mockExit = () => vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

beforeEach(() => {
  mocks.initialize.mockResolvedValue(undefined);
  mocks.resolveDatabaseUrl.mockReturnValue('postgresql://test:test@localhost:5432/test');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  process.exitCode = originalExitCode;
  for (const signal of signals) {
    for (const listener of process.listeners(signal)) {
      if (!runnerListeners[signal].includes(listener)) process.removeListener(signal, listener);
    }
  }
});

describe('start', () => {
  it('connects, initializes, listens and returns the server and database', async () => {
    const { database, server, listen } = setup();
    const result = await start();
    expect(mocks.createDatabase).toHaveBeenCalledWith('postgresql://test:test@localhost:5432/test');
    expect(database.$connect).toHaveBeenCalledOnce();
    expect(mocks.initialize).toHaveBeenCalledWith(database);
    expect(mocks.createApp).toHaveBeenCalledWith(database);
    expect(listen).toHaveBeenCalledWith(8000, '0.0.0.0', expect.any(Function));
    expect(result).toEqual({ server, database });
    expect(console.log).toHaveBeenCalledWith('Taskly App Node API listening on port 4321');
  });

  it('uses the port from API_PORT', async () => {
    vi.stubEnv('API_PORT', '9123');
    const { listen } = setup();
    await start();
    expect(listen).toHaveBeenCalledWith(9123, '0.0.0.0', expect.any(Function));
  });

  it('disconnects and rethrows when initialization fails', async () => {
    const { database, listen } = setup();
    mocks.initialize.mockRejectedValue(new Error('init failed'));
    await expect(start()).rejects.toThrow('init failed');
    expect(database.$disconnect).toHaveBeenCalledOnce();
    expect(listen).not.toHaveBeenCalled();
  });

  it('does not register signal handlers when startup fails', async () => {
    const { database } = setup();
    database.$connect.mockRejectedValue(new Error('no database'));
    await expect(start()).rejects.toThrow('no database');
    for (const signal of signals) {
      expect(process.listeners(signal)).toEqual(runnerListeners[signal]);
    }
  });
});

describe('shutdown', () => {
  it.each(signals)('%s closes the server and disconnects the database', async (signal) => {
    const { database, server } = setup();
    server.close.mockImplementation((callback: () => Promise<void>) => callback());
    await start();
    process.emit(signal);
    expect(server.close).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(database.$disconnect).toHaveBeenCalledOnce());
  });

  it('exits with code 1 at 10 seconds when the server does not finish closing', async () => {
    const { server } = setup();
    await start();
    vi.useFakeTimers();
    const exit = mockExit();
    process.emit('SIGTERM');
    expect(server.close).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(9999);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('cancels the time limit when the server closes in time', async () => {
    const { database, server } = setup();
    let finishClose: () => Promise<void> = async () => undefined;
    server.close.mockImplementation((callback: () => Promise<void>) => {
      finishClose = callback;
    });
    await start();
    vi.useFakeTimers();
    const exit = mockExit();
    process.emit('SIGTERM');
    await finishClose();
    expect(database.$disconnect).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(20000);
    expect(exit).not.toHaveBeenCalled();
  });

  it('logs a disconnect failure and sets the exit code to 1', async () => {
    const { database, server } = setup();
    const failure = new Error('disconnect failed');
    database.$disconnect.mockRejectedValue(failure);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let finishClose: () => Promise<void> = async () => undefined;
    server.close.mockImplementation((callback: () => Promise<void>) => {
      finishClose = callback;
    });
    await start();
    process.exitCode = undefined;
    process.emit('SIGINT');
    await finishClose();
    expect(error).toHaveBeenCalledWith(failure);
    expect(process.exitCode).toBe(1);
  });
});
