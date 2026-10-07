import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Covers the LMU tape end to end: the recorder's synthetic fixture, the
 * inspector, and playback through the replay addon.
 *
 * The replay addon is the production lmu_node.cc compiled against a
 * tape-backed source, so these also exercise the real snapshot-to-JS
 * conversion -- which is the whole reason the tape stores raw struct bytes
 * rather than already-mapped objects.
 *
 * Windows only: both artefacts are built from a gyp target that is gated on
 * OS=='win', and the struct they read is the sim's shared-memory layout.
 */

const release = path.resolve(process.cwd(), 'build', 'Release');
const exePath = path.join(release, 'lmu_replay.exe');
const addonPath = path.join(release, 'lmu_tape_node.node');
const built = fs.existsSync(exePath) && fs.existsSync(addonPath);

const describeIfBuilt = built ? describe : describe.skip;
const execFileAsync = promisify(execFile);

let workDir: string | undefined;
const tapeFor = (name: string) => {
  workDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'lmu-tape-'));
  return path.join(workDir, `${name}.lmudt`);
};

const writeFixture = (tape: string, frames: number) =>
  execFileSync(
    exePath,
    ['fixture', '--output', tape, '--frames', String(frames)],
    { encoding: 'utf8' }
  );

interface TapeSdk {
  start(): boolean;
  stop(): boolean;
  isRunning(): boolean;
  read(): Record<string, unknown>;
  readSession(): Record<string, unknown>;
}

/**
 * Builds one addon instance. Each owns its own tape reader, so instances are
 * independent; the environment is read when `start()` opens that reader, which
 * is why it is set here rather than once for the file.
 */
const openTape = (tape: string, speed = '100', loop = '0'): TapeSdk => {
  process.env.IRDASHIES_LMU_REPLAY = tape;
  process.env.IRDASHIES_LMU_REPLAY_SPEED = speed;
  process.env.IRDASHIES_LMU_REPLAY_LOOP = loop;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const module_ = require(addonPath) as {
    LmuSdkNode: new () => TapeSdk;
  };
  return new module_.LmuSdkNode();
};

afterAll(() => {
  delete process.env.IRDASHIES_LMU_REPLAY;
  delete process.env.IRDASHIES_LMU_REPLAY_SPEED;
  delete process.env.IRDASHIES_LMU_REPLAY_LOOP;
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

describeIfBuilt('lmu_replay tape', () => {
  it('records a tape far smaller than the frames it holds', () => {
    // A snapshot is 324,820 bytes and the sim publishes at 100 Hz, so storing
    // frames verbatim would cost ~31 MB a second. The run-length coding is
    // what makes a raw-struct tape viable at all.
    const tape = tapeFor('sized');
    writeFixture(tape, 600);

    const bytes = fs.statSync(tape).size;
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(600 * 324820 * 0.01);
  });

  it('reports what the tape holds', () => {
    const tape = tapeFor('inspected');
    writeFixture(tape, 300);

    const report = execFileSync(exePath, ['inspect', '--input', tape], {
      encoding: 'utf8',
    });

    expect(report).toContain('Snapshot size:   324820 bytes');
    // 300 snapshots, the End record, and the REST responses the fixture
    // interleaves -- the count is not just the frame count.
    expect(report).toMatch(/Records: *30[0-9]/);
    // One keyframe at the start, then one per interval.
    expect(report).toMatch(/Keyframes: *[1-9]/);
    expect(report).toMatch(/Deltas: *[1-9]/);
    // REST responses ride in the same tape, and the inspector names the paths
    // so a recording can be checked for what it actually captured.
    expect(report).toMatch(/REST records: *[1-9]/);
    expect(report).toContain('/rest/strategy/pitstop-estimate');
    expect(report).toContain('/rest/garage/UIScreen/RepairAndRefuel');
  });

  it('refuses a file that is not a tape', () => {
    const notATape = tapeFor('bogus');
    fs.writeFileSync(notATape, 'definitely not a tape');

    expect(() =>
      execFileSync(exePath, ['inspect', '--input', notATape], {
        encoding: 'utf8',
        stdio: 'pipe',
      })
    ).toThrow();
  });

  it('plays back through the real snapshot conversion', () => {
    const tape = tapeFor('played');
    writeFixture(tape, 400);
    const sdk = openTape(tape);

    expect(sdk.start()).toBe(true);
    expect(sdk.isRunning()).toBe(true);

    let frames = 0;
    let latest: Record<string, unknown> | undefined;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && frames < 40) {
      const frame = sdk.read();
      if (frame?.running) {
        frames += 1;
        latest = frame;
      }
    }
    sdk.stop();

    expect(frames).toBeGreaterThan(0);
    // The player half of the frame is only populated when the addon finds a
    // player car, so these prove the conversion ran, not just that bytes moved.
    expect(latest?.playerHasVehicle).toBe(true);
    expect(latest?.trackName).toBe('Synthetic Circuit');
    expect(latest?.gear).toBe(4);
    expect(latest?.fuelCapacity).toBe(110);
    expect(latest?.numVehicles).toBe(2);
  });

  it('advances the recorded clock as it plays', () => {
    const tape = tapeFor('clock');
    writeFixture(tape, 400);
    const sdk = openTape(tape);
    sdk.start();

    const times: number[] = [];
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && times.length < 20) {
      const frame = sdk.read();
      if (frame?.running) times.push(frame.elapsedTime as number);
    }
    sdk.stop();

    expect(times.length).toBeGreaterThan(1);
    expect(times[times.length - 1]).toBeGreaterThan(times[0]);
  });

  it('serves a session snapshot with its drivers and classes', () => {
    const tape = tapeFor('session');
    writeFixture(tape, 200);
    const sdk = openTape(tape);
    sdk.start();
    // Let at least one frame land so the reader holds a snapshot.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !sdk.read()?.running) {
      /* wait for the first frame */
    }

    const session = sdk.readSession();
    sdk.stop();

    expect(session.trackName).toBe('Synthetic Circuit');
    expect((session.drivers as unknown[])?.length).toBe(2);
  });
  /**
   * Auto-detection builds a probe to answer "is LMU running?" while the bridge
   * builds its own reader once a sim is chosen, so two instances are routinely
   * alive at once. While the source state was file-scope, releasing either one
   * detached the other: the live addon lost its shared-memory view when V8
   * collected the discarded probe, and the bridge reported LMU gone one
   * disconnect grace period later.
   */
  it('keeps an instance attached when another one is released', () => {
    const tape = tapeFor('isolation');
    writeFixture(tape, 300);
    // Looping, so the tape cannot run out and turn an exhausted reader into a
    // false positive for the detachment this is actually checking.
    const probe = openTape(tape, '100', '1');
    const bridge = openTape(tape, '100', '1');
    expect(probe.start()).toBe(true);
    expect(bridge.start()).toBe(true);

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !bridge.read()?.running) {
      /* wait for the first frame */
    }
    expect(bridge.read().running).toBe(true);

    probe.stop();
    expect(bridge.read().running).toBe(true);

    bridge.stop();
  });
});

describeIfBuilt('lmu_replay live REST capture', () => {
  /**
   * Records against a stub standing in for LMU's REST API.
   *
   * On an ephemeral port via --rest-port, so this never contends for 6397 and
   * never depends on the sim being installed. Shared memory is absent, so the
   * tape is REST records only -- which is exactly the half under test.
   */
  const withStubApi = async (
    handler: http.RequestListener,
    args: string[]
  ): Promise<string> => {
    // execFile, not execFileSync: the stub runs in this process, and a
    // synchronous child would block the event loop so the server could never
    // accept the recorder's connections. Every request would time out and the
    // tape would come back empty for the wrong reason.
    const server = http.createServer(handler);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const { port } = server.address() as AddressInfo;
    const tape = tapeFor(`live-${port}`);
    try {
      await execFileAsync(
        exePath,
        [
          'record',
          '--output',
          tape,
          '--duration',
          '1',
          '--rest-host',
          '127.0.0.1',
          '--rest-port',
          String(port),
          '--rest-interval',
          '50',
          ...args,
        ],
        { encoding: 'utf8', timeout: 30_000 }
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    return tape;
  };

  const json =
    (body: unknown): http.RequestListener =>
    (_, res) => {
      const text = JSON.stringify(body);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(text),
      });
      res.end(text);
    };

  it('records REST responses alongside shared memory', async () => {
    const tape = await withStubApi(json({ total: 30, damage: 12 }), []);

    const report = execFileSync(exePath, ['inspect', '--input', tape], {
      encoding: 'utf8',
    });

    expect(report).toMatch(/REST records: *[1-9]/);
    expect(report).toContain('/rest/strategy/pitstop-estimate');
  });

  it('stores a changed body but not an unchanged one', async () => {
    // At a 50 ms poll over four paths most responses repeat, and storing them
    // all would bloat a tape for nothing.
    let tick = 0;
    const changing = await withStubApi((req, res) => {
      tick += 1;
      const text = JSON.stringify(
        req.url === '/rest/strategy/pitstop-estimate'
          ? { total: 30 + tick }
          : { total: 30 }
      );
      res.writeHead(200, { 'Content-Length': Buffer.byteLength(text) });
      res.end(text);
    }, []);

    const report = execFileSync(exePath, ['inspect', '--input', changing], {
      encoding: 'utf8',
    });
    const count = Number(/REST records: *(\d+)/.exec(report)?.[1] ?? 0);

    // The changing path contributes many; the three static ones contribute
    // one apiece rather than one per poll.
    expect(count).toBeGreaterThan(3);
    expect(count).toBeLessThan(60);
  });

  it('records nothing from REST with --no-rest', async () => {
    const tape = await withStubApi(json({ total: 30 }), ['--no-rest']);

    const report = execFileSync(exePath, ['inspect', '--input', tape], {
      encoding: 'utf8',
    });

    expect(report).toMatch(/REST records: *0 /);
  });

  it('finishes the tape even though nothing answers the port', async () => {
    // The capture thread used to outlive the loop on a --duration exit, so
    // join blocked and the tape was never finished -- a zero-byte file.
    const tape = tapeFor('no-api');
    execFileSync(
      exePath,
      [
        'record',
        '--output',
        tape,
        '--duration',
        '1',
        '--rest-port',
        // Nothing listening here.
        '6399',
      ],
      { encoding: 'utf8', timeout: 30_000 }
    );

    expect(fs.statSync(tape).size).toBeGreaterThan(0);
    const report = execFileSync(exePath, ['inspect', '--input', tape], {
      encoding: 'utf8',
    });
    expect(report).toMatch(/REST records: *0 /);
  });
});

/**
 * Covers `anonymise`, which rewrites a tape with every driver name replaced.
 *
 * The fixture carries "Synthetic Player" and "Synthetic Rival", plus the
 * player name, the .PLR filename and the server name -- so a tape built from
 * it holds one of everything the tool is meant to scrub.
 */
describeIfBuilt('lmu_replay anonymise', () => {
  const namesFileFor = (name: string, contents: string) => {
    const file = path.join(path.dirname(tapeFor(name)), `${name}.txt`);
    fs.writeFileSync(file, contents);
    return file;
  };

  const anonymise = (
    source: string,
    names: string,
    output: string
  ): { status: number; output: string } => {
    try {
      return {
        status: 0,
        output: execFileSync(
          exePath,
          [
            'anonymise',
            '--input',
            source,
            '--output',
            output,
            '--names',
            names,
          ],
          { encoding: 'utf8' }
        ),
      };
    } catch (error) {
      const failure = error as { status?: number; stderr?: string };
      return { status: failure.status ?? 1, output: failure.stderr ?? '' };
    }
  };

  /** A tape with names in it, plus a names file, ready to anonymise. */
  const scenario = (
    name: string,
    pool = 'Lewis Hamilton\nFernando Alonso\n'
  ) => {
    const source = tapeFor(`${name}-source`);
    writeFixture(source, 120);
    return {
      source,
      names: namesFileFor(name, pool),
      output: tapeFor(`${name}-anon`),
    };
  };

  /**
   * Replays in a child process, with the tape path in the environment the
   * process starts with.
   *
   * openTape cannot be used here. It assigns process.env and the addon reads
   * the variable through the CRT, which on Windows does not see a write made
   * after the process started -- so an instance built later in the run replays
   * whichever tape the process saw first. Every other test in this file opens
   * one tape and asserts things true of any fixture, so none of them notices;
   * this one is the only place two tapes differ, so it is the only place that
   * does.
   */
  const replayedSession = (tape: string) => {
    const script = [
      'const { LmuSdkNode } = require(process.argv[1]);',
      'const sdk = new LmuSdkNode();',
      'sdk.start();',
      'const deadline = Date.now() + 5000;',
      'while (Date.now() < deadline && !sdk.read()?.running) {}',
      'const session = sdk.readSession();',
      'sdk.stop();',
      'process.stdout.write(JSON.stringify(session));',
    ].join(' ');
    const out = execFileSync(process.execPath, ['-e', script, addonPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        IRDASHIES_LMU_REPLAY: tape,
        IRDASHIES_LMU_REPLAY_SPEED: '100',
        IRDASHIES_LMU_REPLAY_LOOP: '0',
      },
    });
    return JSON.parse(out) as {
      running?: boolean;
      playerName?: string;
      serverName?: string;
      drivers?: { name: string; isPlayer: boolean }[];
    };
  };

  it('replaces every driver name with one from the file', () => {
    const { source, names, output } = scenario('replaces');

    const result = anonymise(source, names, output);

    expect(result.status).toBe(0);
    expect(result.output).toMatch(/Synthetic Player -> Lewis Hamilton/);
    expect(result.output).toMatch(/Synthetic Rival -> Fernando Alonso/);

    const session = replayedSession(output);

    expect(session.running).toBe(true);
    expect(session.drivers?.map((driver) => driver.name)).toEqual([
      'Lewis Hamilton',
      'Fernando Alonso',
    ]);
    // The coherence that matters: the sim carries the same string in
    // mPlayerName and in the player's own scoring entry, so they must still
    // agree after the rewrite.
    expect(session.playerName).toBe('Lewis Hamilton');
    expect(session.drivers?.[0].isPlayer).toBe(true);
    expect(session.serverName).toBe('SERVER');
  });

  it('leaves no original name anywhere in the file', () => {
    // The point of the whole tool. Payloads are run-length encoded, so a name
    // survives as a literal run -- a byte search is the honest check.
    const { source, names, output } = scenario('scrubbed');

    anonymise(source, names, output);

    const before = fs.readFileSync(source);
    const after = fs.readFileSync(output);
    for (const original of [
      'Synthetic Player',
      'Synthetic Rival',
      'Synthetic Player.PLR',
      'Synthetic Server',
    ]) {
      expect(before.includes(original)).toBe(true);
      expect(after.includes(original)).toBe(false);
    }
    // A track is not a person, and a tape that forgot where it was recorded
    // would be useless.
    expect(after.includes('Synthetic Circuit')).toBe(true);
  });

  it('joins a first and last name split by a comma or a tab', () => {
    const { source, names, output } = scenario(
      'joined',
      '# a pool\n\nFernando,Alonso\nKamui\tKobayashi\n'
    );

    const result = anonymise(source, names, output);

    expect(result.output).toMatch(/Synthetic Player -> Fernando Alonso/);
    expect(result.output).toMatch(/Synthetic Rival -> Kamui Kobayashi/);
  });

  it('numbers a repeat rather than giving two drivers one name', () => {
    // Two drivers reading the same name in the standings looks like a fault in
    // the app rather than a names file that ran out.
    const { source, names, output } = scenario('short', 'Solo Driver\n');

    const result = anonymise(source, names, output);

    expect(result.output).toMatch(/Synthetic Player -> Solo Driver/);
    expect(result.output).toMatch(/Synthetic Rival -> Solo Driver 2/);
  });

  it('gives the same answer every time', () => {
    // Assignment is by first appearance rather than by anything random, so an
    // anonymised tape can be reproduced and compared.
    const { source, names, output } = scenario('stable');
    const second = tapeFor('stable-again');

    anonymise(source, names, output);
    anonymise(source, names, second);

    expect(fs.readFileSync(output).equals(fs.readFileSync(second))).toBe(true);
  });

  it('carries the REST records through', () => {
    const { source, names, output } = scenario('rest');

    anonymise(source, names, output);

    const report = execFileSync(exePath, ['inspect', '--input', output], {
      encoding: 'utf8',
    });
    expect(report).not.toMatch(/REST records: *0 /);
  });

  it('refuses to write over the tape it is reading', () => {
    // The writer truncates on open, so this would destroy the only copy.
    const { source, names } = scenario('inplace');

    const result = anonymise(source, names, source);

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/--output must differ from --input/);
    expect(fs.readFileSync(source).includes('Synthetic Player')).toBe(true);
  });

  it('refuses a names file with nothing usable in it', () => {
    const { source, names, output } = scenario(
      'empty',
      '# every line a comment\n\n'
    );

    const result = anonymise(source, names, output);

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/No usable names/);
    expect(fs.existsSync(output)).toBe(false);
  });

  it('refuses a names file that is not there', () => {
    const { source, output } = scenario('missing');

    const result = anonymise(source, 'no-such-file.txt', output);

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/Failed to open names file/);
  });
});
