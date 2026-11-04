import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findSecret, scanPaths, secretNeedles } from './scan-secret.mjs';

const SCRIPT = fileURLToPath(new URL('./scan-secret.mjs', import.meta.url));
// Made up, in the shape of a real key, built in parts so that no scanner takes this file for a leak.
const SECRET = ['sk', 'ant', 'test', 'Ab3-De6_Gh9Jk2Mn5Pq8St1Vw4Yz7'].join('-');
const needles = secretNeedles(SECRET);
const found = (text) => findSecret(Buffer.from(text), needles);

describe('findSecret', () => {
  it('finds the plain value anywhere', () => {
    assert.equal(found(SECRET), 'plain text');
    assert.equal(found(`const key = "${SECRET}";\n`), 'plain text');
  });

  it('finds hex, in lower and upper case', () => {
    assert.equal(found(`x${Buffer.from(SECRET).toString('hex')}y`), 'hex');
    assert.equal(found(`x${Buffer.from(SECRET).toString('hex').toUpperCase()}y`), 'hex');
  });

  it('finds base64 of the value alone', () => {
    assert.equal(found(Buffer.from(SECRET).toString('base64')), 'base64');
  });

  for (const prefix of ['', 'a', 'ab', 'abc', 'abcd', 'abcde']) {
    for (const suffix of ['', 'x', 'xy', 'xyz', 'wxyz']) {
      it(`finds base64 of the value between ${JSON.stringify(prefix)} and ${JSON.stringify(suffix)}`, () => {
        assert.equal(found(Buffer.from(`${prefix}${SECRET}${suffix}`).toString('base64')), 'base64');
      });
    }
  }

  it('finds url-safe base64', () => {
    // Bytes that encode to + and /, so that the two alphabets differ.
    const secret = `ûÿþ${SECRET}`;
    const encoded = Buffer.from(secret).toString('base64url');
    assert.notEqual(encoded, Buffer.from(secret).toString('base64'));
    assert.equal(findSecret(Buffer.from(encoded), secretNeedles(secret)), 'base64');
  });

  it('finds base64 with line breaks, as a tool wraps it', () => {
    const wrapped = Buffer.from(SECRET).toString('base64').replace(/(.{10})/g, '$1\n');
    assert.ok(wrapped.includes('\n'));
    assert.equal(found(wrapped), 'base64');
  });

  it('finds a value split by an escaped line break in JSON', () => {
    assert.equal(found(JSON.stringify(`${SECRET.slice(0, 9)}\n${SECRET.slice(9)}`)), 'plain text');
  });

  it('reads a value in binary data', () => {
    assert.equal(findSecret(Buffer.concat([Buffer.from([0, 255, 254]), Buffer.from(SECRET), Buffer.from([0])]), needles), 'plain text');
  });

  it('finds nothing in text without the value', () => {
    assert.equal(found('const key = "sk-ant-placeholder";\nexpect(a).toBe(1)\n'), null);
    assert.equal(found(Buffer.from('some other text').toString('base64')), null);
  });

  it('does not take most of the value for the value', () => {
    assert.equal(found(SECRET.slice(0, -1)), null);
    assert.equal(found(SECRET.slice(1)), null);
  });

  it('takes a string as well as a buffer', () => {
    assert.equal(findSecret(SECRET, needles), 'plain text');
  });
});

describe('scanPaths', () => {
  let root;
  let dir;

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'scan-secret-')));
  });
  after(() => rmSync(root, { recursive: true, force: true }));
  beforeEach(() => {
    dir = mkdtempSync(join(root, 'run-'));
  });

  it('finds nothing in a clean run', () => {
    writeFileSync(join(dir, 'patch.diff'), '+expect(a).toBe(1)\n');
    assert.deepEqual(scanPaths([dir], SECRET), []);
  });

  for (const name of ['agent.patch', 'result.json', 'transcript.json']) {
    it(`finds the value in ${name}`, () => {
      writeFileSync(join(dir, 'other.txt'), 'clean');
      writeFileSync(join(dir, name), `before ${SECRET} after`);
      assert.deepEqual(scanPaths([dir], SECRET), [{ path: join(dir, name), kind: 'plain text' }]);
    });
  }

  it('looks in subdirectories', () => {
    mkdirSync(join(dir, 'a/b'), { recursive: true });
    writeFileSync(join(dir, 'a/b/deep.txt'), Buffer.from(SECRET).toString('base64'));
    assert.deepEqual(scanPaths([dir], SECRET), [{ path: join(dir, 'a/b/deep.txt'), kind: 'base64' }]);
  });

  it('looks in a file given by name', () => {
    writeFileSync(join(dir, 'one.txt'), SECRET);
    assert.equal(scanPaths([join(dir, 'one.txt')], SECRET).length, 1);
  });

  it('looks at file names too', () => {
    writeFileSync(join(dir, `${SECRET}.txt`), 'clean');
    assert.equal(scanPaths([dir], SECRET).length, 1);
  });

  it('reports every file, so the log shows the whole problem', () => {
    writeFileSync(join(dir, 'a.txt'), SECRET);
    writeFileSync(join(dir, 'b.txt'), SECRET);
    assert.equal(scanPaths([dir], SECRET).length, 2);
  });

  it('stops at a symbolic link and does not follow it', () => {
    symlinkSync('/etc/hosts', join(dir, 'link'));
    assert.deepEqual(scanPaths([dir], SECRET), [{ path: join(dir, 'link'), kind: 'a symbolic link' }]);
  });

  it('fails when a path is missing, because a missing file proves nothing', () => {
    assert.throws(() => scanPaths([join(dir, 'none')], SECRET), /ENOENT/);
  });

  for (const secret of ['', undefined, null]) {
    it(`fails with ${JSON.stringify(secret)} as the value, because it would find nothing and look clean`, () => {
      writeFileSync(join(dir, 'a.txt'), 'x');
      assert.throws(() => scanPaths([dir], secret), /no value/);
    });
  }
});

describe('scan-secret command line', () => {
  let dir;
  const { ANTHROPIC_API_KEY: _ignored, ...cleanEnv } = process.env;
  const run = (args, key = SECRET) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...cleanEnv, ...(key === null ? {} : { ANTHROPIC_API_KEY: key }) } });

  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'scan-secret-cli-')));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('exits 0 on clean output', () => {
    const clean = join(dir, 'clean.txt');
    writeFileSync(clean, 'clean');
    const result = run([clean]);
    assert.equal(result.status, 0, result.stderr);
  });

  it('exits 1 on a hit, and names the file and the encoding, never the value', () => {
    const leak = join(dir, 'leak.txt');
    writeFileSync(leak, SECRET);
    const result = run([leak]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /stopped by .*leak\.txt: plain text/);
    assert.ok(!result.stdout.includes(SECRET));
    assert.ok(!result.stderr.includes(SECRET));
  });

  it('does not print the value when the file name holds it', () => {
    const named = join(dir, `${SECRET}.txt`);
    writeFileSync(named, 'x');
    const result = run([named]);
    assert.equal(result.status, 1);
    assert.ok(!result.stdout.includes(SECRET));
    assert.ok(!result.stderr.includes(SECRET));
    assert.match(result.stderr, /a path that holds the value/);
  });

  it('exits 2 with no key in the environment', () => {
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'x');
    const result = run([file], null);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /could not scan/);
  });

  it('exits 2 with an empty key', () => {
    const file = join(dir, 'b.txt');
    writeFileSync(file, 'x');
    assert.equal(run([file], '').status, 2);
  });

  it('says in a step output which of the three it was', () => {
    const output = (args, key) => {
      const file = join(dir, `output-${Math.random()}`);
      spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...cleanEnv, GITHUB_OUTPUT: file, ANTHROPIC_API_KEY: key } });
      return readFileSync(file, 'utf8').split('\n')[1];
    };
    const clean = join(dir, 'output-clean.txt');
    writeFileSync(clean, 'clean');
    const leak = join(dir, 'output-leak.txt');
    writeFileSync(leak, SECRET);
    assert.equal(output([clean], SECRET), 'clean');
    assert.equal(output([leak], SECRET), 'found');
    assert.equal(output([join(dir, 'none')], SECRET), 'error');
  });

  it('exits 2 with no path', () => {
    assert.equal(run([]).status, 2);
  });

  it('exits 2 on a path it cannot read', () => {
    assert.equal(run([join(dir, 'none')]).status, 2);
  });
});
